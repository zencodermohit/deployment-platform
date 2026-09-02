/**
 * M3 — the control-plane API: one Lambda behind an HTTP API.
 *
 * SECURITY NOTE, deliberately loud:
 *
 *   This API has NO REAL AUTHENTICATION yet. Identity comes from DEV_USER_ID,
 *   so every caller is the same user. Authorization is real — ownership is
 *   checked on every project-scoped route — but anyone who finds the URL is
 *   that user.
 *
 *   That is acceptable now, when the API only writes DynamoDB rows. It stops
 *   being acceptable in M4, when a request starts a Fargate task and therefore
 *   spends money. Sessions land in M6; until then `api_enabled = false` takes
 *   the endpoint down, and the throttles below bound the damage.
 */

data "terraform_remote_state" "edge" {
  backend = "s3"
  config = {
    bucket = var.state_bucket
    key    = "stacks/edge/terraform.tfstate"
    region = var.region
  }
}

locals {
  api_source     = "${path.module}/../../../apps/api/dist"
  cloudfront_dns = data.terraform_remote_state.edge.outputs.distribution_domain_name
  kvs_arn        = data.terraform_remote_state.edge.outputs.key_value_store_arn

  # Derived by convention rather than read from the build stack's state.
  # The build stack already reads THIS stack's outputs (for the table and the
  # API URL), so reading its outputs back here would be a dependency cycle.
  # The queue name is deterministic, so the ARN and URL are too.
  queue_name = "${var.project}-builds"
  queue_arn  = "arn:aws:sqs:${var.region}:${data.aws_caller_identity.current.account_id}:${local.queue_name}"
  queue_url  = "https://sqs.${var.region}.amazonaws.com/${data.aws_caller_identity.current.account_id}/${local.queue_name}"
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# Packaging
# ---------------------------------------------------------------------------

data "archive_file" "api" {
  type        = "zip"
  output_path = "${path.module}/.terraform/api.zip"

  source_file = "${local.api_source}/index.mjs"
  # The source map is not shipped: it would turn a stack trace in the logs into
  # a readable copy of the source, and nothing reads it in production anyway.
}

# ---------------------------------------------------------------------------
# Permissions — everything the API may do, and nothing else
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "api_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${var.project}-api"
  assume_role_policy = data.aws_iam_policy_document.api_assume.json
}

data "aws_iam_policy_document" "api" {
  statement {
    sid    = "TableAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]
    resources = [
      aws_dynamodb_table.platform.arn,
      "${aws_dynamodb_table.platform.arn}/index/*",
    ]
  }

  # Note what is absent: no Scan (every access pattern is a Query — ADR-0008),
  # no DeleteItem, no DeleteTable, no access to any other table.

  statement {
    sid       = "DecryptTableData"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [local.kms_key_arn]
  }

  statement {
    sid       = "EnqueueBuilds"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [local.queue_arn]
  }

  # Writing the edge routing table is a CONTROL-PLANE action. The build
  # container holds no CloudFront permissions at all — if it could write here it
  # could point any hostname at any prefix, which is the tenancy boundary.
  statement {
    sid       = "WriteEdgeRoutes"
    effect    = "Allow"
    actions   = ["cloudfront-keyvaluestore:DescribeKeyValueStore", "cloudfront-keyvaluestore:PutKey"]
    resources = [local.kvs_arn]
  }

  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }

  # Read the build container's logs to serve GET /deployments/{id}/logs.
  # Convention-derived ARN rather than a cross-stack read: the build stack
  # already reads THIS stack's outputs, so reading its outputs back would be a
  # dependency cycle. The log group name is deterministic.
  statement {
    sid       = "ReadBuildLogs"
    effect    = "Allow"
    actions   = ["logs:FilterLogEvents", "logs:GetLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/ecs/${var.project}-builder:*"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "${var.project}-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# ---------------------------------------------------------------------------
# Function
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "api" {
  name = "/aws/lambda/${var.project}-api"
  # 7 days. "Never expire" is the default and the quiet way a log bill grows
  # without bound — see docs/06-cost-model.md.
  retention_in_days = 7
}

resource "aws_lambda_function" "api" {
  function_name = "${var.project}-api"
  role          = aws_iam_role.api.arn

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  runtime = "nodejs22.x"
  handler = "index.handler"

  memory_size = 512
  # Generous for a handful of DynamoDB calls, but this is the ceiling, not the
  # target: a request that hangs should fail rather than sit for a minute.
  timeout = 10

  environment {
    variables = {
      TABLE_NAME        = aws_dynamodb_table.platform.name
      DEV_USER_ID       = var.dev_user_id
      ALLOW_DEBUG_AUTH  = tostring(var.allow_debug_auth)
      CLOUDFRONT_DOMAIN = local.cloudfront_dns
      DEPLOYMENT_DOMAIN = var.deployment_domain
      BUILD_TIMEOUT_SEC = tostring(var.build_timeout_sec)
      QUEUE_URL         = local.queue_url
      KVS_ARN           = local.kvs_arn

      AUTH_ENABLED            = tostring(var.auth_enabled)
      SSM_PREFIX              = "/${var.project}"
      API_PUBLIC_URL          = var.api_enabled ? aws_apigatewayv2_api.main[0].api_endpoint : ""
      DASHBOARD_URL           = var.dashboard_url
      MAX_DEPLOYMENTS_PER_DAY = tostring(var.max_deployments_per_day)
      BUILD_LOG_GROUP         = "/aws/ecs/${var.project}-builder"
      NODE_OPTIONS            = "--enable-source-maps=false"
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

# ---------------------------------------------------------------------------
# HTTP API
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "main" {
  count = var.api_enabled ? 1 : 0

  name          = "${var.project}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = var.cors_allow_origins
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type", "authorization"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_integration" "api" {
  count = var.api_enabled ? 1 : 0

  api_id                 = aws_apigatewayv2_api.main[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

# One catch-all route: the Lambda routes internally, so adding an endpoint is a
# code change rather than a Terraform change.
resource "aws_apigatewayv2_route" "default" {
  count = var.api_enabled ? 1 : 0

  api_id    = aws_apigatewayv2_api.main[0].id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api[0].id}"
}

resource "aws_apigatewayv2_stage" "default" {
  count = var.api_enabled ? 1 : 0

  api_id      = aws_apigatewayv2_api.main[0].id
  name        = "$default"
  auto_deploy = true

  # The bound on how fast an unauthenticated caller can do anything at all.
  default_route_settings {
    throttling_rate_limit  = var.api_rate_limit
    throttling_burst_limit = var.api_burst_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId = "$context.requestId"
      ip        = "$context.identity.sourceIp"
      method    = "$context.httpMethod"
      path      = "$context.path"
      status    = "$context.status"
      latency   = "$context.responseLatency"
      error     = "$context.error.message"
    })
  }
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${var.project}-api"
  retention_in_days = 7
}

resource "aws_lambda_permission" "api_gateway" {
  count = var.api_enabled ? 1 : 0

  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  # Scoped to this API alone, so no other API in the account can invoke it.
  source_arn = "${aws_apigatewayv2_api.main[0].execution_arn}/*/*"
}
