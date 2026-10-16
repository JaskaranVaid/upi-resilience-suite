/**
 * Manage Merchantflo operator accounts (ops console) from a trusted shell — the first OWNER has
 * to come from somewhere. In AWS run it as a one-off ECS task on the production image with the
 * command `node dist/cli/ops-operator.js create ...` (docs/runbooks/operators.md).
 *
 *   npm run ops:operator -- create --email asha@merchantflo.in --name "Asha" [--role OWNER|OPERATOR|VIEWER] --recipient-key asha.pub
 *   npm run ops:operator -- reset-2fa --email asha@merchantflo.in --recipient-key asha.pub
 *   npm run ops:operator -- disable --email asha@merchantflo.in
 *   npm run ops:operator -- decrypt --key asha.key mfh1.…
 *
 * New credentials (one-time password, authenticator URI) are never printed in the clear: output is
 * collected by logs (CloudWatch for an ECS task). They are encrypted to the new operator's RSA
 * public key (`--recipient-key`: a PEM file or the PEM text) and printed as one `mfh1.…` line,
 * which only `decrypt` with their private key opens — on their own machine.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { systemClock } from '../clock.js';
import { loadDotEnv } from '../config/dotenv.js';
import { loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import type { OperatorRole } from '../db/schema.js';
import { OperatorService } from '../ops-console/operators.js';
import { openFromRecipient, sealForRecipient } from '../security/handoff.js';
import { SecretBox } from '../security/secrets.js';

const ROLES: OperatorRole[] = ['OWNER', 'OPERATOR', 'VIEWER'];
const USAGE = `usage: ops-operator create --email <e> --name <n> [--role OWNER|OPERATOR|VIEWER] --recipient-key <public key PEM file or text>
       ops-operator reset-2fa --email <e> --recipient-key <public key>
       ops-operator disable --email <e>
       ops-operator decrypt --key <private key PEM file> <mfh1.…>
Make a key pair (each operator, on their own machine):
       openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out op.key && openssl pkey -in op.key -pubout -out op.pub`;

function usage(problem: string): never {
  console.error(`${problem}\n${USAGE}`);
  process.exit(2);
}

/** A PEM given inline (as in an ECS command override) or a path to one. */
const pemFrom = (value: string) => (value.trimStart().startsWith('-----BEGIN') ? value : readFileSync(value, 'utf8'));

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string', default: 'OPERATOR' },
      'recipient-key': { type: 'string' },
      key: { type: 'string' },
    },
  });

  if (command === 'decrypt') {
    // Local only: needs no database or configuration.
    if (!values.key || positionals.length !== 1) usage('decrypt needs --key and the mfh1.… line');
    process.stdout.write(`${openFromRecipient(positionals[0]!, readFileSync(values.key, 'utf8'))}\n`);
    return;
  }
  if (!command || !['create', 'reset-2fa', 'disable'].includes(command)) usage(`unknown command ${command ?? ''}`.trim());
  if (!values.email || (command === 'create' && !values.name)) usage(`${command} needs --email${command === 'create' ? ' and --name' : ''}`);
  const recipient = values['recipient-key'];
  if (command !== 'disable' && !recipient) usage(`${command} needs --recipient-key: new credentials are only handed over encrypted`);
  const recipientPem = recipient ? pemFrom(recipient) : null;
  // Fail on a bad key before any account changes.
  if (recipientPem) sealForRecipient('check', recipientPem);

  loadDotEnv();
  const env = loadEnv();
  const { db, close } = await createDb(env.DATABASE_URL, { migrate: env.MIGRATE_ON_START, poolMax: 1 });
  const ops = new OperatorService({ db, clock: systemClock, secrets: SecretBox.fromEnv(env.CREDENTIALS_KEYS, env.NODE_ENV) });
  const handOff = (credentials: Record<string, string>) => {
    console.log('credentials, encrypted to the recipient key (open with: ops-operator decrypt --key <private key> <line>):');
    console.log(sealForRecipient(JSON.stringify(credentials), recipientPem!));
  };
  try {
    if (command === 'create') {
      const role = values.role.toUpperCase() as OperatorRole;
      if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
      const created = await ops.create({ email: values.email, name: values.name!, role }, null);
      console.log(`created ${created.operator.role} ${created.operator.email} (${created.operator.id})`);
      handOff({ email: created.operator.email, password: created.password, otpauthUri: created.otpauthUri });
      return;
    }
    const operator = await ops.findByEmail(values.email);
    if (!operator) throw new Error(`no operator ${values.email}`);
    if (command === 'reset-2fa') {
      const { otpauthUri } = await ops.resetTotp(operator.id, null);
      console.log(`new authenticator for ${operator.email}; their sessions ended`);
      handOff({ email: operator.email, otpauthUri });
    } else {
      await ops.disable(operator.id, null);
      console.log(`disabled ${operator.email} (sessions ended)`);
    }
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
