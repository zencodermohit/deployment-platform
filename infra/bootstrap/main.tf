/**
 * M0 — Bootstrap.
 *
 * Two jobs, both of which must exist before anything else and neither of which
 * can depend on remote state:
 *
 *   1. The S3 bucket that every other stack stores its state in.
 *   2. Spend guardrails.
 *
 * Chicken-and-egg: this stack creates the bucket that every stack stores state
 * in, including its own. So it is applied ONCE with local state, and then its
 * state is migrated into the bucket it just made:
 *
 *     terraform init -migrate-state
 *
 * An earlier version of this comment said to commit the local terraform.tfstate.
 * That was wrong: the state holds the alert email address, and state files are
 * gitignored for exactly that reason. Migrating is the durable answer — losing
 * an uncommitted, unbacked-up local state file means re-importing every resource
 * by hand.
 *
 * Guardrails come first deliberately. This platform runs untrusted code on a
 * finite credit pool: a repository with a crypto miner in `postinstall` is a
 * spend event, and the alarm needs to already exist when it happens.
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

# Budgets, Cost Explorer and the billing metric are global services whose
# endpoints live in us-east-1. This is not optional.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = local.tags
  }
}

data "aws_caller_identity" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  state_bucket = "${var.project}-tfstate-${local.account_id}"

  tags = {
    project   = var.project
    managedBy = "terraform"
    stack     = "bootstrap"
  }

  anomaly_monitor_arn = (
    var.anomaly_monitor_arn != ""
    ? var.anomaly_monitor_arn
    : aws_ce_anomaly_monitor.services[0].arn
  )
}

# ---------------------------------------------------------------------------
# Terraform state backend
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket

  # State is not something to lose to a stray `terraform destroy`.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Every apply writes a new version. Without this the bucket grows forever.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# NOTE: no DynamoDB lock table. Terraform 1.10+ locks natively against S3 via
# `use_lockfile = true` in the backend config, which deprecated the DynamoDB
# approach. One less resource, one less bill. (Corrects docs/07-roadmap.md M0,
# which still said "state bucket + lock table".)

# ---------------------------------------------------------------------------
# Spend guardrails
# ---------------------------------------------------------------------------

# Staged alerts rather than one. $25 is "notice this"; $95 is "something is
# very wrong and the credit pool is nearly gone".
resource "aws_budgets_budget" "monthly_cost" {
  provider = aws.us_east_1

  name         = "${var.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = var.budget_alert_percentages
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.alert_email]
    }
  }

  # Catches a spend spike early, before the month's actual total gets there.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

resource "aws_sns_topic" "billing_alerts" {
  provider = aws.us_east_1
  name     = "${var.project}-billing-alerts"
}

resource "aws_sns_topic_subscription" "billing_email" {
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.billing_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# The EstimatedCharges metric is only published in us-east-1, and only if
# billing alerts are enabled in the account's billing preferences. That setting
# has no API, so it must be ticked once by hand — see README.
resource "aws_cloudwatch_metric_alarm" "estimated_charges" {
  provider = aws.us_east_1

  alarm_name          = "${var.project}-estimated-charges"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "EstimatedCharges"
  namespace           = "AWS/Billing"
  period              = 21600 # 6h; the metric only updates a few times a day
  statistic           = "Maximum"
  threshold           = var.billing_alarm_usd
  alarm_description   = "Estimated AWS charges exceeded $${var.billing_alarm_usd}"
  treat_missing_data  = "notBreaching"

  dimensions = {
    Currency = "USD"
  }

  alarm_actions = [aws_sns_topic.billing_alerts.arn]
}

# Free, and catches the shape of spend that a threshold misses: a service that
# suddenly costs 10x its normal amount while still being under budget.
#
# AWS permits exactly ONE dimensional (SERVICE) anomaly monitor per account, and
# now auto-creates a "Default-Services-Monitor" in most accounts. Creating a
# second one fails with "Limit exceeded on dimensional spend monitor creation".
# So: attach the subscription to the existing monitor when its ARN is supplied,
# and only create one in an account that has none.
#
#   aws ce get-anomaly-monitors --query 'AnomalyMonitors[].MonitorArn'
resource "aws_ce_anomaly_monitor" "services" {
  count    = var.anomaly_monitor_arn == "" ? 1 : 0
  provider = aws.us_east_1

  name              = "${var.project}-service-monitor"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "alerts" {
  provider = aws.us_east_1

  name             = "${var.project}-anomaly-alerts"
  frequency        = "DAILY"
  monitor_arn_list = [local.anomaly_monitor_arn]

  subscriber {
    type    = "EMAIL"
    address = var.alert_email
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.anomaly_threshold_usd)]
    }
  }
}
