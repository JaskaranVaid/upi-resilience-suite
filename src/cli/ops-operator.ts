/**
 * Manage Merchantflo operator accounts (ops console) from a trusted shell — the first OWNER has
 * to come from somewhere. In AWS run it as a one-off ECS task on the production image with the
 * command `node dist/cli/ops-operator.js create ...` (docs/runbooks/operators.md).
 *
 *   npm run ops:operator -- create --email asha@merchantflo.in --name "Asha" [--role OWNER|OPERATOR|VIEWER]
 *   npm run ops:operator -- reset-2fa --email asha@merchantflo.in
 *   npm run ops:operator -- disable --email asha@merchantflo.in
 *
 * create prints a one-time password and an otpauth:// URI (add it to an authenticator app, or
 * render it as a QR code). Nothing is stored in plaintext.
 */
import { parseArgs } from 'node:util';
import { systemClock } from '../clock.js';
import { loadDotEnv } from '../config/dotenv.js';
import { loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import type { OperatorRole } from '../db/schema.js';
import { OperatorService } from '../ops-console/operators.js';
import { SecretBox } from '../security/secrets.js';

const ROLES: OperatorRole[] = ['OWNER', 'OPERATOR', 'VIEWER'];

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'OPERATOR' } } });
  if (!command || !values.email || (command === 'create' && !values.name)) {
    console.error('usage: ops-operator create --email <e> --name <n> [--role OWNER|OPERATOR|VIEWER] | reset-2fa --email <e> | disable --email <e>');
    process.exit(2);
  }
  loadDotEnv();
  const env = loadEnv();
  const { db, close } = await createDb(env.DATABASE_URL, { migrate: env.MIGRATE_ON_START, poolMax: 1 });
  const ops = new OperatorService({ db, clock: systemClock, secrets: SecretBox.fromEnv(env.CREDENTIALS_KEYS, env.NODE_ENV) });
  try {
    if (command === 'create') {
      const role = values.role!.toUpperCase() as OperatorRole;
      if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
      const { operator, password, otpauthUri } = await ops.create({ email: values.email, name: values.name!, role }, null);
      console.log(`created ${operator.role} ${operator.email} (${operator.id})`);
      console.log(`one-time password (give it over a separate channel; never stored): ${password}`);
      console.log(`authenticator: ${otpauthUri}`);
      return;
    }
    const operator = await ops.findByEmail(values.email);
    if (!operator) throw new Error(`no operator ${values.email}`);
    if (command === 'reset-2fa') {
      const { otpauthUri } = await ops.resetTotp(operator.id, null);
      console.log(`new authenticator for ${operator.email} (sessions ended): ${otpauthUri}`);
    } else if (command === 'disable') {
      await ops.disable(operator.id, null);
      console.log(`disabled ${operator.email} (sessions ended)`);
    } else {
      throw new Error(`unknown command ${command}`);
    }
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
