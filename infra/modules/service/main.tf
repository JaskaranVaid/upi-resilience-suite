# ECS Fargate: one image, three task definitions (api, worker, migrate) and two services.
#
# Terraform creates the task definitions and services; the deploy pipeline
# (scripts/deploy/ecs-deploy.sh) registers new revisions from the latest one with a new image, so
# the services ignore task_definition changes here. A Terraform change to variables or secrets
# reaches running tasks at the next deploy.

data "aws_region" "current" {}

locals {
  region = data.aws_region.current.region

  secrets = [for k, arn in var.secret_arns : { name = k, valueFrom = arn }]

  roles = {
    api = {
      cpu          = var.api_cpu
      memory       = var.api_memory
      stop_timeout = 30 # SHUTDOWN_DRAIN_MS + in-flight requests
    }
    worker = {
      cpu          = var.worker_cpu
      memory       = var.worker_memory
      stop_timeout = 120 # Fargate's maximum: let the current tick finish its PSP calls
    }
    migrate = {
      cpu          = 256
      memory       = 512
      stop_timeout = 30
    }
  }
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_cloudwatch_log_group" "role" {
  for_each          = local.roles
  name              = "/merchantflo/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

# ─── IAM ─────────────────────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Used by ECS to start tasks: pull the image, read the secrets, write logs.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-app-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = values(var.secret_arns) },
      { Effect = "Allow", Action = "kms:Decrypt", Resource = var.kms_key_arn },
    ]
  })
}

# The application's own identity. It calls no AWS APIs today; permissions attach here when it does.
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# ─── Task definitions ────────────────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "role" {
  for_each                 = local.roles
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  # The root filesystem is read-only; the worker's heartbeat file goes to this scratch volume.
  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name                   = "app"
    image                  = var.image
    essential              = true
    readonlyRootFilesystem = true
    stopTimeout            = each.value.stop_timeout
    linuxParameters        = { initProcessEnabled = true } # signals reach node; zombies are reaped
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    portMappings           = each.key == "api" ? [{ containerPort = var.container_port, protocol = "tcp" }] : []
    environment = [
      for k, v in merge(var.environment_variables, { ROLE = each.key, PORT = tostring(var.container_port) }) : { name = k, value = v }
    ]
    secrets = local.secrets
    healthCheck = each.key == "migrate" ? null : {
      command     = ["CMD", "node", "dist/ops/healthcheck.js"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.role[each.key].name
        awslogs-region        = local.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

# ─── Services ────────────────────────────────────────────────────────────────────────────────

resource "aws_ecs_service" "api" {
  name                              = "${var.name}-api"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.role["api"].arn
  desired_count                     = var.api_min_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  propagate_tags                    = "SERVICE"
  enable_execute_command            = false

  # Rolling deploy: new tasks become healthy before old ones stop; a deploy that cannot get
  # healthy tasks rolls back by itself.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "app"
    container_port   = var.container_port
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count] # owned by the deploy pipeline and autoscaling
  }
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.role["worker"].arn
  desired_count   = var.worker_count
  launch_type     = "FARGATE"
  propagate_tags  = "SERVICE"

  # Workers claim work with FOR UPDATE SKIP LOCKED, so old and new tasks may overlap safely.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}

# ─── API autoscaling ─────────────────────────────────────────────────────────────────────────

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_min_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
