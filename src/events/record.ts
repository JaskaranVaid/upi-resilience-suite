import type { DbOrTx } from '../db/client.js';
import { paymentEvents, type ActorType } from '../db/schema.js';
import { newId } from '../ids.js';
import type { NewEvent, SubjectType } from '../tracking/types.js';

export type Actor = { type: 'SYSTEM' } | { type: Exclude<ActorType, 'SYSTEM'>; id: string };

export const SYSTEM: Actor = { type: 'SYSTEM' };

export interface EventContext {
  merchantId: string;
  subjectType?: SubjectType;
  subjectId?: string;
  caseId?: string;
  actor: Actor;
  now: Date;
}

let lastSeq = 0;

/** Strictly increasing per process, so events written in the same millisecond keep their order. */
function nextSeq(now: Date): number {
  lastSeq = Math.max(lastSeq + 1, now.getTime() * 1000);
  return lastSeq;
}

/** Append audit events. Pass the caller's transaction so events commit with the change they describe. */
export async function recordEvents(db: DbOrTx, ctx: EventContext, events: NewEvent[]): Promise<void> {
  if (events.length === 0) return;
  await db.insert(paymentEvents).values(
    events.map((e) => ({
      id: newId('evt'),
      merchantId: ctx.merchantId,
      subjectType: ctx.subjectType ?? null,
      subjectId: ctx.subjectId ?? null,
      caseId: ctx.caseId ?? null,
      type: e.type,
      actorType: ctx.actor.type,
      actorId: ctx.actor.type === 'SYSTEM' ? null : ctx.actor.id,
      data: e.data ?? null,
      seq: nextSeq(ctx.now),
      createdAt: ctx.now,
    })),
  );
}
