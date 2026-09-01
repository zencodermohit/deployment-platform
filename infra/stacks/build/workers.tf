/**
 * The three workers.
 *
 * Separate functions, unlike the API's routes (ADR-0010), because these have
 * genuinely different triggers AND genuinely different permissions. Only the
 * dispatcher may run ECS tasks or read GitHub; the sweeper only reads an index
 * and writes state. That is exactly when splitting buys real isolation.
 */

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Every worker reads and writes deployment state.
data "aws_iam_policy_document" "table_access" {
  statement {
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [local.table_arn, "${local.table_arn}/index/*"]
  }
  statement {
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [local.kms_key_arn]
  }
}

locals {
  workers = {
    dispatcher = { timeout = 180, memory = 512 }
    reconciler = { timeout = 30, memory = 256 }
    sweeper    = { timeout = 60, memory = 256 }
  }
}

data "archive_file" "worker" {
  for_each = local.workers

  type        = "zip"
  output_path = "${path.module}/.terraform/${each.key}.zip"
  source_file = "${local.workers_dist}/${each.key}.mjs"
}

resource "aws_cloudwatch_log_group" "worker" {
  for_each = local.workers

  name              = "/aws/lambda/${var.project}-${each.key}"
  retention_in_days = 7
}

resource "aws_iam_role" "worker" {
  for_each = local.workers

  name               = "${var.project}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "worker_table" {
  for_each = local.workers

  name   = "table"
  role   = aws_iam_role.worker[each.key].id
  policy = data.aws_iam_policy_document.table_access.json
}

resource "aws_iam_role_policy" "worker_logs" {
  for_each = local.workers

  name = "logs"
  role = aws_iam_role.worker[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.worker[each.key].arn}:*"
    }]
  })
}

resource "aws_lambda_function" "worker" {
  for_each = local.workers

  function_name = "${var.project}-${each.key}"
  role          = aws_iam_role.worker[each.key].arn

  filename         = data.archive_file.worker[each.key].output_path
  source_code_hash = data.archive_file.worker[each.key].output_base64sha256

  runtime = "nodejs22.x"
  handler = "${each.key}.handler"
  timeout = each.value.timeout

  memory_size = each.value.memory

  environment {
    variables = {
      TABLE_NAME        = local.table_name
      SOURCES_BUCKET    = local.sources_bucket
      ARTIFACTS_BUCKET  = local.artifacts_bucket
      ECS_CLUSTER       = aws_ecs_cluster.main.name
      TASK_DEFINITION   = aws_ecs_task_definition.builder.family
      SUBNET_IDS        = join(",", local.subnet_ids)
      SECURITY_GROUP_ID = local.security_group_id
      API_URL           = local.api_url
      BUILD_TIMEOUT_SEC = tostring(var.build_timeout_sec)
      MAX_ARCHIVE_BYTES = tostring(var.max_archive_bytes)
    }
  }

  depends_on = [aws_cloudwatch_log_group.worker]
}

# ---------------------------------------------------------------------------
# Dispatcher — the only worker that can start a build or stage source
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "dispatcher" {
  statement {
    sid       = "ConsumeBuildQueue"
    effect    = "Allow"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.builds.arn]
  }

  statement {
    sid       = "StageSource"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${local.sources_bucket_arn}/sources/*"]
  }

  statement {
    sid       = "EncryptSource"
    effect    = "Allow"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
    resources = [local.kms_key_arn]
  }

  statement {
    sid       = "StartBuilds"
    effect    = "Allow"
    actions   = ["ecs:RunTask"]
    resources = ["${aws_ecs_task_definition.builder.arn_without_revision}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  # RunTask needs permission to hand the task its roles. Scoped to exactly those
  # two roles: without the condition this would be a privilege-escalation path,
  # letting the dispatcher run a task as any role in the account.
  statement {
    sid       = "PassBuildRolesOnly"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.task.arn, aws_iam_role.task_execution.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "dispatcher" {
  name   = "dispatch"
  role   = aws_iam_role.worker["dispatcher"].id
  policy = data.aws_iam_policy_document.dispatcher.json
}

resource "aws_lambda_event_source_mapping" "builds" {
  event_source_arn = aws_sqs_queue.builds.arn
  function_name    = aws_lambda_function.worker["dispatcher"].arn

  # One at a time. Each message starts a Fargate task, and batching would mean
  # one failure retrying work that already succeeded.
  batch_size = 1

  # Hard ceiling on how many builds can run at once — the primary bound on how
  # fast a runaway could spend money (threat T8).
  scaling_config {
    maximum_concurrency = var.max_concurrent_builds
  }
}

# ---------------------------------------------------------------------------
# Reconciler — notices tasks that die without reporting
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "task_stopped" {
  name        = "${var.project}-task-stopped"
  description = "Build tasks that reached STOPPED"

  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    "detail-type" = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.main.arn]
      lastStatus = ["STOPPED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "reconciler" {
  rule = aws_cloudwatch_event_rule.task_stopped.name
  arn  = aws_lambda_function.worker["reconciler"].arn
}

resource "aws_lambda_permission" "reconciler" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.worker["reconciler"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.task_stopped.arn
}

# ---------------------------------------------------------------------------
# Sweeper — catches what leaves no trace at all
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "sweep" {
  name                = "${var.project}-sweep"
  description         = "Fail deployments stuck past their deadline"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "sweeper" {
  rule = aws_cloudwatch_event_rule.sweep.name
  arn  = aws_lambda_function.worker["sweeper"].arn
}

resource "aws_lambda_permission" "sweeper" {
  statement_id  = "AllowSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.worker["sweeper"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sweep.arn
}

# ---------------------------------------------------------------------------
# Alarms
# ---------------------------------------------------------------------------

# Anything in the DLQ means dispatch failed three times. Always worth a look.
resource "aws_cloudwatch_metric_alarm" "dlq" {
  alarm_name          = "${var.project}-dlq-not-empty"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = { QueueName = aws_sqs_queue.dlq.name }
}
