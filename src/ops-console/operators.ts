import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, getTableColumns, isNull, lt, ne, or } from 'drizzle-orm';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/passwords.js';
import { generateSecret, otpauthUri, verifyTotp } from '../auth/totp.js';
import type { Clock } from '../clock.js';
import type { Db, DbOrTx } from '../db/client.js';
import { operatorAudit, operators, operatorSessions, type OperatorRole } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import type { SecretBox } from '../security/secrets.js';

export type Operator = typeof operators.$inferSelect;

export interface OperatorAuthConfig {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  maxFailedLogins: number;
  lockoutMs: number;
  touchIntervalMs: number;
}

/** Stricter than the merchant dashboard: these accounts can pause every merchant's payments. */
export const DEFAULT_OPERATOR_AUTH: OperatorAuthConfig = {
  idleTimeoutMs: 15 * 60_000,
  absoluteTimeoutMs: 8 * 3600_000,
  maxFailedLogins: 5,
  lockoutMs: 15 * 60_000,
  touchIntervalMs: 60_000,
};

export const TOTP_ISSUER = 'Merchantflo Ops';
const INVALID = 'Invalid email, password or code';
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function operatorView(o: Operator) {
  return { id: o.id, email: o.email, name: o.name, role: o.role, disabled: o.disabled, lastLoginAt: o.lastLoginAt, createdAt: o.createdAt };
}

/**
 * Merchantflo staff accounts for the ops console. Sign-in is password + TOTP every time, with
 * lockout and replay protection; sessions are opaque tokens stored as hashes. Everything an
 * operator does is written to operator_audit.
 */
export class OperatorService {
  private readonly cfg: OperatorAuthConfig;

  constructor(private readonly deps: { db: Db; clock: Clock; secrets: SecretBox; cfg?: Partial<OperatorAuthConfig> }) {
    this.cfg = { ...DEFAULT_OPERATOR_AUTH, ...deps.cfg };
  }

  get config(): OperatorAuthConfig {
    return this.cfg;
  }

  /** New operator: returns a one-time password and the authenticator enrolment URI (show once). */
  async create(input: { email: string; name: string; role: OperatorRole }, actorId: string | null): Promise<{ operator: Operator; password: string; otpauthUri: string }> {
    const { db, clock, secrets } = this.deps;
    const email = input.email.trim().toLowerCase();
    const [taken] = await db.select({ id: operators.id }).from(operators).where(eq(operators.email, email));
    if (taken) throw new AppError('CONFLICT', 'An operator with this email already exists');
    const password = randomBytes(18).toString('base64url');
    const secret = generateSecret();
    const now = clock.now();
    const passwordHash = await hashPassword(password);
    const operator = await db.transaction(async (tx) => {
      const [o] = await tx
        .insert(operators)
        .values({ id: newId('opr'), email, name: input.name, passwordHash, totpSecret: secrets.seal(secret), role: input.role, createdAt: now, updatedAt: now })
        .returning();
      await this.audit(tx, actorId, 'OPERATOR_CREATED', o!.id, { email, role: input.role });
      return o!;
    });
    return { operator, password, otpauthUri: otpauthUri({ issuer: TOTP_ISSUER, account: email, secret }) };
  }

  async login(emailInput: string, password: string, code: string): Promise<{ operator: Operator; token: string }> {
    const { db, clock, secrets } = this.deps;
    const now = clock.now();
    const email = emailInput.trim().toLowerCase();
    const [o] = await db.select().from(operators).where(eq(operators.email, email));
    if (!o) {
      await verifyPassword(password, DUMMY_HASH); // same cost as a real attempt
      throw new AppError('UNAUTHORIZED', INVALID);
    }
    if (o.lockedUntil && o.lockedUntil > now) throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts — try again later');

    const passwordOk = await verifyPassword(password, o.passwordHash);
    const step = passwordOk && !o.disabled ? verifyTotp(secrets.open<string>(o.totpSecret), code, now, o.totpLastStep) : null;
    // Claim the step atomically: of two logins racing with one code, only one succeeds.
    const claimed =
      step === null
        ? []
        : await db
            .update(operators)
            .set({ totpLastStep: step, failedLogins: 0, lockedUntil: null, lastLoginAt: now })
            .where(and(eq(operators.id, o.id), or(isNull(operators.totpLastStep), lt(operators.totpLastStep, step))))
            .returning({ id: operators.id });
    if (claimed.length === 0) {
      const failed = o.failedLogins + 1;
      const lock = failed >= this.cfg.maxFailedLogins;
      await db
        .update(operators)
        .set({ failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + this.cfg.lockoutMs) : o.lockedUntil })
        .where(eq(operators.id, o.id));
      const reason = !passwordOk ? 'bad_password' : o.disabled ? 'disabled' : 'bad_code';
      await this.audit(db, o.id, 'LOGIN_FAILED', o.id, { reason, locked: lock });
      throw new AppError('UNAUTHORIZED', INVALID);
    }

    const token = randomBytes(32).toString('base64url');
    await db.transaction(async (tx) => {
      await tx.insert(operatorSessions).values({
        id: newId('ses'),
        operatorId: o.id,
        tokenHash: hashToken(token),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + this.cfg.absoluteTimeoutMs),
      });
      await this.audit(tx, o.id, 'LOGIN_SUCCEEDED', o.id);
    });
    return { operator: o, token };
  }

  /** The operator behind a session token, or null if missing, expired, idle too long, revoked or disabled. */
  async authenticate(token: string | undefined): Promise<Operator | null> {
    if (!token) return null;
    const { db, clock } = this.deps;
    const now = clock.now();
    const [row] = await db
      .select({ session: operatorSessions, operator: operators })
      .from(operatorSessions)
      .innerJoin(operators, eq(operators.id, operatorSessions.operatorId))
      .where(and(eq(operatorSessions.tokenHash, hashToken(token)), isNull(operatorSessions.revokedAt)));
    if (!row) return null;
    const { session, operator } = row;
    if (operator.disabled || now >= session.expiresAt || now.getTime() - session.lastSeenAt.getTime() >= this.cfg.idleTimeoutMs) return null;
    if (now.getTime() - session.lastSeenAt.getTime() >= this.cfg.touchIntervalMs) {
      await db.update(operatorSessions).set({ lastSeenAt: now }).where(eq(operatorSessions.id, session.id));
    }
    return operator;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.deps.db.update(operatorSessions).set({ revokedAt: this.deps.clock.now() }).where(eq(operatorSessions.tokenHash, hashToken(token)));
  }

  /** New authenticator secret (lost phone); open sessions are ended. */
  async resetTotp(operatorId: string, actorId: string | null): Promise<{ otpauthUri: string }> {
    const { db, clock, secrets } = this.deps;
    const secret = generateSecret();
    const now = clock.now();
    const o = await db.transaction(async (tx) => {
      const [o] = await tx.update(operators).set({ totpSecret: secrets.seal(secret), totpLastStep: null, updatedAt: now }).where(eq(operators.id, operatorId)).returning();
      if (!o) throw new AppError('NOT_FOUND', `Operator ${operatorId} not found`);
      await tx.update(operatorSessions).set({ revokedAt: now }).where(and(eq(operatorSessions.operatorId, operatorId), isNull(operatorSessions.revokedAt)));
      await this.audit(tx, actorId, 'TOTP_RESET', operatorId);
      return o;
    });
    return { otpauthUri: otpauthUri({ issuer: TOTP_ISSUER, account: o.email, secret }) };
  }

  async disable(operatorId: string, actorId: string | null): Promise<void> {
    const { db, clock } = this.deps;
    const now = clock.now();
    await db.transaction(async (tx) => {
      const [o] = await tx.update(operators).set({ disabled: true, updatedAt: now }).where(eq(operators.id, operatorId)).returning({ id: operators.id });
      if (!o) throw new AppError('NOT_FOUND', `Operator ${operatorId} not found`);
      await tx.update(operatorSessions).set({ revokedAt: now }).where(and(eq(operatorSessions.operatorId, operatorId), isNull(operatorSessions.revokedAt)));
      await this.audit(tx, actorId, 'OPERATOR_DISABLED', operatorId);
    });
  }

  /** Replace the operator's password; every other session ends (the one presenting keepToken stays). */
  async changePassword(operatorId: string, current: string, next: string, keepToken?: string): Promise<void> {
    const { db, clock } = this.deps;
    const [o] = await db.select().from(operators).where(eq(operators.id, operatorId));
    if (!o) throw new AppError('NOT_FOUND', `Operator ${operatorId} not found`);
    if (!(await verifyPassword(current, o.passwordHash))) throw new AppError('UNAUTHORIZED', 'Current password is wrong');
    const passwordHash = await hashPassword(next);
    const now = clock.now();
    await db.transaction(async (tx) => {
      await tx.update(operators).set({ passwordHash, updatedAt: now }).where(eq(operators.id, operatorId));
      const others = and(eq(operatorSessions.operatorId, operatorId), isNull(operatorSessions.revokedAt));
      await tx
        .update(operatorSessions)
        .set({ revokedAt: now })
        .where(keepToken ? and(others, ne(operatorSessions.tokenHash, hashToken(keepToken))) : others);
      await this.audit(tx, operatorId, 'PASSWORD_CHANGED', operatorId);
    });
  }

  async findByEmail(email: string): Promise<Operator | undefined> {
    const [o] = await this.deps.db.select().from(operators).where(eq(operators.email, email.trim().toLowerCase()));
    return o;
  }

  /** Append an audit entry (inside the caller's transaction when given one). */
  async audit(db: DbOrTx, operatorId: string | null, action: string, target: string | null, details?: Record<string, unknown>): Promise<void> {
    await db.insert(operatorAudit).values({ id: newId('aud'), operatorId, action, target, details: details ?? null, createdAt: this.deps.clock.now() });
  }

  /** Newest first, with the acting operator's email (null for the command line or the system). */
  async listAudit(limit: number) {
    return this.deps.db
      .select({ ...getTableColumns(operatorAudit), operatorEmail: operators.email })
      .from(operatorAudit)
      .leftJoin(operators, eq(operators.id, operatorAudit.operatorId))
      .orderBy(desc(operatorAudit.seq))
      .limit(limit);
  }
}
