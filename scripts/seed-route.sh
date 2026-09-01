#!/usr/bin/env bash
#
# Write one routing entry into the CloudFront KeyValueStore.
#
# This is what the control plane will do automatically from M3. Until then it is
# how you point a hostname (or a deployment id, in path mode) at an S3 prefix.
#
#   ./scripts/seed-route.sh dep_9c21 projects/prj_1/deployments/dep_9c21
#   ./scripts/seed-route.sh dep-9c21.example.com projects/prj_1/deployments/dep_9c21 --spa
#
# There is no Terraform resource for individual KVS keys — the store is managed
# by Terraform, its contents are managed through this API.

set -euo pipefail

key="${1:?usage: seed-route.sh <key> <s3-prefix> [--spa]}"
prefix="${2:?usage: seed-route.sh <key> <s3-prefix> [--spa]}"
spa="false"
[ "${3:-}" = "--spa" ] && spa="true"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
edge="$root/infra/stacks/edge"

kvs_arn="$(terraform -chdir="$edge" output -raw key_value_store_arn)"

# Every write needs the current ETag, which is CloudFront's optimistic-locking
# check: if someone else wrote in between, this fails rather than clobbering.
etag="$(aws cloudfront-keyvaluestore describe-key-value-store \
          --kvs-arn "$kvs_arn" --query ETag --output text)"

value="{\"p\":\"${prefix}\",\"spa\":${spa}}"

aws cloudfront-keyvaluestore put-key \
  --kvs-arn "$kvs_arn" \
  --key "$key" \
  --value "$value" \
  --if-match "$etag" \
  --output text >/dev/null

domain="$(terraform -chdir="$edge" output -raw distribution_domain_name)"

echo "route written"
echo "  key    : $key"
echo "  value  : $value"
echo
if [[ "$key" == *.* ]]; then
  echo "  try    : https://$key/"
else
  echo "  try    : https://$domain/d/$key/"
fi
echo
echo "Edge propagation takes a minute or two on first write."
