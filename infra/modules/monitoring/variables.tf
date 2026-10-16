variable "name" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "kms_key_arn" {
  description = "Encrypts the alarm topic."
  type        = string
}

variable "alarm_emails" {
  description = "Addresses subscribed to alarms (each must confirm the subscription e-mail)."
  type        = list(string)
  default     = []
}

variable "worker_log_group_name" {
  type = string
}

variable "app_log_group_names" {
  description = "Log groups whose error-level lines are counted (api, worker)."
  type        = list(string)
}

variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffix" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "api_service_name" {
  type = string
}

variable "worker_service_name" {
  type = string
}

variable "api_min_count" {
  type = number
}

variable "worker_count" {
  type = number
}

variable "db_instance_id" {
  type = string
}

variable "notice_failures_threshold" {
  type    = number
  default = 5
}

variable "poller_overdue_seconds_threshold" {
  type    = number
  default = 900
}

variable "webhook_backlog_threshold" {
  type    = number
  default = 100
}

variable "dead_webhooks_threshold" {
  type    = number
  default = 0
}

variable "error_logs_threshold" {
  type    = number
  default = 10
}

variable "api_5xx_threshold" {
  type    = number
  default = 20
}

variable "api_p95_latency_seconds" {
  type    = number
  default = 1
}

variable "db_free_storage_bytes_threshold" {
  type    = number
  default = 5368709120 # 5 GiB
}

variable "db_connections_threshold" {
  type    = number
  default = 150
}
