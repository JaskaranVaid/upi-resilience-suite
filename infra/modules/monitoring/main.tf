# Alarms for what hurts merchants, paging an SNS topic. The worker logs one `ops.metrics` JSON line
# a minute (src/ops/metrics.ts); metric filters turn each field into a metric. Every worker replica
# reports the same database-derived values, so alarms use Maximum, never Sum.
# Each alarm's meaning and first response: docs/runbooks/alerts.md.

locals {
  namespace = "Merchantflo/${var.environment}"

  # Must equal OPS_METRIC_NAMES in src/ops/metrics.ts (test/ops/infra.test.ts checks).
  ops_metrics = [
    "restrictedWindowExecutions",
    "noticeFailures",
    "debitBacklog",
    "pollerBacklog",
    "pollerOldestOverdueSeconds",
    "webhookBacklog",
    "deadWebhooks24h",
    "reconFailures24h",
    "pspCircuitsOpen",
    "executionPausesActive",
    "workerHeartbeat",
  ]

  ops_alarms = {
    "restricted-window-execution" = {
      metric      = "restrictedWindowExecutions", comparison = "GreaterThanThreshold", threshold = 0
      period      = 60, evaluations = 1, missing = "notBreaching", severity = "critical"
      description = "An AutoPay debit was executed inside an NPCI peak or blackout window. Must never happen."
    }
    "notice-failures" = {
      metric      = "noticeFailures", comparison = "GreaterThanOrEqualToThreshold", threshold = var.notice_failures_threshold
      period      = 300, evaluations = 1, missing = "notBreaching", severity = "high"
      description = "Pre-debit notices are being refused by a PSP; those debits cannot execute on time."
    }
    "debit-backlog" = {
      metric      = "debitBacklog", comparison = "GreaterThanThreshold", threshold = 0
      period      = 300, evaluations = 3, missing = "notBreaching", severity = "high"
      description = "Debits due 5+ minutes ago are not being picked up, or executions are stuck in flight, for 15 minutes."
    }
    "poller-overdue" = {
      metric      = "pollerOldestOverdueSeconds", comparison = "GreaterThanThreshold", threshold = var.poller_overdue_seconds_threshold
      period      = 300, evaluations = 2, missing = "notBreaching", severity = "high"
      description = "Payment status checks are running late: pending payments are not being confirmed."
    }
    "webhook-backlog" = {
      metric      = "webhookBacklog", comparison = "GreaterThanThreshold", threshold = var.webhook_backlog_threshold
      period      = 300, evaluations = 3, missing = "notBreaching", severity = "high"
      description = "Merchant webhooks are piling up undelivered for 15 minutes."
    }
    "dead-webhooks" = {
      metric      = "deadWebhooks24h", comparison = "GreaterThanThreshold", threshold = var.dead_webhooks_threshold
      period      = 300, evaluations = 1, missing = "notBreaching", severity = "medium"
      description = "Webhooks exhausted their retries in the last 24 hours; a merchant missed events."
    }
    "recon-failures" = {
      metric      = "reconFailures24h", comparison = "GreaterThanThreshold", threshold = 0
      period      = 300, evaluations = 1, missing = "notBreaching", severity = "medium"
      description = "A daily settlement reconciliation failed in the last 24 hours."
    }
    "psp-circuit-open" = {
      metric      = "pspCircuitsOpen", comparison = "GreaterThanOrEqualToThreshold", threshold = 1
      period      = 300, evaluations = 2, missing = "notBreaching", severity = "high"
      description = "A PSP circuit has been open for 10 minutes: its technical declines are high and traffic is failing over."
    }
    "execution-paused" = {
      metric      = "executionPausesActive", comparison = "GreaterThanOrEqualToThreshold", threshold = 1
      period      = 300, evaluations = 6, missing = "notBreaching", severity = "medium"
      description = "A kill-switch pause has been in force for 30 minutes. Make sure it is still meant to be (ops console → Pauses)."
    }
    "worker-heartbeat" = {
      metric      = "workerHeartbeat", comparison = "LessThanThreshold", threshold = 1
      period      = 120, evaluations = 3, missing = "breaching", severity = "critical"
      description = "No worker has reported for 6 minutes: debits, status checks and webhooks are not running."
    }
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = var.kms_key_arn
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alarm_emails)
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

# ─── Business signals from the worker's ops.metrics line ─────────────────────────────────────

resource "aws_cloudwatch_log_metric_filter" "ops" {
  for_each       = toset(local.ops_metrics)
  name           = "${var.name}-${each.value}"
  log_group_name = var.worker_log_group_name
  pattern        = "{ $.msg = \"ops.metrics\" }"

  metric_transformation {
    name      = each.value
    namespace = local.namespace
    value     = "$.${each.value}"
  }
}

resource "aws_cloudwatch_metric_alarm" "ops" {
  for_each            = local.ops_alarms
  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = "[${each.value.severity}] ${each.value.description} Runbook: docs/runbooks/alerts.md#${each.key}"
  namespace           = local.namespace
  metric_name         = each.value.metric
  statistic           = "Maximum"
  period              = each.value.period
  evaluation_periods  = each.value.evaluations
  datapoints_to_alarm = each.value.evaluations
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  treat_missing_data  = each.value.missing
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  depends_on = [aws_cloudwatch_log_metric_filter.ops]
}

# Any error-level log line (api or worker).
resource "aws_cloudwatch_log_metric_filter" "errors" {
  for_each       = toset(var.app_log_group_names)
  name           = "${var.name}-errors-${replace(each.value, "/", "-")}"
  log_group_name = each.value
  pattern        = "{ $.level = \"error\" }"

  metric_transformation {
    name          = "ErrorLogs"
    namespace     = local.namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${var.name}-error-logs"
  alarm_description   = "[medium] More than ${var.error_logs_threshold} error log lines in 5 minutes. Runbook: docs/runbooks/alerts.md#error-logs"
  namespace           = local.namespace
  metric_name         = "ErrorLogs"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.error_logs_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  depends_on          = [aws_cloudwatch_log_metric_filter.errors]
}

# ─── Load balancer ───────────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  alarm_description   = "[high] The API answered more than ${var.api_5xx_threshold} 5xx responses in 5 minutes. Runbook: docs/runbooks/alerts.md#api-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.api_5xx_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_elb_5xx" {
  alarm_name          = "${var.name}-lb-5xx"
  alarm_description   = "[high] The load balancer itself returned 5xx (no healthy target, timeouts). Runbook: docs/runbooks/alerts.md#lb-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.api_5xx_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  alarm_name          = "${var.name}-api-latency-p95"
  alarm_description   = "[medium] API p95 latency above ${var.api_p95_latency_seconds}s for 15 minutes. Runbook: docs/runbooks/alerts.md#api-latency-p95"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.api_p95_latency_seconds
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_no_healthy" {
  alarm_name          = "${var.name}-api-no-healthy-targets"
  alarm_description   = "[critical] No API task is passing /readyz: the API is down. Runbook: docs/runbooks/alerts.md#api-no-healthy-targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy" {
  alarm_name          = "${var.name}-api-unhealthy-targets"
  alarm_description   = "[medium] An API task has been failing /readyz for 5 minutes. Runbook: docs/runbooks/alerts.md#api-unhealthy-targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ─── ECS ─────────────────────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "running_tasks" {
  for_each = {
    api    = { service = var.api_service_name, desired = var.api_min_count }
    worker = { service = var.worker_service_name, desired = var.worker_count }
  }
  alarm_name          = "${var.name}-${each.key}-tasks-below-desired"
  alarm_description   = "[high] Fewer ${each.key} tasks running than the minimum (${each.value.desired}) for 5 minutes. Runbook: docs/runbooks/alerts.md#tasks-below-desired"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = each.value.service }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  comparison_operator = "LessThanThreshold"
  threshold           = each.value.desired
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ─── Database ────────────────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "db" {
  for_each = {
    cpu = {
      metric      = "CPUUtilization", statistic = "Average", comparison = "GreaterThanThreshold", threshold = 80, evaluations = 3
      description = "[medium] Database CPU above 80% for 15 minutes."
    }
    "free-storage" = {
      metric      = "FreeStorageSpace", statistic = "Minimum", comparison = "LessThanThreshold", threshold = var.db_free_storage_bytes_threshold, evaluations = 1
      description = "[high] Database free storage below ${floor(var.db_free_storage_bytes_threshold / 1073741824)} GiB (autoscaling may be at its ceiling)."
    }
    "freeable-memory" = {
      metric      = "FreeableMemory", statistic = "Minimum", comparison = "LessThanThreshold", threshold = 268435456, evaluations = 3
      description = "[medium] Database freeable memory below 256 MiB for 15 minutes."
    }
    connections = {
      metric      = "DatabaseConnections", statistic = "Maximum", comparison = "GreaterThanThreshold", threshold = var.db_connections_threshold, evaluations = 2
      description = "[medium] Database connections above ${var.db_connections_threshold} for 10 minutes."
    }
  }
  alarm_name          = "${var.name}-db-${each.key}"
  alarm_description   = "${each.value.description} Runbook: docs/runbooks/alerts.md#db-${each.key}"
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  dimensions          = { DBInstanceIdentifier = var.db_instance_id }
  statistic           = each.value.statistic
  period              = 300
  evaluation_periods  = each.value.evaluations
  datapoints_to_alarm = each.value.evaluations
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  treat_missing_data  = "missing"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ─── Dashboard ───────────────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name
  dashboard_body = jsonencode({
    widgets = concat(
      [for i, m in local.ops_metrics : {
        type   = "metric"
        x      = (i % 4) * 6
        y      = floor(i / 4) * 6
        width  = 6
        height = 6
        properties = {
          title   = m
          region  = var.region
          stat    = "Maximum"
          period  = 60
          view    = "timeSeries"
          metrics = [[local.namespace, m]]
        }
      }],
      [
        {
          type = "metric", x = 0, y = 18, width = 12, height = 6
          properties = {
            title = "API requests and 5xx", region = var.region, stat = "Sum", period = 60, view = "timeSeries"
            metrics = [
              ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix],
              ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.alb_arn_suffix, "TargetGroup", var.target_group_arn_suffix],
              ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", var.alb_arn_suffix],
            ]
          }
        },
        {
          type = "metric", x = 12, y = 18, width = 12, height = 6
          properties = {
            title = "API latency", region = var.region, period = 60, view = "timeSeries"
            metrics = [
              ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix, "TargetGroup", var.target_group_arn_suffix, { stat = "p50" }],
              ["...", { stat = "p95" }],
              ["...", { stat = "p99" }],
            ]
          }
        },
        {
          type = "metric", x = 0, y = 24, width = 12, height = 6
          properties = {
            title = "Database", region = var.region, stat = "Average", period = 300, view = "timeSeries"
            metrics = [
              ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.db_instance_id],
              ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", var.db_instance_id, { yAxis = "right" }],
            ]
          }
        },
        {
          type = "metric", x = 12, y = 24, width = 12, height = 6
          properties = {
            title = "ECS CPU", region = var.region, stat = "Average", period = 60, view = "timeSeries"
            metrics = [
              ["AWS/ECS", "CPUUtilization", "ClusterName", var.cluster_name, "ServiceName", var.api_service_name],
              ["AWS/ECS", "CPUUtilization", "ClusterName", var.cluster_name, "ServiceName", var.worker_service_name],
            ]
          }
        },
      ],
    )
  })
}
