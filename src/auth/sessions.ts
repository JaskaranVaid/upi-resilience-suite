import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, ne, or } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { dashboardSessions, dashboardUsers } from '../db/schema.js';
import { AppError } from '../errors.js';
import { recordEvents } from '../events/record.js';
import { newId } from '../ids.js';
import type { SecretBox } from '../security/secrets.js';
import { DUMMY_HASH, verifyPassword } from './passwords.js';
import { generateSecret, otpauthUri, verifyTotp } from './totp.js';
import type { DashboardUser } from './users.js';

export interface AuthConfig {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  maxFailedLogins: number;
  lockoutMs: number;
  /** Don't write last_seen_at more often than this. */
  touchIntervalMs: number;
}

export const DEFAULT_AUTH: AuthConfig = {
  idleTimeoutMs: 30 * 60_000,
  absoluteTimeoutMs: 12 * 3600_000,
  maxFailedLogins: 5,
  lockoutMs: 15 * 60_000,
  touchIntervalMs: 60_000,
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const DASHBOARD_TOTP_ISSUER = 'Merchantflo';

/**
 * Email + password login with lockout, and opaque session tokens stored only as hashes. Users who
 * turn on two-factor sign-in also give a TOTP code, accepted once (a replayed code is refused).
 */
export class SessionService {
  private readonly cfg: AuthConfig;

  constructor(private readonly deps: { db: Db; clock: Clock; secrets: SecretBox; cfg?: Partial<AuthConfig> }) {
    this.cfg = { ...DEFAULT_AUTH, ...deps.cfg };
  }

  get config(): AuthConfig {
    return this.cfg;
  }

  async login(emailInput: string, password: string, code?: string): Promise<{ user: DashboardUser; token: string }> {
    const { db, clock, secrets } = this.deps;
    const now = clock.now();
    const email = emailInput.trim().toLowerCase();
    const [u] = await db.select().from(dashboardUsers).where(eq(dashboardUsers.email, email));
    if (!u) {
      await verifyPassword(password, DUMMY_HASH); // same cost as a real attempt
      throw new AppError('UNAUTHORIZED', 'Invalid email or password');
    }
    if (u.lockedUntil && u.lockedUntil > now) throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts — try again later');

    const fail = async (reason: string, message: string): Promise<never> => {
      const failed = u.failedLogins + 1;
      const lock = failed >= this.cfg.maxFailedLogins;
      await db
        .update(dashboardUsers)
        .set({ failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + this.cfg.lockoutMs) : u.lockedUntil })
        .where(eq(dashboardUsers.id, u.id));
      await recordEvents(db, { merchantId: u.merchantId, actor: { type: 'DASHBOARD_USER', id: u.id }, now }, [
        { type: 'LOGIN_FAILED', data: { reason, locked: lock } },
      ]);
      throw new AppError('UNAUTHORIZED', message);
    };

    const ok = await verifyPassword(password, u.passwordHash);
    if (!ok || u.disabled) await fail(u.disabled ? 'disabled' : 'bad_password', 'Invalid email or password');
    if (u.totpSecret) {
      // Asked for only after a correct password, so the question tells a guesser nothing.
      if (!code) throw new AppError('MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app');
      const step = verifyTotp(secrets.open<string>(u.totpSecret), code, now, u.totpLastStep);
      if (step === null || !(await this.claimStep(u.id, step))) await fail('bad_code', 'Invalid code');
    }

    const token = randomBytes(32).toString('base64url');
    await db.transaction(async (tx) => {
      await tx.update(dashboardUsers).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: now }).where(eq(dashboardUsers.id, u.id));
      await tx.insert(dashboardSessions).values({
        id: newId('ses'),
        userId: u.id,
        tokenHash: hashToken(token),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + this.cfg.absoluteTimeoutMs),
      });
      await recordEvents(tx, { merchantId: u.merchantId, actor: { type: 'DASHBOARD_USER', id: u.id }, now }, [{ type: 'LOGIN_SUCCEEDED' }]);
    });
    return { user: u, token };
  }

  /** The user behind a session token, or null if missing, expired, idle too long, revoked or disabled. */
  async authenticate(token: string | undefined): Promise<DashboardUser | null> {
    if (!token) return null;
    const { db, clock } = this.deps;
    const now = clock.now();
    const [row] = await db
      .select({ session: dashboardSessions, user: dashboardUsers })
      .from(dashboardSessions)
      .innerJoin(dashboardUsers, eq(dashboardUsers.id, dashboardSessions.userId))
      .where(and(eq(dashboardSessions.tokenHash, hashToken(token)), isNull(dashboardSessions.revokedAt)));
    if (!row) return null;
    const { session, user } = row;
    if (user.disabled || now >= session.expiresAt || now.getTime() - session.lastSeenAt.getTime() >= this.cfg.idleTimeoutMs) return null;
    if (now.getTime() - session.lastSeenAt.getTime() >= this.cfg.touchIntervalMs) {
      await db.update(dashboardSessions).set({ lastSeenAt: now }).where(eq(dashboardSessions.id, session.id));
    }
    return user;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.deps.db.update(dashboardSessions).set({ revokedAt: this.deps.clock.now() }).where(eq(dashboardSessions.tokenHash, hashToken(token)));
  }

  /** Start enrolling an authenticator: a new pending secret, shown once. Two-factor stays off until confirmed. */
  async beginTwoFactor(user: DashboardUser): Promise<{ secret: string; otpauthUri: string }> {
    const { db, clock, secrets } = this.deps;
    const secret = generateSecret();
    await db.update(dashboardUsers).set({ totpPendingSecret: secrets.seal(secret), updatedAt: clock.now() }).where(eq(dashboardUsers.id, user.id));
    return { secret, otpauthUri: otpauthUri({ issuer: DASHBOARD_TOTP_ISSUER, account: user.email, secret }) };
  }

  /** Turn two-factor on with a code from the pending secret. Other sessions end; keepToken's stays. */
  async confirmTwoFactor(userId: string, code: string, keepToken?: string): Promise<DashboardUser> {
    const { db, clock, secrets } = this.deps;
    const [u] = await db.select().from(dashboardUsers).where(eq(dashboardUsers.id, userId));
    if (!u?.totpPendingSecret) throw new AppError('CONFLICT', 'Start two-factor setup first');
    const now = clock.now();
    const step = verifyTotp(secrets.open<string>(u.totpPendingSecret), code, now, null);
    if (step === null) throw new AppError('UNAUTHORIZED', 'Invalid code — check the time on your phone and try again');
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(dashboardUsers)
        .set({ totpSecret: u.totpPendingSecret, totpPendingSecret: null, totpLastStep: step, updatedAt: now })
        .where(eq(dashboardUsers.id, userId))
        .returning();
      const others = and(eq(dashboardSessions.userId, userId), isNull(dashboardSessions.revokedAt));
      await tx
        .update(dashboardSessions)
        .set({ revokedAt: now })
        .where(keepToken ? and(others, ne(dashboardSessions.tokenHash, hashToken(keepToken))) : others);
      await recordEvents(tx, { merchantId: u.merchantId, actor: { type: 'DASHBOARD_USER', id: userId }, now }, [{ type: 'TWO_FACTOR_ENABLED', data: { userId } }]);
      return updated!;
    });
  }

  /** Turn two-factor off: needs the password and a current code. */
  async disableTwoFactor(userId: string, password: string, code: string): Promise<DashboardUser> {
    const { db, clock, secrets } = this.deps;
    const [u] = await db.select().from(dashboardUsers).where(eq(dashboardUsers.id, userId));
    if (!u) throw new AppError('NOT_FOUND', `User ${userId} not found`);
    if (!(await verifyPassword(password, u.passwordHash))) throw new AppError('UNAUTHORIZED', 'Password is wrong');
    if (!u.totpSecret) throw new AppError('CONFLICT', 'Two-factor sign-in is not on');
    const now = clock.now();
    const step = verifyTotp(secrets.open<string>(u.totpSecret), code, now, u.totpLastStep);
    if (step === null || !(await this.claimStep(u.id, step))) throw new AppError('UNAUTHORIZED', 'Invalid code');
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(dashboardUsers)
        .set({ totpSecret: null, totpPendingSecret: null, totpLastStep: null, updatedAt: now })
        .where(eq(dashboardUsers.id, userId))
        .returning();
      await recordEvents(tx, { merchantId: u.merchantId, actor: { type: 'DASHBOARD_USER', id: userId }, now }, [{ type: 'TWO_FACTOR_DISABLED', data: { userId } }]);
      return updated!;
    });
  }

  /** Record a used time step atomically: of two requests racing with one code, only one wins. */
  private async claimStep(userId: string, step: number): Promise<boolean> {
    const rows = await this.deps.db
      .update(dashboardUsers)
      .set({ totpLastStep: step })
      .where(and(eq(dashboardUsers.id, userId), or(isNull(dashboardUsers.totpLastStep), lt(dashboardUsers.totpLastStep, step))))
      .returning({ id: dashboardUsers.id });
    return rows.length > 0;
  }
}
