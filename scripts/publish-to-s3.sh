#!/usr/bin/env bash
#
# Upload a local build (from M1's builder) into the artifacts bucket, applying
# the Content-Type and Cache-Control from the manifest the builder wrote.
#
#   ./scripts/publish-to-s3.sh .out/dep_static1
#
# This is the manual stand-in for what the build container does natively in M4.
# It exists so M2 can be verified end to end with a real deployment before any
# of the control plane is built.

set -euo pipefail

dir="${1:?usage: publish-to-s3.sh <path-to-built-deployment>}"
dir="${dir%/}"
deployment_id="$(basename "$dir")"
manifest="${dir}.manifest.json"
project_id="${PROJECT_ID:-prj_local}"

[ -d "$dir" ]      || { echo "not a directory: $dir" >&2; exit 1; }
[ -f "$manifest" ] || { echo "manifest not found: $manifest" >&2; exit 1; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bucket="$(terraform -chdir="$root/infra/stacks/data" output -raw artifacts_bucket)"
prefix="projects/${project_id}/deployments/${deployment_id}"

echo "bucket : $bucket"
echo "prefix : $prefix"
echo

# Read each file's metadata from the manifest rather than guessing from the
# extension a second time — the builder already decided, and one source of
# truth for Content-Type avoids the two drifting apart.
count=0
while IFS=$'\t' read -r rel ctype cache; do
  aws s3api put-object \
    --bucket "$bucket" \
    --key "${prefix}/${rel}" \
    --body "${dir}/${rel}" \
    --content-type "$ctype" \
    --cache-control "$cache" \
    --output text >/dev/null
  echo "  + $rel"
  count=$((count + 1))
done < <(node "$root/scripts/manifest-tsv.mjs" "$manifest")

echo
echo "uploaded $count files"
echo
echo "next: ./scripts/seed-route.sh $deployment_id $prefix"
