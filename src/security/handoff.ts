import { constants, createCipheriv, createDecipheriv, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';

/**
 * Handing a new secret (an operator's one-time password and authenticator URI) to one person
 * through a channel that is logged — the output of a one-off ECS task lands in CloudWatch. The
 * secret is encrypted to the recipient's RSA public key (RSA-OAEP-SHA256 wrapping a random
 * AES-256-GCM key), so the log holds only ciphertext; the recipient opens it on their own machine.
 *
 * Form: `mfh1.<wrapped key>.<iv>.<tag>.<ciphertext>`, each base64url.
 */

const PREFIX = 'mfh1';
const MIN_RSA_BITS = 2048;
const b64 = (b: Buffer) => b.toString('base64url');
const oaep = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

export function sealForRecipient(plaintext: string, publicKeyPem: string): string {
  const pub = createPublicKey(publicKeyPem);
  if (pub.asymmetricKeyType !== 'rsa') throw new Error('The recipient key must be an RSA public key');
  if ((pub.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) throw new Error(`The recipient key must be at least ${MIN_RSA_BITS} bits`);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const wrapped = publicEncrypt({ key: pub, ...oaep }, key);
  return [PREFIX, b64(wrapped), b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.');
}

export function openFromRecipient(blob: string, privateKeyPem: string): string {
  const parts = blob.trim().split('.');
  if (parts.length !== 5 || parts[0] !== PREFIX) throw new Error('This is not a sealed hand-off (expected mfh1.…)');
  const [, wrapped, iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
  const key = privateDecrypt({ key: privateKeyPem, ...oaep }, wrapped!);
  const decipher = createDecipheriv('aes-256-gcm', key, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(ct!), decipher.final()]).toString('utf8');
}
