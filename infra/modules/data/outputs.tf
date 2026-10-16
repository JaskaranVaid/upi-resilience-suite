output "db_instance_id" {
  value = aws_db_instance.this.identifier
}

output "db_address" {
  value = aws_db_instance.this.address
}

output "db_subnet_group_name" {
  value = aws_db_subnet_group.this.name
}

output "db_parameter_group_name" {
  value = aws_db_parameter_group.this.name
}

output "secret_arns" {
  description = "Environment variable name → Secrets Manager ARN, injected into every container."
  value       = { for k, s in aws_secretsmanager_secret.app : k => s.arn }
}
