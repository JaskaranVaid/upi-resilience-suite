import { AppError } from '../errors.js';
import type { PspAdapter } from '../psp/types.js';

/**
 * Which PSPs may execute a mandate. A mandate lives at the PSP it was registered with; only
 * portable mandates may be executed elsewhere. Omitted = every available PSP that accepts
 * portable mandates. Only the merchant's own available PSPs count: anything else is "unknown".
 */
export function resolveEligiblePsps(available: ReadonlyMap<string, PspAdapter>, requested: string[] | undefined): string[] {
  const eligible = requested ?? [...available.values()].filter((a) => a.capabilities.portableMandates && a.capabilities.autopay).map((a) => a.id);
  if (eligible.length === 0) throw new AppError('VALIDATION', 'Specify eligiblePsps: the payment provider this mandate was registered with');
  const unknown = eligible.filter((p) => !available.has(p));
  if (unknown.length) throw new AppError('VALIDATION', `Unknown PSPs: ${unknown.join(', ')}`);
  const noAutopay = eligible.filter((p) => !available.get(p)!.capabilities.autopay);
  if (noAutopay.length) throw new AppError('VALIDATION', `${noAutopay.join(', ')} can't execute AutoPay mandates through Merchantflo`);
  const nonPortable = eligible.filter((p) => !available.get(p)!.capabilities.portableMandates);
  if (nonPortable.length > 0 && eligible.length > 1) {
    throw new AppError('VALIDATION', `${nonPortable[0]} mandates can only be executed through ${nonPortable[0]}; set eligiblePsps to ["${nonPortable[0]}"]`);
  }
  return eligible;
}
