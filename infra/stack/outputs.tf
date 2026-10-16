output "alb_dns_name" {
  description = "Point the API hostname here (CNAME, or an alias record with alb_zone_id)."
  value       = module.edge.alb_dns_name
}

output "alb_zone_id" {
  value = module.edge.alb_zone_id
}

output "cluster_name" {
  value = module.service.cluster_name
}

output "services" {
  value = { api = module.service.api_service_name, worker = module.service.worker_service_name }
}

output "task_families" {
  value = module.service.task_families
}

output "db_instance_id" {
  value = module.data.db_instance_id
}

output "db_subnet_group_name" {
  description = "For restore drills (scripts/drills/restore-drill.sh)."
  value       = module.data.db_subnet_group_name
}

output "db_security_group_id" {
  value = aws_security_group.db.id
}

output "alarm_topic_arn" {
  value = module.monitoring.alarm_topic_arn
}

output "dashboard" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${module.monitoring.dashboard_name}"
}

output "db_parameter_group_name" {
  value = module.data.db_parameter_group_name
}
