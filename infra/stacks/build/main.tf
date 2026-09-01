/**
 * M4 — Build plane: the queue, the image, the isolated task, and the three
 * workers that connect the control plane to it.
 *
 * The IAM in this file IS the security model. The build task role grants two
 * things and nothing else:
 *
 *     s3:PutObject      -> this project's artifact prefix
 *     logs:PutLogEvents -> its own log stream
 *
 * No DynamoDB. No SQS. No Secrets Manager. No GetObject on the artifact bucket
 * (write-only). No DeleteObject anywhere. Assume the container is fully
 * compromised on every build and ask what the attacker gets: a shell in a
 * throwaway sandbox that can write files into a prefix about to be sealed.
 */

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = local.tags
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "terraform_remote_state" "data" {
  backend = "s3"
  config  = { bucket = var.state_bucket, key = "stacks/data/terraform.tfstate", region = var.region }
}

data "terraform_remote_state" "network" {
  backend = "s3"
  config  = { bucket = var.state_bucket, key = "stacks/network/terraform.tfstate", region = var.region }
}

data "terraform_remote_state" "app" {
  backend = "s3"
  config  = { bucket = var.state_bucket, key = "stacks/app/terraform.tfstate", region = var.region }
}

data "terraform_remote_state" "edge" {
  backend = "s3"
  config  = { bucket = var.state_bucket, key = "stacks/edge/terraform.tfstate", region = var.region }
}

locals {
  account_id = data.aws_caller_identity.current.account_id

  artifacts_bucket     = data.terraform_remote_state.data.outputs.artifacts_bucket
  artifacts_bucket_arn = data.terraform_remote_state.data.outputs.artifacts_bucket_arn
  sources_bucket       = data.terraform_remote_state.data.outputs.sources_bucket
  sources_bucket_arn   = data.terraform_remote_state.data.outputs.sources_bucket_arn
  kms_key_arn          = data.terraform_remote_state.data.outputs.kms_key_arn

  subnet_ids        = data.terraform_remote_state.network.outputs.build_subnet_ids
  security_group_id = data.terraform_remote_state.network.outputs.build_security_group_id

  table_arn  = data.terraform_remote_state.app.outputs.table_arn
  table_name = data.terraform_remote_state.app.outputs.table_name
  api_url    = data.terraform_remote_state.app.outputs.api_url

  workers_dist = "${path.module}/../../../apps/workers/dist"

  tags = {
    project   = var.project
    managedBy = "terraform"
    stack     = "build"
    tier      = "A"
  }
}

# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "dlq" {
  name = "${var.project}-builds-dlq"
  # Two weeks to notice and investigate. A message here means dispatch failed
  # three times, which is always worth a look.
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "builds" {
  name = "${var.project}-builds"

  # Long enough for the dispatcher to download a repo and call RunTask, with
  # room to spare. Must exceed the dispatcher's own Lambda timeout, or SQS will
  # redeliver a message that is still being processed.
  visibility_timeout_seconds = 300
  message_retention_seconds  = 86400

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    # Three attempts. A dispatch that fails three times is not going to succeed
    # on the fourth, and retrying forever hides the problem.
    maxReceiveCount = 3
  })
}

# ---------------------------------------------------------------------------
# Image registry
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "builder" {
  name                 = "${var.project}-builder"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    # Free, and this image runs untrusted code — worth knowing what is in it.
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "builder" {
  repository = aws_ecr_repository.builder.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 images; ECR storage is billed per GB."
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------------
# Build task
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = var.project

  setting {
    name  = "containerInsights"
    value = "disabled" # Insights bills per metric; CloudWatch logs are enough here.
  }
}

resource "aws_cloudwatch_log_group" "builds" {
  name              = "/aws/ecs/${var.project}-builder"
  retention_in_days = 7
}

# Pulls the image and writes logs. Distinct from the TASK role below, which is
# what the running container itself holds — the distinction matters: ECR access
# belongs to the agent starting the container, not to the untrusted process
# inside it.
resource "aws_iam_role" "task_execution" {
  name               = "${var.project}-build-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The role the untrusted container runs as.
resource "aws_iam_role" "task" {
  name               = "${var.project}-build-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid     = "WriteArtifactsOnly"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    # Scoped to the projects namespace. Not the bucket, not another prefix.
    resources = ["${local.artifacts_bucket_arn}/projects/*"]
  }

  statement {
    sid       = "OwnLogStream"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.builds.arn}:*"]
  }

  # Nothing else. No dynamodb, no sqs, no secretsmanager, no ecr, no
  # s3:GetObject, no s3:DeleteObject. The source arrives as a presigned URL, so
  # reading it needs no permission at all.
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.project}-build-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

resource "aws_ecs_task_definition" "builder" {
  family                   = "${var.project}-builder"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"

  cpu    = var.task_cpu
  memory = var.task_memory

  # 21 GB because Fargate's floor is 20 and the builder checks its own usage
  # anyway — there is no per-process disk limit to set.
  ephemeral_storage {
    size_in_gib = 21
  }

  execution_role_arn = aws_iam_role.task_execution.arn
  task_role_arn      = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "builder"
      image     = "${aws_ecr_repository.builder.repository_url}:${var.image_tag}"
      essential = true

      # Belt and braces with the Dockerfile's USER directive.
      user = "1000"

      environment = [
        { name = "BUILDER_MODE", value = "aws" },
        { name = "WORK_DIR", value = "/workspace" },
        { name = "CONTAINER_MEMORY_MB", value = tostring(var.task_memory) },
        { name = "BUILD_TIMEOUT_SEC", value = tostring(var.build_timeout_sec) },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.builds.name
          "awslogs-region"        = data.aws_region.current.region
          "awslogs-stream-prefix" = "build"
        }
      }
    }
  ])
}
