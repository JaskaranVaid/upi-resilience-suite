# Merchantflo staging. Apply: terraform -chdir=infra/envs/staging init && terraform -chdir=infra/envs/staging apply
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
    key          = "staging/terraform.tfstate"
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
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

variable "image_tag" {
  description = "Git commit of an image in ECR, used for the first task definitions."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate (ap-south-1) for api.staging.merchantflo.in."
  type        = string
}

variable "alarm_emails" {
  type    = list(string)
  default = []
}

module "stack" {
  source = "../../stack"

  environment     = "staging"
  image_tag       = var.image_tag
  public_base_url = "https://api.staging.merchantflo.in"
  certificate_arn = var.certificate_arn
  alarm_emails    = var.alarm_emails

  vpc_cidr           = "10.20.0.0/16"
  single_nat_gateway = true

  db_instance_class           = "db.t4g.small"
  db_allocated_storage_gb     = 20
  db_max_allocated_storage_gb = 100
  db_multi_az                 = false
  db_backup_retention_days    = 7
  deletion_protection         = true

  api_cpu       = 512
  api_memory    = 1024
  api_min_count = 2
  api_max_count = 4
  worker_cpu    = 512
  worker_memory = 1024
  worker_count  = 1

  log_retention_days = 30
  allow_mock_psps    = true
}

output "stack" {
  value = module.stack
}
