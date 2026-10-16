#!/usr/bin/env bash
# Backup restore drill (docs/runbooks/backup-restore.md): restore the environment's database to a
# point in time as a throwaway instance, verify it from inside the VPC, report how long it took,
# delete it. Production data never leaves the account or the region.
#
# Usage: scripts/drills/restore-drill.sh <dev|staging|production> [restore-time, e.g. 2026-11-02T03:15:00Z]
# Needs: aws CLI v2 with rds:* (restore, describe, delete), ecs:RunTask/DescribeTasks, logs:GetLogEvents
# on the environment — a founder's operator credentials, not the deploy role.
set -euo pipefail

env_name=${1:?environment (dev, staging or production)}
restore_time=${2:-}
name="merchantflo-${env_name}"
drill="${name}-drill-$(date -u +%Y%m%d%H%M)"
began=$(date +%s)

security_groups=$(aws rds describe-db-instances --db-instance-identifier "$name" \
  --query 'DBInstances[0].VpcSecurityGroups[].VpcSecurityGroupId' --output text)
parameter_group=$(aws rds describe-db-instances --db-instance-identifier "$name" \
  --query 'DBInstances[0].DBParameterGroups[0].DBParameterGroupName' --output text)
instance_class=$(aws rds describe-db-instances --db-instance-identifier "$name" \
  --query 'DBInstances[0].DBInstanceClass' --output text)
latest=$(aws rds describe-db-instances --db-instance-identifier "$name" \
  --query 'DBInstances[0].LatestRestorableTime' --output text)

cleanup() {
  echo "deleting drill instance $drill"
  aws rds delete-db-instance --db-instance-identifier "$drill" --skip-final-snapshot --delete-automated-backups >/dev/null 2>&1 || true
}
trap cleanup EXIT

when=(--use-latest-restorable-time)
[[ -n "$restore_time" ]] && when=(--restore-time "$restore_time")
echo "restoring $name to ${restore_time:-latest restorable time ($latest)} as $drill"
# shellcheck disable=SC2086 # security group ids are space-separated words
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$name" --target-db-instance-identifier "$drill" "${when[@]}" \
  --db-subnet-group-name "$name" --vpc-security-group-ids $security_groups \
  --db-parameter-group-name "$parameter_group" --db-instance-class "$instance_class" \
  --no-multi-az --no-publicly-accessible --no-deletion-protection \
  --tags Key=Purpose,Value=restore-drill >/dev/null

# The waiter gives up after 30 minutes; large databases take longer, so keep waiting.
until aws rds wait db-instance-available --db-instance-identifier "$drill" 2>/dev/null; do
  echo "still restoring…"
done
restored=$(date +%s)
host=$(aws rds describe-db-instances --db-instance-identifier "$drill" --query 'DBInstances[0].Endpoint.Address' --output text)
echo "restored in $(((restored - began) / 60)) min: $host"

# Verify from inside the VPC: the migrate task definition, running the read-only verifier instead.
network=$(aws ecs describe-services --cluster "$name" --services "${name}-api" --query 'services[0].networkConfiguration' --output json)
overrides=$(printf '{"containerOverrides":[{"name":"app","command":["node","dist/ops/verify-cli.js"],"environment":[{"name":"VERIFY_DATABASE_HOST","value":"%s"}]}]}' "$host")
task=$(aws ecs run-task --cluster "$name" --task-definition "${name}-migrate" --launch-type FARGATE \
  --network-configuration "$network" --overrides "$overrides" --started-by restore-drill \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$name" --tasks "$task"
exit_code=$(aws ecs describe-tasks --cluster "$name" --tasks "$task" --query "tasks[0].containers[?name=='app'].exitCode | [0]" --output text)
aws logs get-log-events --log-group-name "/merchantflo/${env_name}/migrate" --log-stream-name "migrate/app/${task##*/}" \
  --query 'events[].message' --output text | tr '\t' '\n'
verified=$(date +%s)

echo
echo "restore drill ${env_name}: restore $(((restored - began) / 60)) min, verify $(((verified - restored) / 60)) min, total $(((verified - began) / 60)) min"
if [[ "$exit_code" != "0" ]]; then
  echo "VERIFICATION FAILED (exit code $exit_code) — keep the instance for investigation: re-run without the cleanup trap" >&2
  exit 1
fi
echo "verification passed — record the timings in docs/runbooks/backup-restore.md"
