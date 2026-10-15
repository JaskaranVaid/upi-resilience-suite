variable "region" {
  description = "AWS region. India only (RBI payment data storage)."
  type        = string
  default     = "ap-south-1"
}

variable "state_bucket_name" {
  description = "S3 bucket for Terraform state (globally unique). The environments' backend blocks name it."
  type        = string
  default     = "merchantflo-terraform-state-ap-south-1"
}

variable "github_repository" {
  description = "owner/name of the GitHub repository whose workflows may build and deploy."
  type        = string
  default     = "JaskaranVaid/upi-resilience-suite"
}

variable "environments" {
  description = "Environments that get a deploy role (each must exist as a GitHub environment of the same name)."
  type        = list(string)
  default     = ["dev", "staging", "production"]
}
