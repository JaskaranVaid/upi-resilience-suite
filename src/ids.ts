import { randomBytes } from 'node:crypto';

export type IdPrefix = 'mer' | 'ven' | 'mdt' | 'dbt' | 'pay' | 'att' | 'quo' | 'sav' | 'whk' | 'txn';

/** Prefixed, URL-safe random id, e.g. dbt_3kq9V2xH7pTzR1mA. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}
