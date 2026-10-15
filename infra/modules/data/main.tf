# RDS PostgreSQL and the application secrets. Everything is encrypted with the environment's KMS
# key; the containers receive secrets from Secrets Manager at start (never as plain variables).
#
# Generated secrets live in Terraform state too: the state bucket is KMS-encrypted, versioned and
# limited to founders (infra/README.md).

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
    random = {
      source = "hashicorp/random"
    }
  }
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.db_subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-pg${var.engine_major_version}"
  family = "postgres${var.engine_major_version}"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    # Slow queries in the postgresql log (exported to CloudWatch).
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name  = "log_lock_waits"
    value = "1"
  }
  parameter {
    # A crashed request must not hold row locks the worker's SKIP LOCKED queue would skip forever.
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
}

resource "random_password" "db" {
  length  = 40
  special = false # used inside a URL
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.engine_major_version
  instance_class = var.instance_class

  db_name  = "merchantflo"
  username = "merchantflo"
  password = random_password.db.result

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.db_security_group_id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.this.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  # Point-in-time recovery inside India; windows in UTC = 02:00–03:00 and Sun 03:30 IST, off-peak.
  backup_retention_period   = var.backup_retention_days
  backup_window             = "20:30-21:30"
  maintenance_window        = "sun:22:00-sun:23:00"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "${var.name}-final" : null

  auto_minor_version_upgrade            = true
  allow_major_version_upgrade           = false
  apply_immediately                     = false
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
}

# ─── Application secrets ─────────────────────────────────────────────────────────────────────

resource "random_password" "admin_token" {
  length  = 48
  special = false
}

resource "random_password" "customer_token_secret" {
  length  = 64
  special = false
}

resource "random_bytes" "credentials_key" {
  length = 32
}

locals {
  secrets = {
    # sslmode=verify-full checks the server certificate against the RDS CA bundle baked into the image.
    DATABASE_URL          = "postgres://${aws_db_instance.this.username}:${random_password.db.result}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${aws_db_instance.this.db_name}?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem"
    ADMIN_TOKEN           = random_password.admin_token.result
    CUSTOMER_TOKEN_SECRET = random_password.customer_token_secret.result
    CREDENTIALS_KEYS      = "k1:${random_bytes.credentials_key.base64}"
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = local.secrets
  name                    = "${var.name}/${each.key}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.deletion_protection ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "app" {
  for_each      = local.secrets
  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = each.value

  lifecycle {
    # Rotations (a new key in CREDENTIALS_KEYS, a new admin token) happen through the runbook, in
    # Secrets Manager; Terraform sets the first value only.
    ignore_changes = [secret_string]
  }
}
