variable "environment" {
  description = "dev, staging or production (also the GitHub environment that may deploy it)."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be dev, staging or production."
  }
}

variable "region" {
  description = "India only (RBI payment data storage)."
  type        = string
  default     = "ap-south-1"
  validation {
    condition     = contains(["ap-south-1", "ap-south-2"], var.region)
    error_message = "Payment data must stay in an Indian AWS region."
  }
}

variable "image_tag" {
  description = "Git commit of the image the task definitions start with (later images come from the deploy pipeline)."
  type        = string
}

variable "public_base_url" {
  description = "https URL of this environment's API, e.g. https://api.staging.merchantflo.in"
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate in this region covering the API hostname."
  type        = string
}

variable "alarm_emails" {
  type    = list(string)
  default = []
}

# ─── Sizing ──────────────────────────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  type = string
}

variable "single_nat_gateway" {
  type = bool
}

variable "db_instance_class" {
  type = string
}

variable "db_allocated_storage_gb" {
  type = number
}

variable "db_max_allocated_storage_gb" {
  type = number
}

variable "db_multi_az" {
  type = bool
}

variable "db_backup_retention_days" {
  type = number
}

variable "database_pool_max" {
  description = "Postgres connections per task. Keep tasks × pool under the instance's max_connections."
  type        = number
  default     = 10
}

variable "deletion_protection" {
  type = bool
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

variable "log_retention_days" {
  type = number
}

variable "waf_rate_limit_per_5_minutes" {
  type    = number
  default = 6000
}

variable "notice_failures_threshold" {
  type    = number
  default = 5
}

# ─── Application settings ────────────────────────────────────────────────────────────────────

variable "allow_mock_psps" {
  description = "Shared mock PSPs for test-mode merchants (dev/staging). Never in production."
  type        = bool
  default     = false
}

variable "mdr_effective_from" {
  description = "IST date the UPI MDR regime starts (YYYY-MM-DD); empty until NPCI confirms it."
  type        = string
  default     = ""
}

variable "extra_environment" {
  description = "More plain environment variables for every role (never secrets)."
  type        = map(string)
  default     = {}
}
