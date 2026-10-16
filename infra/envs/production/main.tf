# Merchantflo production. Apply: terraform -chdir=infra/envs/production init && terraform -chdir=infra/envs/production apply
# First apply needs an image already in ECR (-var image_tag=<commit>); see infra/README.md.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    bucket       = "merchantflo-terraform-state-ap-south-1"
    key          = "production/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "ap-south-1"
  default_tags {
    tags = {
      Project     = "merchantflo"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}

variable "image_tag" {
  description = "Git commit of an image in ECR, used for the first task definitions."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate (ap-south-1) for api.merchantflo.in."
  type        = string
}

variable "alarm_emails" {
  type    = list(string)
  default = []
}

module "stack" {
  source = "../../stack"

  environment     = "production"
  image_tag       = var.image_tag
  public_base_url = "https://api.merchantflo.in"
  certificate_arn = var.certificate_arn
  alarm_emails    = var.alarm_emails

  vpc_cidr           = "10.30.0.0/16"
  single_nat_gateway = false

  db_instance_class           = "db.m7g.large"
  db_allocated_storage_gb     = 100
  db_max_allocated_storage_gb = 500
  db_multi_az                 = true
  db_backup_retention_days    = 35
  deletion_protection         = true

  api_cpu       = 1024
  api_memory    = 2048
  api_min_count = 2
  api_max_count = 8
  worker_cpu    = 512
  worker_memory = 1024
  worker_count  = 2

  log_retention_days = 365
  allow_mock_psps    = false
}

output "stack" {
  value = module.stack
}
