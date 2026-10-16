variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "certificate_arn" {
  description = "ACM certificate (in this region) for the API hostname."
  type        = string
}

variable "container_port" {
  type    = number
  default = 3000
}

variable "rate_limit_per_5_minutes" {
  description = "WAF: requests per client IP per 5 minutes before blocking (PSP webhooks exempt)."
  type        = number
  default     = 6000
}

variable "kms_key_arn" {
  type = string
}

variable "log_retention_days" {
  type = number
}

variable "access_log_retention_days" {
  type = number
}

variable "deletion_protection" {
  type = bool
}
