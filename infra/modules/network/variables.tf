variable "name" {
  description = "Resource name prefix, e.g. merchantflo-staging."
  type        = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "cidr" {
  description = "VPC address range (/16)."
  type        = string
}

variable "az_count" {
  description = "Availability zones to span (ap-south-1 has three)."
  type        = number
  default     = 3
}

variable "single_nat_gateway" {
  description = "One NAT gateway for the VPC (cheaper; dev/staging) instead of one per zone (production)."
  type        = bool
}

variable "kms_key_arn" {
  description = "Key encrypting the flow-log group."
  type        = string
}

variable "log_retention_days" {
  type = number
}
