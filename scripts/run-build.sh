#!/usr/bin/env bash
#
# Run a build inside the container, with the same limits Fargate will apply.
#
#   ./scripts/run-build.sh                          # static-ok fixture
#   ./scripts/run-build.sh vite-ok
#   ./scripts/run-build.sh /path/to/my-app.tar.gz
#
# Env: DEPLOYMENT_ID, BUILD_TIMEOUT_SEC, IMAGE, NO_NETWORK=1

set -euo pipefail

# Git Bash on Windows rewrites Unix-looking arguments into Windows paths when it
# calls a native binary, so `-v /in:...` and `build /in/x.tar.gz` reach docker as
# `C:/Program Files/Git/in/...`. This disables that rewriting for the whole
# script. Harmless on Linux and macOS, where the variable is simply ignored.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
arg="${1:-static-ok}"
image="${IMAGE:-deploy-builder:dev}"
timeout_sec="${BUILD_TIMEOUT_SEC:-600}"
deployment_id="${DEPLOYMENT_ID:-dep_$(head -c6 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

if [ -f "$arg" ]; then
  tarball="$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")"
else
  tarball="$root/tests/fixtures/tarballs/$arg.tar.gz"
fi

if [ ! -f "$tarball" ]; then
  echo "tarball not found: $tarball" >&2
  echo "run 'npm run fixtures' first" >&2
  exit 1
fi

input_dir="$(dirname "$tarball")"
input_name="$(basename "$tarball")"
output_dir="$root/.out"
mkdir -p "$output_dir"

# Mirrors the Fargate task definition in docs/04-build-contract.md.
args=(
  run --rm
  --memory 2g
  --cpus 1
  --pids-limit 512
  --security-opt no-new-privileges
  --cap-drop ALL
  -v "$input_dir:/in:ro"
  -v "$output_dir:/out"
  -e BUILDER_MODE=local
  -e "DEPLOYMENT_ID=$deployment_id"
  -e "BUILD_TIMEOUT_SEC=$timeout_sec"
  -e CONTAINER_MEMORY_MB=2048
)

# A static site needs no network at all; installing dependencies does.
[ "${NO_NETWORK:-}" = "1" ] && args+=(--network none)

args+=("$image" build "/in/$input_name")

echo "deployment : $deployment_id"
echo "source     : $tarball"
echo "output     : $output_dir/$deployment_id"
echo

set +e
docker "${args[@]}"
code=$?
set -e

echo
case $code in
  0)   echo "DEPLOYED  -> $output_dir/$deployment_id" ;;
  10)  echo "FAILED (10) source error" ;;
  11)  echo "FAILED (11) unsupported framework" ;;
  12)  echo "FAILED (12) dependency install" ;;
  13)  echo "FAILED (13) build command" ;;
  14)  echo "FAILED (14) no build output" ;;
  15)  echo "FAILED (15) artifact too large" ;;
  16)  echo "FAILED (16) publish" ;;
  17)  echo "FAILED (17) timeout" ;;
  20)  echo "FAILED (20) configuration" ;;
  137) echo "FAILED (137) killed - out of memory" ;;
  *)   echo "FAILED ($code)" ;;
esac

exit $code
