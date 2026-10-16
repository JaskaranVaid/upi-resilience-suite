output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "task_families" {
  description = "Task definition families by role (api, worker, migrate)."
  value       = { for role, td in aws_ecs_task_definition.role : role => td.family }
}

output "log_group_names" {
  value = { for role, g in aws_cloudwatch_log_group.role : role => g.name }
}
