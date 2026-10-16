import type { FastifyRequest } from 'fastify';
import type { OperatorRole } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { Operator } from '../ops-console/operators.js';

declare module 'fastify' {
  interface FastifyRequest {
    operator: Operator | null;
  }
}

/** The signed-in operator (set by the ops console's session hook). */
export function operatorOf(req: FastifyRequest): Operator {
  if (!req.operator) throw new AppError('UNAUTHORIZED', 'Please sign in');
  return req.operator;
}

export function requireOperatorRole(req: FastifyRequest, roles: OperatorRole[]): Operator {
  const o = operatorOf(req);
  if (!roles.includes(o.role)) throw new AppError('FORBIDDEN', 'Your role does not allow this action');
  return o;
}

/** Roles that may change things; VIEWER only reads. */
export const CAN_ACT: OperatorRole[] = ['OWNER', 'OPERATOR'];
