import { customType } from 'drizzle-orm/pg-core';
import { SecretBox } from './secrets.js';

/**
 * Encryption of customers' personal data at rest (VPAs, phone numbers, the payment link or QR
 * handed to a customer). Columns declared with personalText / personalJson are sealed on every
 * write and opened on every read — inserts, updates, selects and `.returning()` alike — so
 * services never see ciphertext.
 *
 * Stored form: `pf1.<keyId>.<iv>.<tag>.<ciphertext>` (AES-256-GCM, SecretBox), with a key derived
 * from CREDENTIALS_KEYS for this purpose only. A value without the prefix is a row written before
 * encryption (or with it turned off) and is read as-is; `npm run privacy:backfill` seals those
 * and re-seals values under an older key.
 *
 * Sealing is randomised, so these columns cannot be filtered or joined on in SQL. Nothing does.
 */

const PREFIX = 'pf1.';
const PURPOSE = 'merchantflo/personal-fields/v1';

interface FieldEncryption {
  box: SecretBox;
  enabled: boolean;
}

let state: FieldEncryption | null = null;

/** Process-wide; buildContext calls it with the app's key ring. */
export function configureFieldEncryption(o: { box: SecretBox; enabled: boolean }): void {
  state = { box: o.box.derive(PURPOSE), enabled: o.enabled };
}

function current(): FieldEncryption {
  if (!state) {
    // Never fall back to the public development key where real customers' data lives.
    if (process.env.NODE_ENV === 'production') throw new Error('Personal field encryption is not configured');
    configureFieldEncryption({ box: SecretBox.development(), enabled: true });
  }
  return state!;
}

export const isSealedField = (stored: string): boolean => stored.startsWith(PREFIX);

/**
 * What an erased NOT NULL personal field holds (src/privacy/service.ts). Written as plaintext on
 * purpose, so SQL can tell a redacted row from a live one; it is never sealed.
 */
export const REDACTED = '[erased]';

/** True when a stored value should be (re)written: plaintext, or sealed under an older key. Always false while encryption is off. */
export function needsSealing(stored: string | null): boolean {
  const { box, enabled } = current();
  return enabled && stored !== null && stored !== REDACTED && !stored.startsWith(`${PREFIX}${box.activeKeyId}.`);
}

function seal(value: unknown): string {
  return PREFIX + current().box.seal(value);
}

function open<T>(stored: string): T {
  return current().box.open<T>(stored.slice(PREFIX.length));
}

/** A text column holding personal data. */
export const personalText = customType<{ data: string; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => (current().enabled ? seal(value) : value),
  fromDriver: (stored) => (isSealedField(stored) ? open<string>(stored) : stored),
});

/** A jsonb column holding personal data: sealed, it stores a JSON string; plaintext rows hold the object. */
export const personalJson = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (value) => JSON.stringify(current().enabled ? seal(value) : value),
  fromDriver: (stored) => {
    // Drivers usually parse jsonb; parse here when one hands over the text.
    let v = stored;
    if (typeof v === 'string' && !isSealedField(v)) {
      try {
        v = JSON.parse(v);
      } catch {
        return v;
      }
    }
    return typeof v === 'string' && isSealedField(v) ? open<unknown>(v) : v;
  },
});
