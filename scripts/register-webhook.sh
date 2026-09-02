#!/usr/bin/env bash
#
# Turn on auto-deploy for a project: enable the webhook on the platform, then
# register it on the GitHub repository so a push triggers a build.
#
#   GITHUB_TOKEN=ghp_xxx ./scripts/register-webhook.sh <projectId> <owner/repo>
#
# The GitHub token needs `admin:repo_hook` (classic) or repository
# "Webhooks: read and write" (fine-grained) on that one repo.

set -euo pipefail

project="${1:?usage: register-webhook.sh <projectId> <owner/repo>}"
repo="${2:?usage: register-webhook.sh <projectId> <owner/repo>}"
: "${GITHUB_TOKEN:?set GITHUB_TOKEN with admin:repo_hook scope}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api="$(cd "$root/infra/stacks/app" && terraform output -raw api_url)"

echo "enabling the webhook on the platform..."
enabled="$(curl -s -X POST "$api/projects/$project/webhook")"
url="$(node -e 'console.log(JSON.parse(process.argv[1]).url)' "$enabled")"
secret="$(node -e 'console.log(JSON.parse(process.argv[1]).secret)' "$enabled")"

if [ -z "$url" ] || [ "$url" = "undefined" ]; then
  echo "failed to enable webhook: $enabled" >&2
  exit 1
fi

echo "registering it on github.com/$repo..."
resp="$(curl -s -w '\n%{http_code}' -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$repo/hooks" \
  -d "$(node -e '
    const [url, secret] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      name: "web",
      active: true,
      events: ["push"],
      config: { url, secret, content_type: "json", insecure_ssl: "0" },
    }));
  ' "$url" "$secret")")"

code="$(echo "$resp" | tail -1)"
body="$(echo "$resp" | sed '$d')"

if [ "$code" = "201" ]; then
  echo "done. github will send a ping now; a push to the default branch will build."
else
  echo "github returned $code:" >&2
  echo "$body" >&2
  exit 1
fi
