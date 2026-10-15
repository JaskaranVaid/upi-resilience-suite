# One Merchantflo environment (dev, staging or production): network, database and secrets, the
# load balancer and firewall, the ECS services, and monitoring. Sized by the variables each
# infra/envs/<environment> passes in.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name       = "merchantflo-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  image      = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com/merchantflo:${var.image_tag}"

  app_environment = merge(
    {
      NODE_ENV           = "production"
      PUBLIC_BASE_URL    = var.public_base_url
      TRUST_PROXY        = "1" # exactly one proxy (the load balancer) in front of the api
      WEBHOOK_TARGETS    = "public-only"
      MIGRATE_ON_START   = "false" # the deploy's migrate task applies migrations
      SHUTDOWN_DRAIN_MS  = "5000"
      DATABASE_POOL_MAX  = tostring(var.database_pool_max)
      MOCK_PSPS          = var.allow_mock_psps ? "pspA,pspB" : ""
      ALLOW_MOCK_PSPS    = var.allow_mock_psps ? "true" : "false"
      MDR_EFFECTIVE_FROM = var.mdr_effective_from
    },
    var.extra_environment,
  )
  # An empty MDR_EFFECTIVE_FROM would fail validation: leave it out until NPCI confirms a date.
  container_environment = { for k, v in local.app_environment : k => v if v != "" || k == "MOCK_PSPS" }
}

# ─── Encryption key for this environment's data and logs ─────────────────────────────────────

resource "aws_kms_key" "this" {
  description             = "${local.name}: database, secrets, logs, alarm topic"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.region}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = {
          ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${local.account_id}:log-group:*" }
        }
      },
      {
        # Alarms publishing to the encrypted SNS topic.
        Sid       = "CloudWatchAlarms"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "this" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.this.key_id
}

# ─── Security groups: internet → ALB → api tasks → database ──────────────────────────────────

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTPS to the load balancer"
  vpc_id      = module.network.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "Redirected to HTTPS"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "ECS tasks (api, worker, migrate)"
  vpc_id      = module.network.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "PSP APIs, merchant webhooks (https only in production), AWS APIs"
}

resource "aws_vpc_security_group_egress_rule" "app_to_db" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "PostgreSQL from the ECS tasks only"
  vpc_id      = module.network.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# ─── Modules ─────────────────────────────────────────────────────────────────────────────────

module "network" {
  source             = "../modules/network"
  name               = local.name
  environment        = var.environment
  region             = var.region
  cidr               = var.vpc_cidr
  single_nat_gateway = var.single_nat_gateway
  kms_key_arn        = aws_kms_key.this.arn
  log_retention_days = var.log_retention_days
}

module "data" {
  source                   = "../modules/data"
  name                     = local.name
  db_subnet_ids            = module.network.db_subnet_ids
  db_security_group_id     = aws_security_group.db.id
  kms_key_arn              = aws_kms_key.this.arn
  instance_class           = var.db_instance_class
  allocated_storage_gb     = var.db_allocated_storage_gb
  max_allocated_storage_gb = var.db_max_allocated_storage_gb
  multi_az                 = var.db_multi_az
  backup_retention_days    = var.db_backup_retention_days
  deletion_protection      = var.deletion_protection
}

module "edge" {
  source                    = "../modules/edge"
  name                      = local.name
  vpc_id                    = module.network.vpc_id
  public_subnet_ids         = module.network.public_subnet_ids
  alb_security_group_id     = aws_security_group.alb.id
  certificate_arn           = var.certificate_arn
  rate_limit_per_5_minutes  = var.waf_rate_limit_per_5_minutes
  kms_key_arn               = aws_kms_key.this.arn
  log_retention_days        = var.log_retention_days
  access_log_retention_days = var.log_retention_days
  deletion_protection       = var.deletion_protection
}

module "service" {
  source                = "../modules/service"
  name                  = local.name
  environment           = var.environment
  image                 = local.image
  app_subnet_ids        = module.network.app_subnet_ids
  app_security_group_id = aws_security_group.app.id
  target_group_arn      = module.edge.target_group_arn
  environment_variables = local.container_environment
  secret_arns           = module.data.secret_arns
  kms_key_arn           = aws_kms_key.this.arn
  log_retention_days    = var.log_retention_days
  api_cpu               = var.api_cpu
  api_memory            = var.api_memory
  api_min_count         = var.api_min_count
  api_max_count         = var.api_max_count
  worker_cpu            = var.worker_cpu
  worker_memory         = var.worker_memory
  worker_count          = var.worker_count
}

module "monitoring" {
  source                    = "../modules/monitoring"
  name                      = local.name
  environment               = var.environment
  region                    = var.region
  kms_key_arn               = aws_kms_key.this.arn
  alarm_emails              = var.alarm_emails
  worker_log_group_name     = module.service.log_group_names["worker"]
  app_log_group_names       = [module.service.log_group_names["api"], module.service.log_group_names["worker"]]
  alb_arn_suffix            = module.edge.alb_arn_suffix
  target_group_arn_suffix   = module.edge.target_group_arn_suffix
  cluster_name              = module.service.cluster_name
  api_service_name          = module.service.api_service_name
  worker_service_name       = module.service.worker_service_name
  api_min_count             = var.api_min_count
  worker_count              = var.worker_count
  db_instance_id            = module.data.db_instance_id
  notice_failures_threshold = var.notice_failures_threshold
}
