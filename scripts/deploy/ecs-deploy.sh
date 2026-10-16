#!/usr/bin/env bash
# Deploy one image to one environment (docs/runbooks/deploy.md):
#   1. register api/worker/migrate task definition revisions with the new image
#   2. run the migrate task once and stop here unless it exits 0 (services untouched)
#   3. roll the api and worker services and wait until they are stable on the new revision
#   4. check /readyz and /health through the load balancer
#
# Usage: scripts/deploy/ecs-deploy.sh <dev|staging|production> <image> [public-base-url]
# Needs: aws CLI v2 with credentials for the environment's deploy role, node >= 23.6, curl.
set -euo pipefail

env_name=${1:?environment (dev, staging or production)}
image=${2:?image, e.g. <account>.dkr.ecr.ap-south-1.amazonaws.com/merchantflo:<commit>}
base_url=${3:-}

name="merchantflo-${env_name}"
cluster="$name"
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step() { printf '\n== %s\n' "$*"; }

register() { # role -> prints the new task definition ARN
  local role=$1
  aws ecs describe-task-definition --task-definition "${name}-${role}" --output json >"$work/${role}.json"
  node "$here/task-def.ts" "$image" <"$work/${role}.json" >"$work/${role}.next.json"
  aws ecs register-task-definition --cli-input-json "file://$work/${role}.next.json" \
    --query 'taskDefinition.taskDefinitionArn' --output text
}

step "registering task definitions for $image"
migrate_td=$(register migrate)
api_td=$(register api)
worker_td=$(register worker)
printf '%s\n' "$migrate_td" "$api_td" "$worker_td"

step "migrating the database"
# The migrate task runs in the api service's subnets and security group.
network=$(aws ecs describe-services --cluster "$cluster" --services "${name}-api" \
  --query 'services[0].networkConfiguration' --output json)
task=$(aws ecs run-task --cluster "$cluster" --task-definition "$migrate_td" --launch-type FARGATE \
  --network-configuration "$network" --started-by "deploy-${GITHUB_RUN_ID:-manual}" \
  --query 'tasks[0].taskArn' --output text)
echo "migrate task $task"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
exit_code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
  --query "tasks[0].containers[?name=='app'].exitCode | [0]" --output text)
stopped_reason=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --query 'tasks[0].stoppedReason' --output text)
aws logs get-log-events --log-group-name "/merchantflo/${env_name}/migrate" \
  --log-stream-name "migrate/app/${task##*/}" --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' || true
if [[ "$exit_code" != "0" ]]; then
  echo "migration failed (exit code ${exit_code}, ${stopped_reason}); the running services were not changed" >&2
  exit 1
fi

step "rolling the services"
aws ecs update-service --cluster "$cluster" --service "${name}-api" --task-definition "$api_td" --query 'service.serviceName' --output text
aws ecs update-service --cluster "$cluster" --service "${name}-worker" --task-definition "$worker_td" --query 'service.serviceName' --output text
aws ecs wait services-stable --cluster "$cluster" --services "${name}-api" "${name}-worker"

# A deployment the circuit breaker rolled back is also "stable" — on the old revision.
for pair in "api:$api_td" "worker:$worker_td"; do
  role=${pair%%:*}
  want=${pair#*:}
  running=$(aws ecs describe-services --cluster "$cluster" --services "${name}-${role}" \
    --query 'services[0].deployments[?status==`PRIMARY`].taskDefinition | [0]' --output text)
  if [[ "$running" != "$want" ]]; then
    echo "${role} is running ${running}, not ${want}: the deployment was rolled back (see the service events)" >&2
    exit 1
  fi
done
echo "api and worker run the new revisions"

if [[ -n "$base_url" ]]; then
  step "smoke check $base_url"
  curl -fsS --retry 5 --retry-delay 3 --retry-all-errors "$base_url/readyz"
  echo
  curl -fsS "$base_url/health"
  echo
fi

step "deployed $image to $env_name"
