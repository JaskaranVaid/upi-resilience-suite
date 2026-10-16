variable "name" {
  type = string
}

variable "environment" {
  type = string
}

variable "image" {
  description = "Image for the first task definitions (ECR URL with a git-commit tag). Later images come from the deploy pipeline."
  type        = string
}

variable "app_subnet_ids" {
  type = list(string)
}

variable "app_security_group_id" {
  type = string
}

variable "target_group_arn" {
  type = string
}

variable "container_port" {
  type    = number
  default = 3000
}

variable "environment_variables" {
  description = "Plain (non-secret) environment for every role."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "Environment variable name → Secrets Manager ARN."
  type        = map(string)
}

variable "kms_key_arn" {
  type = string
}

variable "log_retention_days" {
  type = number
}

variable "api_cpu" {
  type = number
}

variable "api_memory" {
  type = number
}

variable "api_min_count" {
  type = number
}

variable "api_max_count" {
  type = number
}

variable "worker_cpu" {
  type = number
}

variable "worker_memory" {
  type = number
}

variable "worker_count" {
  type = number
}
