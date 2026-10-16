import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../src/cli/ops-operator.ts', import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const dir = mkdtempSync(join(tmpdir(), 'mf-opcli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const pubFile = join(dir, 'op.pub');
const keyFile = join(dir, 'op.key');
writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }));
writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));

/** Runs the CLI from an empty directory (no .env) against its own PGlite database. */
function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', tsx, cli, ...args],
      { cwd: dir, env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: `pglite://${join(dir, 'db')}`, CREDENTIALS_KEYS: '' }, timeout: 90_000 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe('ops-operator CLI', () => {
  it('refuses to create an operator without a recipient key, before touching the database', async () => {
    const r = await run(['create', '--email', 'asha@merchantflo.in', '--name', 'Asha']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--recipient-key/);
    expect(r.stdout).toBe('');
  }, 120_000);

  it('prints the new credentials only encrypted to the recipient, and decrypt opens them', async () => {
    const created = await run(['create', '--email', 'asha@merchantflo.in', '--name', 'Asha', '--role', 'OWNER', '--recipient-key', pubFile]);
    expect(created.stderr).not.toMatch(/Error/);
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/created OWNER asha@merchantflo\.in/);
    expect(created.stdout).not.toMatch(/otpauth|password:/i);
    const blob = /mfh1\.[\w.-]+/.exec(created.stdout)![0];

    const opened = await run(['decrypt', '--key', keyFile, blob]);
    expect(opened.code).toBe(0);
    const creds = JSON.parse(opened.stdout);
    expect(creds).toMatchObject({ email: 'asha@merchantflo.in', otpauthUri: expect.stringMatching(/^otpauth:\/\/totp\//) });
    expect(creds.password).toMatch(/^[\w-]{20,}$/);

    // reset-2fa hands over the new URI the same way.
    const reset = await run(['reset-2fa', '--email', 'asha@merchantflo.in', '--recipient-key', pubFile]);
    expect(reset.code).toBe(0);
    expect(reset.stdout).not.toMatch(/otpauth/);
    expect(JSON.parse((await run(['decrypt', '--key', keyFile, /mfh1\.[\w.-]+/.exec(reset.stdout)![0]])).stdout).otpauthUri).toMatch(/^otpauth:/);
  }, 240_000);
});
