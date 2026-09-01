/**
 * M6 — Authentication.
 *
 * GitHub OAuth credentials live in SSM Parameter Store as SecureStrings,
 * encrypted with the project's customer-managed key. Parameter Store rather
 * than Secrets Manager because it is free at this scale and Secrets Manager is
 * $0.40 per secret per month (docs/06-cost-model.md).
 *
 * Terraform creates the parameters with PLACEHOLDER values and then ignores
 * changes to them. The real values are written once, by hand or by CI, and
 * never appear in Terraform state — which is exactly what you want for a
 * client secret, since state is far more widely readable than a parameter.
 *
 * TO FINISH SETUP:
 *
 *   1. Create an OAuth App: https://github.com/settings/developers
 *      Homepage:     <the API URL>
 *      Callback URL: <the API URL>/auth/github/callback
 *
 *   2. Store the credentials:
 *      aws ssm put-parameter --name /deployment-platform/github/client_id \
 *        --value "Iv1.xxx" --type SecureString --overwrite
 *      aws ssm put-parameter --name /deployment-platform/github/client_secret \
 *        --value "xxx" --type SecureString --overwrite
 *
 *   3. Flip auth on:  terraform apply -var auth_enabled=true
 */

resource "aws_ssm_parameter" "github_client_id" {
  name   = "/${var.project}/github/client_id"
  type   = "SecureString"
  key_id = local.kms_key_arn
  value  = "PLACEHOLDER"

  lifecycle {
    # The real value is written out of band. Without this, every apply would
    # reset it to the placeholder and silently break login.
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "github_client_secret" {
  name   = "/${var.project}/github/client_secret"
  type   = "SecureString"
  key_id = local.kms_key_arn
  value  = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }
}

# Signs the OAuth `state` parameter, which is what stops an attacker completing
# a login flow in someone else's browser. Generated here because, unlike the
# GitHub credentials, nothing outside this system ever needs to know it.
resource "random_password" "state_secret" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "state_secret" {
  name   = "/${var.project}/session/state_secret"
  type   = "SecureString"
  key_id = local.kms_key_arn
  value  = random_password.state_secret.result
}

data "aws_iam_policy_document" "api_auth" {
  statement {
    sid    = "ReadOAuthConfig"
    effect = "Allow"
    # Read-only, and scoped to this project's parameters. The API can read its
    # own configuration and nothing else in the account.
    actions = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = [
      aws_ssm_parameter.github_client_id.arn,
      aws_ssm_parameter.github_client_secret.arn,
      aws_ssm_parameter.state_secret.arn,
    ]
  }

  statement {
    sid       = "DeleteOwnSession"
    effect    = "Allow"
    actions   = ["dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.platform.arn]

    # Logging out deletes a session row, and nothing else.
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["SESSION#*"]
    }

    # REQUIRED, and the reason matters: `ForAllValues` evaluates to TRUE when
    # the context key is absent. On its own the condition above therefore
    # restricts nothing a request can simply omit — an IAM simulation showed
    # this policy allowing deletion of deployment records. `Null ... = false`
    # demands the key be present, so the restriction actually applies.
    condition {
      test     = "Null"
      variable = "dynamodb:LeadingKeys"
      values   = ["false"]
    }
  }
}

resource "aws_iam_role_policy" "api_auth" {
  name   = "${var.project}-api-auth"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_auth.json
}
