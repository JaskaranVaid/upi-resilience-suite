output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}

output "ecr_repository_url" {
  description = "Set as the GitHub repository variable ECR_REPOSITORY."
  value       = aws_ecr_repository.app.repository_url
}

output "build_role_arn" {
  description = "Set as the GitHub repository variable AWS_BUILD_ROLE_ARN."
  value       = aws_iam_role.build.arn
}

output "deploy_role_arns" {
  description = "Set each as the variable AWS_DEPLOY_ROLE_ARN of the GitHub environment with the same name."
  value       = { for env, role in aws_iam_role.deploy : env => role.arn }
}
