import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/deploy/ecs-deploy.sh', import.meta.url));
const IMAGE = '111122223333.dkr.ecr.ap-south-1.amazonaws.com/merchantflo:bbbbbbb';

// A stand-in for the AWS CLI: records each call and answers like ECS would.
const FAKE_AWS = String.raw`#!/usr/bin/env bash
echo "$*" >> "$FAKE_AWS_LOG"
arg() { local want=$1; shift; while [[ $# -gt 0 ]]; do [[ $1 == "$want" ]] && { echo "$2"; return; }; shift; done; }
case "$1 $2" in
  "ecs describe-task-definition")
    fam=$(arg --task-definition "$@")
    echo "{\"taskDefinition\":{\"family\":\"$fam\",\"revision\":1,\"status\":\"ACTIVE\",\"containerDefinitions\":[{\"name\":\"app\",\"image\":\"old:1\"}]}}" ;;
  "ecs register-task-definition")
    f=$(arg --cli-input-json "$@"); f=${"$"}{f#file://}
    command -v cygpath >/dev/null && f=$(cygpath -w "$f")
    cp "$f" "$FAKE_AWS_DIR/registered-$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).family)' "$f").json"
    echo "arn:aws:ecs:ap-south-1:1:task-definition/$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).family)' "$f"):2" ;;
  "ecs describe-services")
    case "$*" in
      *networkConfiguration*) echo '{"awsvpcConfiguration":{"subnets":["subnet-1"],"securityGroups":["sg-1"],"assignPublicIp":"DISABLED"}}' ;;
      *merchantflo-staging-api*) echo "${"$"}{FAKE_PRIMARY_API:-arn:aws:ecs:ap-south-1:1:task-definition/merchantflo-staging-api:2}" ;;
      *) echo "arn:aws:ecs:ap-south-1:1:task-definition/merchantflo-staging-worker:2" ;;
    esac ;;
  "ecs run-task") echo "arn:aws:ecs:ap-south-1:1:task/merchantflo-staging/0123abcd" ;;
  "ecs describe-tasks")
    case "$*" in
      *exitCode*) echo "$FAKE_MIGRATE_EXIT" ;;
      *) echo "Essential container in task exited" ;;
    esac ;;
  "logs get-log-events") echo "migrations applied" ;;
  "ecs update-service") arg --service "$@" ;;
  "ecs wait") ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac
`;

function deploy(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mf-deploy-'));
  writeFileSync(join(dir, 'aws'), FAKE_AWS);
  chmodSync(join(dir, 'aws'), 0o755);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const res = spawnSync('bash', [script, 'staging', IMAGE], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, FAKE_AWS_LOG: log, FAKE_AWS_DIR: dir, FAKE_MIGRATE_EXIT: '0', ...env },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ').slice(0, 2).join(' ') + (l.includes('--service ') ? ` ${/--service (\S+)/.exec(l)![1]}` : ''));
  return { ...res, calls, dir };
}

describe('deploy script (ecs-deploy.sh)', () => {
  it('registers revisions with the new image, migrates, then rolls api and worker', () => {
    const r = deploy();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      'ecs describe-task-definition', 'ecs register-task-definition',
      'ecs describe-task-definition', 'ecs register-task-definition',
      'ecs describe-task-definition', 'ecs register-task-definition',
      'ecs describe-services', 'ecs run-task', 'ecs wait', 'ecs describe-tasks', 'ecs describe-tasks', 'logs get-log-events',
      'ecs update-service merchantflo-staging-api', 'ecs update-service merchantflo-staging-worker', 'ecs wait',
      'ecs describe-services', 'ecs describe-services',
    ]);
    for (const role of ['api', 'worker', 'migrate']) {
      const registered = JSON.parse(readFileSync(join(r.dir, `registered-merchantflo-staging-${role}.json`), 'utf8'));
      expect(registered.containerDefinitions[0].image).toBe(IMAGE);
      expect(registered).not.toHaveProperty('revision');
    }
    expect(r.stdout).toContain('deployed');
  }, 60_000);

  it('stops before touching the services when the migration fails', () => {
    const r = deploy({ FAKE_MIGRATE_EXIT: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('migration failed (exit code 1');
    expect(r.calls.some((c) => c.startsWith('ecs update-service'))).toBe(false);
  }, 60_000);

  it('stops when the migrate container never ran (no exit code)', () => {
    const r = deploy({ FAKE_MIGRATE_EXIT: 'None' });
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c.startsWith('ecs update-service'))).toBe(false);
  }, 60_000);

  it('fails when ECS rolled the deployment back to the previous revision', () => {
    const r = deploy({ FAKE_PRIMARY_API: 'arn:aws:ecs:ap-south-1:1:task-definition/merchantflo-staging-api:1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('rolled back');
  }, 60_000);
});
