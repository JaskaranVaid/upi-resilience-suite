#!/usr/bin/env bash
# Alarm fire drill (docs/runbooks/alerts.md#fire-drill): put every alarm of an environment (or
# those matching a filter) into ALARM so each notification can be confirmed end to end. CloudWatch
# re-evaluates each alarm at its next period and sends the OK notification.
#
# Usage: scripts/drills/alarm-drill.sh <dev|staging|production> [name-filter]
set -euo pipefail

env_name=${1:?environment (dev, staging or production)}
filter=${2:-}
prefix="merchantflo-${env_name}-"
reason="Fire drill $(date -u +%Y-%m-%dT%H:%MZ) by ${USER:-${USERNAME:-operator}} — not a real incident"

alarms=$(aws cloudwatch describe-alarms --alarm-name-prefix "$prefix" --query 'MetricAlarms[].AlarmName' --output text | tr '\t' '\n' | grep -- "$filter" || true)
if [[ -z "$alarms" ]]; then
  echo "no alarms named ${prefix}*${filter}*" >&2
  exit 1
fi
count=0
while read -r alarm; do
  aws cloudwatch set-alarm-state --alarm-name "$alarm" --state-value ALARM --state-reason "$reason"
  echo "ALARM → $alarm"
  count=$((count + 1))
done <<<"$alarms"
echo
echo "$count alarm(s) set. Confirm one ALARM and one OK notification for each, and tick them off in the runbook."
