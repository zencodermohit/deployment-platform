/**
 * M2 — Edge stack: CloudFront, the routing function, and the key-value store
 * that maps a hostname (or deployment id) to an S3 prefix.
 *
 * The custom-domain pieces — ACM certificate, aliases, Route53 records — are
 * gated on `domain_name`. Leave it empty and the distribution works on its own
 * *.cloudfront.net domain using path mode (/d/<deploymentId>/...), which means
 * the whole routing mechanism can be built and verified before any DNS exists.
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

# CloudFront certificates must live in us-east-1. Not a preference — a hard
# requirement, regardless of where everything else runs.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = local.tags
  }
}

data "terraform_remote_state" "data" {
  backend = "s3"
  config = {
    bucket = var.state_bucket
    key    = "stacks/data/terraform.tfstate"
    region = var.region
  }
}

locals {
  artifacts_bucket        = data.terraform_remote_state.data.outputs.artifacts_bucket
  artifacts_bucket_arn    = data.terraform_remote_state.data.outputs.artifacts_bucket_arn
  artifacts_origin_domain = data.terraform_remote_state.data.outputs.artifacts_bucket_regional_domain_name

  use_custom_domain = var.domain_name != ""
  wildcard          = local.use_custom_domain ? "*.${var.domain_name}" : ""

  tags = {
    project   = var.project
    managedBy = "terraform"
    stack     = "edge"
    tier      = "A"
  }
}

# ---------------------------------------------------------------------------
# Key-value store: hostname (or deployment id) -> {"p": prefix, "spa": bool}
#
# This is the edge's read replica of the routing table. DynamoDB stays the
# source of truth from M3; the control plane writes both. CloudFront Functions
# cannot make network calls, so this is the only lookup available to them.
# ---------------------------------------------------------------------------

resource "aws_cloudfront_key_value_store" "routes" {
  name    = "${var.project}-routes"
  comment = "hostname or deployment id -> S3 artifact prefix"
}

resource "aws_cloudfront_function" "router" {
  name    = "${var.project}-router"
  runtime = "cloudfront-js-2.0" # 2.0 is required for key-value store access
  comment = "Maps a request to its deployment's S3 prefix"
  publish = true
  code    = file("${path.module}/router.js")

  key_value_store_associations = [aws_cloudfront_key_value_store.routes.arn]
}

# ---------------------------------------------------------------------------
# Distribution
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "artifacts" {
  name                              = "${var.project}-artifacts"
  description                       = "Lets CloudFront read the private artifacts bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.project} — deployment delivery"
  price_class     = var.price_class

  # Deliberately unset. `default_root_object` rewrites "/" before the function
  # runs, which would break path mode (/d/<id>). Root handling is the router's
  # job, and it does it per deployment.
  # default_root_object = ...

  aliases = local.use_custom_domain ? [local.wildcard, var.domain_name] : []

  origin {
    origin_id                = "artifacts"
    domain_name              = local.artifacts_origin_domain
    origin_access_control_id = aws_cloudfront_origin_access_control.artifacts.id
  }

  default_cache_behavior {
    target_origin_id       = "artifacts"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Managed-CachingOptimized. Host is not part of the cache key, and does not
    # need to be: viewer-request functions run BEFORE the cache lookup, so the
    # rewritten URI — which already contains the deployment prefix — is what
    # gets cached. Two hostnames pointing at the same prefix share cache, which
    # is correct.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

    # Managed-SecurityHeadersPolicy. Free, and adds HSTS, X-Content-Type-Options,
    # frame options and a referrer policy to every response.
    response_headers_policy_id = "67f7725c-6f97-4210-82d7-5512b31e9d03"

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.router.arn
    }
  }

  # With OAC and no s3:ListBucket, S3 answers 403 for a key that does not exist.
  # Passing that through would tell a prober the difference between "forbidden"
  # and "absent", so both become a plain 404.
  #
  # Note there is no SPA fallback here: a custom error response has a fixed
  # response_page_path, which cannot carry a per-deployment prefix and would
  # serve another deployment's index.html. SPA routing is handled per deployment
  # by the `spa` flag in the key-value store. See router.js.
  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 10
  }

  depends_on = [aws_s3_object.not_found]

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = local.use_custom_domain ? false : true
    acm_certificate_arn            = local.use_custom_domain ? aws_acm_certificate_validation.main[0].certificate_arn : null
    ssl_support_method             = local.use_custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.use_custom_domain ? "TLSv1.2_2021" : null
  }
}

# ---------------------------------------------------------------------------
# Bucket policy
#
# Lives here, not in the data stack, because it needs the distribution ARN.
# Scoped to this one distribution: a different distribution in the same account
# cannot read the bucket.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = local.artifacts_bucket
  policy = data.aws_iam_policy_document.artifacts.json
}

# The page behind custom_error_response. CloudFront cannot rewrite a status code
# without a page to serve, and if that page is missing it gives up and returns
# the origin's error unchanged — which is how a missing object leaks S3's raw
# 403 instead of a plain 404.
#
# It sits at the bucket root, outside every deployment prefix, and is fetched by
# CloudFront internally, so the router function never sees it. Deliberately
# generic: it is shown for every deployment and must reveal nothing about any.
resource "aws_s3_object" "not_found" {
  bucket        = local.artifacts_bucket
  key           = "404.html"
  content_type  = "text/html; charset=utf-8"
  cache_control = "public, max-age=60"

  content = <<-HTML
    <!doctype html>
    <html lang="en">
    <head><meta charset="utf-8"><title>Not found</title></head>
    <body style="font:16px system-ui;margin:4rem auto;max-width:32rem">
      <h1 style="font-size:1.25rem">404 &mdash; not found</h1>
      <p>There is nothing at this address.</p>
    </body>
    </html>
  HTML
}

data "aws_iam_policy_document" "artifacts" {
  statement {
    sid       = "AllowCloudFrontRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${local.artifacts_bucket_arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      local.artifacts_bucket_arn,
      "${local.artifacts_bucket_arn}/*",
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

# ---------------------------------------------------------------------------
# Custom domain — created only when domain_name is set
# ---------------------------------------------------------------------------

data "aws_route53_zone" "main" {
  count        = local.use_custom_domain ? 1 : 0
  name         = var.domain_name
  private_zone = false
}

resource "aws_acm_certificate" "main" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.us_east_1

  domain_name = var.domain_name
  # A wildcard covers ONE level: *.example.com matches dep-abc.example.com but
  # not dep-abc.preview.example.com. The subdomain scheme depends on this.
  subject_alternative_names = [local.wildcard]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.use_custom_domain ? {
    for option in aws_acm_certificate.main[0].domain_validation_options :
    option.domain_name => option
  } : {}

  zone_id         = data.aws_route53_zone.main[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "main" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

resource "aws_route53_record" "wildcard" {
  count = local.use_custom_domain ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = local.wildcard
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "apex" {
  count = local.use_custom_domain ? 1 : 0

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
