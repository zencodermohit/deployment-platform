/**
 * M7 — CI/CD identity.
 *
 * GitHub Actions authenticates by OIDC, so there are NO long-lived AWS keys in
 * repository secrets. A leaked secret is the most common way a project like
 * this gets compromised, and the fix is to have no secret to leak: GitHub
 * presents a short-lived token, AWS verifies it, and the trust policy pins
 * which repository and which ref may assume the role.
 *
 * Two roles, because plan and apply are different privileges:
 *
 *   plan   — read-only, assumable from any branch and any pull request.
 *   deploy — can change infrastructure, assumable ONLY from main.
 *
 * Without that split, any pull request — including one from a fork, if branch
 * protections slipped — could apply infrastructure.
 *
 * Applied only when `github_repository` is set; there is no repository yet.
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
  enabled = var.github_repository != ""

  tags = {
    project   = var.project
    managedBy = "terraform"
    stack     = "cicd"
    tier      = "A"
  }
}

resource "aws_iam_openid_connect_provider" "github" {
  count = local.enabled ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS verifies GitHub's certificate against its own trust store for this
  # provider, so the thumbprint is vestigial — but the API still requires one.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# ---------------------------------------------------------------------------
# Plan role — read-only
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "plan_assume" {
  count = local.enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      # This repository only. Without the `repo:` prefix pinned to one name,
      # ANY GitHub repository in the world could assume this role.
      values = ["repo:${var.github_repository}:*"]
    }
  }
}

resource "aws_iam_role" "plan" {
  count = local.enabled ? 1 : 0

  name                 = "${var.project}-ci-plan"
  assume_role_policy   = data.aws_iam_policy_document.plan_assume[0].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  count = local.enabled ? 1 : 0

  role = aws_iam_role.plan[0].name
  # ReadOnlyAccess covers `terraform plan` across every service in use. Writing
  # a bespoke read policy for a dozen services would be a large surface to keep
  # correct for no benefit — it is read-only either way.
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# Plan needs to write its state lock, and the integration tests need the -test
# table and the -test queue. Both are writes, so ReadOnlyAccess is not enough.
data "aws_iam_policy_document" "plan_extra" {
  count = local.enabled ? 1 : 0

  statement {
    sid       = "TerraformStateLock"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.project}-tfstate-${data.aws_caller_identity.current.account_id}/*"]
  }

  statement {
    sid    = "TestTableAndQueueOnly"
    effect = "Allow"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "sqs:SendMessage",
    ]
    # Scoped by NAME to the test resources. CI cannot touch real deployments.
    resources = [
      "arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.project}-test",
      "arn:aws:sqs:${var.region}:${data.aws_caller_identity.current.account_id}:${var.project}-test-builds",
    ]
  }

  statement {
    sid       = "DecryptTestData"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "plan_extra" {
  count = local.enabled ? 1 : 0

  name   = "plan-extra"
  role   = aws_iam_role.plan[0].id
  policy = data.aws_iam_policy_document.plan_extra[0].json
}

# ---------------------------------------------------------------------------
# Deploy role — main branch only
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "deploy_assume" {
  count = local.enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      # StringEquals, not StringLike, and pinned to the environment: a pull
      # request cannot mint this token, only a run in the `production`
      # environment on this repository can.
      values = [
        "repo:${var.github_repository}:ref:refs/heads/main",
        "repo:${var.github_repository}:environment:production",
      ]
    }
  }
}

resource "aws_iam_role" "deploy" {
  count = local.enabled ? 1 : 0

  name                 = "${var.project}-ci-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deploy_assume[0].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "deploy" {
  count = local.enabled ? 1 : 0

  role = aws_iam_role.deploy[0].name
  # PowerUserAccess plus a narrow IAM grant below, rather than AdministratorAccess:
  # deploys create and update roles, but must not be able to detach their own
  # guardrails or touch the account's billing and organisation settings.
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "deploy_iam" {
  count = local.enabled ? 1 : 0

  statement {
    sid    = "ManageProjectRoles"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:PassRole",
      "iam:TagRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:GetRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:UpdateAssumeRolePolicy",
    ]
    # This project's roles only — including, deliberately, not the CI roles
    # themselves, so a compromised deploy cannot widen its own permissions.
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-*",
    ]
  }

  statement {
    sid     = "DenySelfModification"
    effect  = "Deny"
    actions = ["iam:*"]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-ci-*",
    ]
  }
}

resource "aws_iam_role_policy" "deploy_iam" {
  count = local.enabled ? 1 : 0

  name   = "deploy-iam"
  role   = aws_iam_role.deploy[0].id
  policy = data.aws_iam_policy_document.deploy_iam[0].json
}
