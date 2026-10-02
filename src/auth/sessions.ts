import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { dashboardSessions, dashboardUsers } from '../db/schema.js';
import { AppError } from '../errors.js';
import { recordEvents } from '../events/record.js';
import { newId } from '../ids.js';
import { DUMMY_HASH, verifyPassword } from './passwords.js';
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

/** Email + password login with lockout, and opaque session tokens stored only as hashes. */
export class SessionService {
  private readonly cfg: AuthConfig;

  constructor(private readonly deps: { db: Db; clock: Clock; cfg?: Partial<AuthConfig> }) {
    this.cfg = { ...DEFAULT_AUTH, ...deps.cfg };
  }

  get config(): AuthConfig {
    return this.cfg;
  }

  async login(emailInput: string, password: string): Promise<{ user: DashboardUser; token: string }> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const email = emailInput.trim().toLowerCase();
    const [u] = await db.select().from(dashboardUsers).where(eq(dashboardUsers.email, email));
    if (!u) {
      await verifyPassword(password, DUMMY_HASH); // same cost as a real attempt
      throw new AppError('UNAUTHORIZED', 'Invalid email or password');
    }
    if (u.lockedUntil && u.lockedUntil > now) throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts — try again later');

    const ok = await verifyPassword(password, u.passwordHash);
    if (!ok || u.disabled) {
      const failed = u.failedLogins + 1;
      const lock = failed >= this.cfg.maxFailedLogins;
      await db
        .update(dashboardUsers)
        .set({ failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + this.cfg.lockoutMs) : u.lockedUntil })
        .where(eq(dashboardUsers.id, u.id));
      await recordEvents(db, { merchantId: u.merchantId, actor: { type: 'DASHBOARD_USER', id: u.id }, now }, [
        { type: 'LOGIN_FAILED', data: { reason: u.disabled ? 'disabled' : 'bad_password', locked: lock } },
      ]);
      throw new AppError('UNAUTHORIZED', 'Invalid email or password');
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
}
