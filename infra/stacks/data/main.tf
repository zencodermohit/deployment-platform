/**
 * M2 — Data stack: the buckets artifacts and sources live in.
 *
 * Both buckets are fully private. The artifact bucket is reached only through
 * CloudFront with Origin Access Control; the bucket policy that permits that
 * lives in the edge stack, because it needs the distribution ARN.
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
  account_id = data.aws_caller_identity.current.account_id

  artifacts_bucket = "${var.project}-artifacts-${local.account_id}"
  sources_bucket   = "${var.project}-sources-${local.account_id}"

  tags = {
    project   = var.project
    managedBy = "terraform"
    stack     = "data"
    tier      = "A"
  }
}

# ---------------------------------------------------------------------------
# Encryption key
#
# Used for the sources bucket (which holds copies of private repositories) and,
# from M3, the DynamoDB table. NOT used for artifacts: those are public web
# assets served through CloudFront, and SSE-KMS there would need the CloudFront
# service principal granted on the key — a real failure mode for no security
# gain. ~$1/month, see docs/06-cost-model.md.
# ---------------------------------------------------------------------------

resource "aws_kms_key" "main" {
  description             = "${var.project} — source archives and deployment state"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.project}"
  target_key_id = aws_kms_key.main.key_id
}

# ---------------------------------------------------------------------------
# Artifacts — immutable, one prefix per deployment, served via CloudFront
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "artifacts" {
  bucket = local.artifacts_bucket
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# No versioning: prefixes are unique per deployment and never overwritten, so
# versioning would only duplicate storage cost. Immutability comes from the
# naming scheme, not from S3.
resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # Expiring superseded deployments needs to know which one is live, which the
  # control plane only knows from M4. Until then artifacts are kept — they are
  # a few MB each. Tracked in docs/06-cost-model.md.
}

# ---------------------------------------------------------------------------
# Sources — short-lived copies of user repositories
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "sources" {
  bucket = local.sources_bucket
}

resource "aws_s3_bucket_public_access_block" "sources" {
  bucket                  = aws_s3_bucket.sources.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "sources" {
  bucket = aws_s3_bucket.sources.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

# ADR-0004: the presigned URL handed to the build container lives 15 minutes.
# Keeping the archive beyond a day serves no purpose and stores other people's
# private source code for no reason.
resource "aws_s3_bucket_lifecycle_configuration" "sources" {
  bucket = aws_s3_bucket.sources.id

  rule {
    id     = "expire-source-archives"
    status = "Enabled"
    filter {}
    expiration {
      days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Refuse any request that is not TLS. Cheap, and it closes the "someone left
# HTTP on" class of finding before it can happen.
resource "aws_s3_bucket_policy" "sources_tls_only" {
  bucket = aws_s3_bucket.sources.id
  policy = data.aws_iam_policy_document.sources_tls_only.json
}

data "aws_iam_policy_document" "sources_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.sources.arn,
      "${aws_s3_bucket.sources.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}
