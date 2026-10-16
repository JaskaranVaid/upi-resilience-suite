import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { totpCode } from '../../src/auth/totp.js';
import { FakeClock } from '../../src/clock.js';
import type { Db } from '../../src/db/client.js';
import { operatorAudit } from '../../src/db/schema.js';
import { OperatorService } from '../../src/ops-console/operators.js';
import { SecretBox } from '../../src/security/secrets.js';
import { freshDb, ist } from '../helpers/fixtures.js';

const secretOf = (uri: string) => new URL(uri).searchParams.get('secret')!;

describe('operator accounts (ops console)', () => {
  let db: Db;
  let clock: FakeClock;
  let ops: OperatorService;

  beforeEach(async () => {
    ({ db } = await freshDb());
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    ops = new OperatorService({ db, clock, secrets: SecretBox.development() });
  });

  async function newOperator(role: 'OWNER' | 'OPERATOR' | 'VIEWER' = 'OPERATOR') {
    const created = await ops.create({ email: 'Asha@Merchantflo.in', name: 'Asha', role }, null);
    return { ...created, secret: secretOf(created.otpauthUri) };
  }

  it('creates an operator with a one-time password and an authenticator secret, sealed at rest', async () => {
    const { operator, password, otpauthUri, secret } = await newOperator();
    expect(operator.email).toBe('asha@merchantflo.in');
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/Merchantflo%20Ops:asha%40merchantflo\.in\?secret=/);
    const [row] = ((await db.execute(sql`select totp_secret, password_hash from operators`)) as unknown as { rows: Array<{ totp_secret: string; password_hash: string }> }).rows;
    expect(row!.totp_secret).not.toContain(secret);
    expect(row!.password_hash).toMatch(/^scrypt\$/);
  });

  it('signs in with password and the current code, and the session authenticates', async () => {
    const { password, secret } = await newOperator();
    const { operator, token } = await ops.login('asha@merchantflo.in', password, totpCode(secret, clock.now()));
    expect(operator.name).toBe('Asha');
    expect((await ops.authenticate(token))?.id).toBe(operator.id);
  });

  it('refuses a wrong code, a missing code and a wrong password with the same answer', async () => {
    const { password, secret } = await newOperator();
    const wrongCode = totpCode(secret, new Date(clock.now().getTime() - 5 * 60_000));
    await expect(ops.login('asha@merchantflo.in', password, wrongCode)).rejects.toThrow('Invalid email, password or code');
    await expect(ops.login('asha@merchantflo.in', password, '')).rejects.toThrow('Invalid email, password or code');
    await expect(ops.login('asha@merchantflo.in', 'wrong password!!', totpCode(secret, clock.now()))).rejects.toThrow('Invalid email, password or code');
    await expect(ops.login('nobody@merchantflo.in', password, totpCode(secret, clock.now()))).rejects.toThrow('Invalid email, password or code');
  });

  it('refuses the same code twice (a stolen code cannot be replayed)', async () => {
    const { password, secret } = await newOperator();
    const code = totpCode(secret, clock.now());
    await ops.login('asha@merchantflo.in', password, code);
    await expect(ops.login('asha@merchantflo.in', password, code)).rejects.toThrow('Invalid email, password or code');
    clock.advance(30_000);
    await expect(ops.login('asha@merchantflo.in', password, totpCode(secret, clock.now()))).resolves.toBeTruthy();
  });

  it('locks the account after 5 failures', async () => {
    const { password, secret } = await newOperator();
    for (let i = 0; i < 5; i++) await expect(ops.login('asha@merchantflo.in', 'wrong password!!', '000000')).rejects.toThrow();
    await expect(ops.login('asha@merchantflo.in', password, totpCode(secret, clock.now()))).rejects.toThrow('Too many failed attempts');
    clock.advance(16 * 60_000);
    await expect(ops.login('asha@merchantflo.in', password, totpCode(secret, clock.now()))).resolves.toBeTruthy();
  });

  it('ends sessions after 15 idle minutes, 8 hours in all, on logout, or when the operator is disabled', async () => {
    const { password, secret, operator } = await newOperator();
    const login = async () => {
      clock.advance(30_000);
      return (await ops.login('asha@merchantflo.in', password, totpCode(secret, clock.now()))).token;
    };
    let token = await login();
    clock.advance(16 * 60_000);
    expect(await ops.authenticate(token)).toBeNull();

    token = await login();
    for (let i = 0; i < 40; i++) {
      clock.advance(14 * 60_000);
      if (i < 33) expect(await ops.authenticate(token), `after ${(i + 1) * 14} min`).not.toBeNull();
    }
    expect(await ops.authenticate(token)).toBeNull();

    token = await login();
    await ops.logout(token);
    expect(await ops.authenticate(token)).toBeNull();

    token = await login();
    await ops.disable(operator.id, null);
    expect(await ops.authenticate(token)).toBeNull();
  });

  it('resetting two-factor issues a new secret and the old codes stop working', async () => {
    const { password, secret, operator } = await newOperator();
    const { otpauthUri } = await ops.resetTotp(operator.id, null);
    const fresh = secretOf(otpauthUri);
    expect(fresh).not.toBe(secret);
    await expect(ops.login('asha@merchantflo.in', password, totpCode(secret, clock.now()))).rejects.toThrow();
    clock.advance(30_000);
    await expect(ops.login('asha@merchantflo.in', password, totpCode(fresh, clock.now()))).resolves.toBeTruthy();
  });

  it('audits creation, sign-ins, failures and resets', async () => {
    const { password, secret, operator } = await newOperator();
    await ops.login('asha@merchantflo.in', password, totpCode(secret, clock.now()));
    await expect(ops.login('asha@merchantflo.in', 'nope nope nope', '000000')).rejects.toThrow();
    await ops.resetTotp(operator.id, operator.id);
    const actions = (await db.select().from(operatorAudit)).map((a) => a.action);
    expect(actions).toEqual(['OPERATOR_CREATED', 'LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'TOTP_RESET']);
    expect((await ops.listAudit(10)).map((a) => a.action)).toEqual(['TOTP_RESET', 'LOGIN_FAILED', 'LOGIN_SUCCEEDED', 'OPERATOR_CREATED']);
  });

  it('refuses a duplicate e-mail', async () => {
    await newOperator();
    await expect(ops.create({ email: 'asha@merchantflo.in', name: 'Other', role: 'VIEWER' }, null)).rejects.toThrow('already exists');
  });
});
