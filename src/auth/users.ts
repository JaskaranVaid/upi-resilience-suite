import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { dashboardUsers, type DashboardRole } from '../db/schema.js';
import { AppError } from '../errors.js';
import { recordEvents, type Actor } from '../events/record.js';
import { newId } from '../ids.js';
import { hashPassword } from './passwords.js';

export type DashboardUser = typeof dashboardUsers.$inferSelect;

export const MIN_PASSWORD_LENGTH = 12;

export function userView(u: DashboardUser) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.disabled, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt };
}

/** Dashboard user management. Merchant admins (or the merchant API key, to bootstrap) manage users. */
export class UserService {
  constructor(private readonly deps: { db: Db; clock: Clock }) {}

  async create(merchantId: string, input: { email: string; name: string; password: string; role: DashboardRole }, actor: Actor): Promise<DashboardUser> {
    const { db, clock } = this.deps;
    if (input.password.length < MIN_PASSWORD_LENGTH) throw new AppError('VALIDATION', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    const email = input.email.trim().toLowerCase();
    const [taken] = await db.select({ id: dashboardUsers.id }).from(dashboardUsers).where(eq(dashboardUsers.email, email));
    if (taken) throw new AppError('CONFLICT', 'A dashboard user with this email already exists');
    const now = clock.now();
    const passwordHash = await hashPassword(input.password);
    return db.transaction(async (tx) => {
      const [u] = await tx
        .insert(dashboardUsers)
        .values({ id: newId('usr'), merchantId, email, name: input.name, passwordHash, role: input.role, createdBy: actor.type === 'SYSTEM' ? null : actor.id, createdAt: now, updatedAt: now })
        .returning();
      await recordEvents(tx, { merchantId, actor, now }, [{ type: 'USER_CREATED', data: { userId: u!.id, role: u!.role } }]);
      return u!;
    });
  }

  async list(merchantId: string): Promise<DashboardUser[]> {
    return this.deps.db.select().from(dashboardUsers).where(eq(dashboardUsers.merchantId, merchantId)).orderBy(asc(dashboardUsers.createdAt));
  }

  async update(merchantId: string, userId: string, patch: { role?: DashboardRole; disabled?: boolean; name?: string }, actor: Actor): Promise<DashboardUser> {
    const { db, clock } = this.deps;
    const [u] = await db.select().from(dashboardUsers).where(and(eq(dashboardUsers.id, userId), eq(dashboardUsers.merchantId, merchantId)));
    if (!u) throw new AppError('NOT_FOUND', `User ${userId} not found`);

    const losesAdmin = u.role === 'ADMIN' && !u.disabled && ((patch.role && patch.role !== 'ADMIN') || patch.disabled === true);
    if (losesAdmin) {
      const [{ n } = { n: 0 }] = await db
        .select({ n: count() })
        .from(dashboardUsers)
        .where(and(eq(dashboardUsers.merchantId, merchantId), eq(dashboardUsers.role, 'ADMIN'), eq(dashboardUsers.disabled, false), ne(dashboardUsers.id, userId)));
      if (Number(n) === 0) throw new AppError('CONFLICT', 'A merchant must keep at least one active admin');
    }

    const now = clock.now();
    return db.transaction(async (tx) => {
      const [updated] = await tx.update(dashboardUsers).set({ ...patch, updatedAt: now }).where(eq(dashboardUsers.id, userId)).returning();
      await recordEvents(tx, { merchantId, actor, now }, [{ type: 'USER_UPDATED', data: { userId, ...patch } }]);
      return updated!;
    });
  }
}
