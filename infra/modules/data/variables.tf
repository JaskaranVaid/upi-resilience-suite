variable "name" {
  type = string
}

variable "db_subnet_ids" {
  type = list(string)
}

variable "db_security_group_id" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "engine_major_version" {
  type    = string
  default = "16"
}

variable "instance_class" {
  type = string
}

variable "allocated_storage_gb" {
  type = number
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
}

variable "multi_az" {
  type = bool
}

variable "backup_retention_days" {
  description = "Point-in-time recovery window (1–35 days)."
  type        = number
  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "RDS keeps automated backups for 1 to 35 days."
  }
}

variable "deletion_protection" {
  description = "Refuse to delete the database (and keep a final snapshot / 30-day secret recovery)."
  type        = bool
}
