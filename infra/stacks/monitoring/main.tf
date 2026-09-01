/**
 * M7 — Monitoring.
 *
 * A separate stack because it is purely observational: destroying it breaks
 * nothing, and it can be rebuilt from scratch at any time.
 *
 * Alarms are chosen on one rule — would this wake someone up, and would they be
 * able to act on it? A "deployments happened" alarm fails that test. The four
 * below are all things that mean something is broken and nothing else will say
 * so, which is why the sweeper and reconciler alarms matter most: those are the
 * failures whose entire symptom is silence.
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

locals {
  namespace = "DeploymentPlatform"

  api_fn        = "${var.project}-api"
  dispatcher_fn = "${var.project}-dispatcher"
  reconciler_fn = "${var.project}-reconciler"
  sweeper_fn    = "${var.project}-sweeper"

  queue     = "${var.project}-builds"
  dlq       = "${var.project}-builds-dlq"
  table     = var.project
  log_group = "/aws/ecs/${var.project}-builder"

  tags = {
    project   = var.project
    managedBy = "terraform"
    stack     = "monitoring"
    tier      = "A"
  }
}

# ---------------------------------------------------------------------------
# Where alarms go
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "${var.project}-operational-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alert_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---------------------------------------------------------------------------
# Alarms
# ---------------------------------------------------------------------------

# Anything here means dispatch failed three times. Always worth a look, and
# nothing else reports it.
resource "aws_cloudwatch_metric_alarm" "dlq" {
  alarm_name          = "${var.project}-dlq-not-empty"
  alarm_description   = "A build message failed dispatch three times and landed in the DLQ."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = local.dlq }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# The sweeper only fails deployments that died leaving no trace at all. One is
# noise; several in an hour means builds are dying silently.
resource "aws_cloudwatch_metric_alarm" "swept" {
  alarm_name          = "${var.project}-deployments-stuck"
  alarm_description   = "The sweeper is failing deployments that died without reporting."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "SweptDeployments"
  namespace           = local.namespace
  period              = 3600
  statistic           = "Sum"
  threshold           = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Distinct from a build that fails honestly: this counts containers that DIED,
# which points at the platform rather than at anyone's code.
resource "aws_cloudwatch_metric_alarm" "reconciled" {
  alarm_name          = "${var.project}-tasks-dying"
  alarm_description   = "Build containers are dying without reporting (OOM, capacity, external stop)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ReconciledFailures"
  namespace           = local.namespace
  period              = 3600
  statistic           = "Sum"
  threshold           = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# A Lambda that throws is a bug in this codebase, not a user error — user errors
# are returned as 4xx and never reach here.
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = toset([local.api_fn, local.dispatcher_fn, local.reconciler_fn, local.sweeper_fn])

  alarm_name          = "${each.value}-errors"
  alarm_description   = "${each.value} is throwing."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 2
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = each.value }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# A queue that stops draining means the dispatcher is stuck or throttled.
resource "aws_cloudwatch_metric_alarm" "queue_backlog" {
  alarm_name          = "${var.project}-queue-backlog"
  alarm_description   = "Builds are queued but not being picked up."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 900
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = local.queue }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = var.project

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "text", x = 0, y = 0, width = 24, height = 2
        properties = {
          markdown = join("\n", [
            "# ${var.project}",
            "Deployment outcomes and build latency on the left; the failure modes that are otherwise silent on the right.",
          ])
        }
      },

      {
        type = "metric", x = 0, y = 2, width = 12, height = 6
        properties = {
          title  = "Deployment outcomes"
          view   = "timeSeries"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            [local.namespace, "DeploymentOutcome", "Outcome", "DEPLOYED", { label = "deployed", color = "#2ca02c" }],
            [".", ".", ".", "FAILED", { label = "failed", color = "#d62728" }],
          ]
        }
      },

      {
        type = "metric", x = 12, y = 2, width = 12, height = 6
        properties = {
          title  = "Build duration"
          view   = "timeSeries"
          region = var.region
          period = 300
          # p50 and p95 rather than an average: an average hides the slow tail,
          # and the tail is what people notice.
          metrics = [
            [local.namespace, "BuildDurationMs", "Outcome", "DEPLOYED", { label = "p50", stat = "p50" }],
            ["...", { label = "p95", stat = "p95" }],
          ]
        }
      },

      {
        type = "metric", x = 0, y = 8, width = 8, height = 6
        properties = {
          title  = "Silent failures (should be flat at zero)"
          view   = "timeSeries"
          region = var.region
          stat   = "Sum"
          period = 3600
          metrics = [
            [local.namespace, "SweptDeployments", { label = "swept (vanished)" }],
            [local.namespace, "ReconciledFailures", { label = "died without reporting" }],
          ]
        }
      },

      {
        type = "metric", x = 8, y = 8, width = 8, height = 6
        properties = {
          title  = "Queue"
          view   = "timeSeries"
          region = var.region
          period = 300
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", local.queue, { label = "waiting", stat = "Maximum" }],
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", local.queue, { label = "oldest (s)", stat = "Maximum" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", local.dlq, { label = "DLQ", stat = "Maximum", color = "#d62728" }],
          ]
        }
      },

      {
        type = "metric", x = 16, y = 8, width = 8, height = 6
        properties = {
          title  = "Lambda errors"
          view   = "timeSeries"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/Lambda", "Errors", "FunctionName", local.api_fn, { label = "api" }],
            ["...", local.dispatcher_fn, { label = "dispatcher" }],
            ["...", local.reconciler_fn, { label = "reconciler" }],
            ["...", local.sweeper_fn, { label = "sweeper" }],
          ]
        }
      },

      {
        type = "metric", x = 0, y = 14, width = 12, height = 6
        properties = {
          title  = "API latency and traffic"
          view   = "timeSeries"
          region = var.region
          period = 300
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", local.api_fn, { label = "requests", stat = "Sum" }],
            ["AWS/Lambda", "Duration", "FunctionName", local.api_fn, { label = "p95 ms", stat = "p95", yAxis = "right" }],
          ]
        }
      },

      {
        type = "metric", x = 12, y = 14, width = 12, height = 6
        properties = {
          title  = "DynamoDB"
          view   = "timeSeries"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", local.table, { label = "reads" }],
            ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", local.table, { label = "writes" }],
            # Conditional-check failures are EXPECTED here — every duplicate
            # dispatch produces one. A spike still tells you something changed.
            ["AWS/DynamoDB", "ConditionalCheckFailedRequests", "TableName", local.table, { label = "lost races" }],
          ]
        }
      },

      {
        type = "log", x = 0, y = 20, width = 24, height = 6
        properties = {
          title  = "Recent build failures"
          region = var.region
          query = join(" | ", [
            "SOURCE '${local.log_group}'",
            "fields @timestamp, deploymentId, msg, code",
            "filter level = 'error'",
            "sort @timestamp desc",
            "limit 20",
          ])
        }
      },
    ]
  })
}
