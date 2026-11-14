#!/usr/bin/env bash
# M26: fix one-time authorization consent; ONLY the Auth Worker changes.
# Keep Cloudflare routes, OAuth KV and existing secrets intact.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
ACTION="check"
if [[ "$#" -gt 0 ]]; then ACTION="$1"; fi
CONFIG=".wrangler-deploy.auth.jsonc"
DIR=".m26-release"
wrangler() { npx --no-install wrangler "$@"; }
case "$ACTION" in check|stage|promote) ;; *)
 echo "Usage: bash scripts/release-m26.sh [check|stage|promote]" >&2
 exit 2;;
esac

node --version
npm run cloudflare:verify
npm test
npm run test:runtime

if [[ "$ACTION" == "check" ]]; then
  echo "M26 consent and MCP regression checks passed. No deployment."
  exit 0
fi

mkdir -p "$DIR"
chmod 700 "$DIR"

if [[ "$ACTION" == "stage" ]]; then
  wrangler versions upload -c "$CONFIG" \
    --message "M26 explicit optional write scope on initial OAuth consent" \
    | tee "$DIR/auth-upload.log"
  version="$(sed -n 's/^Worker Version ID: //p' "$DIR/auth-upload.log" | tail -1)"
  [[ "$version" =~ ^[0-9a-f-]{36}$ ]] || {
    echo "No verifiable Auth Worker version; nothing deployed." >&2
    exit 1
  }
  printf "%s" "$version" > "$DIR/auth-version"
  wrangler versions view "$version" -c "$CONFIG"
  echo "M26 Auth version staged. Verify KV, limiter and existing OAuth secrets."
  echo "Then: bash scripts/release-m26.sh promote"
  exit 0
fi

[[ -f "$DIR/auth-version" ]] || { echo "Stage first." >&2; exit 1; }
version="$(cat "$DIR/auth-version")"
[[ "$version" =~ ^[0-9a-f-]{36}$ ]] || exit 1
wrangler versions view "$version" -c "$CONFIG"
wrangler versions deploy "$version@100%" -c "$CONFIG"
wrangler deployments status -c "$CONFIG"
echo "M26 Auth deployed. MCP and Setup unchanged."
echo "Consent now offers mcp:read + optional mcp:write, even if ChatGPT requests only read."
echo "After an explicit write grant, 90 direct write tools need no approval middleman."
