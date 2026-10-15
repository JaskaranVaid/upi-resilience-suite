output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "alarm_name_prefix" {
  description = "Every alarm's name starts with this (scripts/drills/alarm-drill.sh)."
  value       = "${var.name}-"
}

output "dashboard_name" {
  value = aws_cloudwatch_dashboard.this.dashboard_name
}
