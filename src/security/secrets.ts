import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

/**
 * Authenticated encryption for stored secrets (PSP credentials), AES-256-GCM.
 * Sealed format: `<keyId>.<iv>.<tag>.<ciphertext>` (base64url). A key ring lets keys rotate: the
 * first key seals, every key opens, so old rows stay readable while they are re-sealed.
 */
export class SecretBox {
  private constructor(
    private readonly keys: Map<string, Buffer>,
    private readonly activeId: string,
  ) {}

  /** `CREDENTIALS_KEYS="k2:<base64 32 bytes>,k1:<…>"` — the first entry is the active key. */
  static fromKeyRing(ring: string): SecretBox {
    const keys = new Map<string, Buffer>();
    let active: string | undefined;
    for (const entry of ring.split(',').map((e) => e.trim()).filter(Boolean)) {
      const m = /^([A-Za-z0-9_-]{1,20}):([A-Za-z0-9+/=_-]+)$/.exec(entry);
      if (!m) throw new Error('CREDENTIALS_KEYS must look like "k1:<base64 key>[,k0:<base64 key>]"');
      const [, id, encoded] = m;
      const key = Buffer.from(encoded!, 'base64');
      if (key.length !== 32) throw new Error(`Credentials key ${id} must be 32 bytes (base64 of 32 random bytes)`);
      if (keys.has(id!)) throw new Error(`Credentials key ${id} is listed twice`);
      keys.set(id!, key);
      active ??= id;
    }
    if (!active) throw new Error('CREDENTIALS_KEYS must contain at least one key');
    return new SecretBox(keys, active);
  }

  /** From the environment; outside production a fixed development key is used (with a warning). */
  static fromEnv(ring: string | undefined, nodeEnv: string, warn: (msg: string) => void = (m) => console.warn(m)): SecretBox {
    if (ring) return SecretBox.fromKeyRing(ring);
    if (nodeEnv === 'production') throw new Error('CREDENTIALS_KEYS is required in production (encrypts PSP credentials)');
    warn('CREDENTIALS_KEYS not set — using an insecure development key for PSP credentials');
    return SecretBox.development();
  }

  /** Fixed, publicly known key for development and tests only. */
  static development(): SecretBox {
    return new SecretBox(new Map([['dev', createHash('sha256').update('merchantflo-dev-credentials-key').digest()]]), 'dev');
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALG, this.keys.get(this.activeId)!, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [this.activeId, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.');
  }

  open<T = unknown>(sealed: string): T {
    const [id, iv, tag, ct] = sealed.split('.');
    if (!id || !iv || !tag || ct === undefined) throw new Error('Sealed secret is malformed');
    const key = this.keys.get(id);
    if (!key) throw new Error(`Sealed secret key ${id} is not configured — add it to CREDENTIALS_KEYS`);
    try {
      const decipher = createDecipheriv(ALG, key, unb64(iv));
      decipher.setAuthTag(unb64(tag));
      return JSON.parse(Buffer.concat([decipher.update(unb64(ct)), decipher.final()]).toString('utf8')) as T;
    } catch {
      throw new Error('Sealed secret could not be decrypted (wrong key or tampered data)');
    }
  }

  /** True when a value was sealed with an older key and should be re-sealed with the active one. */
  needsReseal(sealed: string): boolean {
    return sealed.split('.')[0] !== this.activeId;
  }
}
