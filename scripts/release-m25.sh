#!/usr/bin/env bash
# M25 hotfix: only the protected MCP Worker changed. Preserve Auth/Setup.
# Never use ordinary wrangler deploy against route-free private configs.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
ACTION="${1:-check}"
WRANGLER_CONFIG=".wrangler-deploy.mcp.jsonc"
RELEASE_DIR=".m25-release"
wrangler() { npx --no-install wrangler "$@"; }
case "$ACTION" in check|stage|promote) ;; *)
  echo "Usage: bash scripts/release-m25.sh [check|stage|promote]" >&2
  exit 2;;
esac

node --version
npm run cloudflare:verify
npm test
npm run test:runtime

if [[ "$ACTION" == "check" ]]; then
  echo "M25 validated; no Cloudflare changes made."
  exit 0
fi
mkdir -p "$RELEASE_DIR"
chmod 700 "$RELEASE_DIR"

if [[ "$ACTION" == "stage" ]]; then
  wrangler versions upload -c "$WRANGLER_CONFIG" \
    --message "M25 ChatGPT OAuth scope-discovery hotfix" \
    --var GMW_WORKSPACE_READS_ENABLED:true \
    --var GMW_WRITES_ENABLED:true | tee "$RELEASE_DIR/mcp-upload.log"
  version="$(sed -n 's/^Worker Version ID: //p' "$RELEASE_DIR/mcp-upload.log" | tail -1)"
  [[ "$version" =~ ^[0-9a-f-]{36}$ ]] || {
    echo "No verified version ID; production unchanged." >&2
    exit 1
  }
  printf "%s" "$version" > "$RELEASE_DIR/mcp-version"
  wrangler versions view "$version" -c "$WRANGLER_CONFIG"
  echo "Staged, not deployed. Verify existing D1/service/secret bindings above."
  echo "When verified, run: bash scripts/release-m25.sh promote"
  exit 0
fi

[[ -f "$RELEASE_DIR/mcp-version" ]] || {
  echo "No M25 staged version. Run stage first." >&2; exit 1;
}
version="$(cat "$RELEASE_DIR/mcp-version")"
[[ "$version" =~ ^[0-9a-f-]{36}$ ]] || exit 1
wrangler versions view "$version" -c "$WRANGLER_CONFIG"
wrangler versions deploy "$version@100%" -c "$WRANGLER_CONFIG"
wrangler deployments status -c "$WRANGLER_CONFIG"
echo "M25 protected MCP active. No Auth or Setup Worker redeploy."
echo "Read-only OAuth clients may read; write clients can authorize mcp:write"
echo "once via a tool-level OAuth scope upgrade. Direct writes remain direct."
