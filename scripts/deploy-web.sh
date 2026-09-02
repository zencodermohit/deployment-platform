#!/usr/bin/env bash
#
# Publish the dashboard onto the platform's own CloudFront distribution.
#
# It lives at a reserved prefix (`dashboard/`) beside the deployment artifacts,
# and is routed by the same edge function, with the SPA flag set so client-side
# routes resolve to index.html. No second distribution, no second bucket.

set -euo pipefail

# Note: MSYS_NO_PATHCONV is deliberately NOT set here. Nothing below starts an
# argument with "/", so Git Bash's path rewriting is harmless — and disabling it
# would break the opposite direction, leaving the AWS CLI with a /c/... local
# path it cannot open.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bucket="$(cd "$root/infra/stacks/data" && terraform output -raw artifacts_bucket)"
kvs="$(cd "$root/infra/stacks/edge" && terraform output -raw key_value_store_arn)"
domain="$(cd "$root/infra/stacks/edge" && terraform output -raw distribution_domain_name)"

echo "building..."
(cd "$root/apps/web" && npx vite build >/dev/null)

# Hashed filenames, so they can be cached forever. Uploaded FIRST: a browser
# that fetches the new index.html must find the assets it references already
# there, or it renders a blank page for one cache cycle.
echo "uploading assets..."
aws s3 sync "$root/apps/web/dist/assets" "s3://$bucket/dashboard/assets" \
  --delete --cache-control "public, max-age=31536000, immutable" --only-show-errors

# The entry point changes every build and must never be cached.
echo "uploading index..."
aws s3 cp "$root/apps/web/dist/index.html" "s3://$bucket/dashboard/index.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "public, max-age=0, must-revalidate" --only-show-errors

echo "routing..."
etag="$(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn "$kvs" --query ETag --output text)"
aws cloudfront-keyvaluestore put-key \
  --kvs-arn "$kvs" --key dashboard \
  --value '{"p":"dashboard","spa":true}' \
  --if-match "$etag" --output text >/dev/null

echo
echo "dashboard: https://$domain/d/dashboard/"
