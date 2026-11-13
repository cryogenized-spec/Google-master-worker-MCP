#!/usr/bin/env bash
# M24: one-shot deployment of direct, OAuth-scoped Google writes.
# Never run ordinary wrangler deploy against route-free private configs.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
ACTION="check"
if [[ "$#" -gt 0 ]]; then ACTION="$1"; fi
wrangler() { npx --no-install wrangler "$@"; }
AUTH_CONFIG=".wrangler-deploy.auth.jsonc"
MCP_CONFIG=".wrangler-deploy.mcp.jsonc"
SETUP_CONFIG=".wrangler-deploy.setup.jsonc"
RELEASE_DIR=".m24-release"
case "$ACTION" in check|stage|promote) ;; *)
  echo "Usage: bash scripts/release-m24.sh [check|stage|promote]" >&2
  exit 2;;
esac

node --version
npm run cloudflare:verify
npm test
npm run test:runtime

if [[ "$ACTION" == "check" ]]; then
  echo "M24 tests passed. No Cloudflare changes made."
  exit 0
fi

mkdir -p "$RELEASE_DIR"
chmod 700 "$RELEASE_DIR"

upload() {
  local role="$1" config="$2" message="$3" version log
  shift 3
  log="$RELEASE_DIR/$role-upload.log"
  wrangler versions upload -c "$config" --message "$message" "$@" | tee "$log"
  version="$(sed -n 's/^Worker Version ID: //p' "$log" | tail -1)"
  [[ "$version" =~ ^[0-9a-f-]{36}$ ]] || {
    echo "Unable to verify $role staging version. No promotion." >&2
    exit 1
  }
  printf "%s" "$version" > "$RELEASE_DIR/$role-version"
  wrangler versions view "$version" -c "$config"
}
if [[ "$ACTION" == "stage" ]]; then
  upload auth "$AUTH_CONFIG" "M24 OAuth client read/write scope"
  upload setup "$SETUP_CONFIG" "M24 remove owner per-write approval page"
  upload mcp "$MCP_CONFIG" "M24 direct scoped Google writes" \
    --var GMW_WORKSPACE_READS_ENABLED:true \
    --var GMW_WRITES_ENABLED:true
  echo "All three Worker versions are STAGED; production is unchanged."
  echo "Check all existing secrets/bindings, then: bash scripts/release-m24.sh promote"
  exit 0
fi

for role in auth setup mcp; do
  [[ -f "$RELEASE_DIR/$role-version" ]] || {
    echo "Missing $role staging receipt; run stage before promote." >&2
    exit 1
  }
done
auth_version="$(cat "$RELEASE_DIR/auth-version")"
setup_version="$(cat "$RELEASE_DIR/setup-version")"
mcp_version="$(cat "$RELEASE_DIR/mcp-version")"
for v in "$auth_version" "$setup_version" "$mcp_version"; do
  [[ "$v" =~ ^[0-9a-f-]{36}$ ]] || {
    echo "Invalid staged version identifier." >&2; exit 1;
  }
done

echo "Promote OAuth issuer first (adds mcp:write to client consent)."
wrangler versions deploy "$auth_version@100%" -c "$AUTH_CONFIG"
wrangler deployments status -c "$AUTH_CONFIG"

echo "Promote private Setup (retains Google OAuth connection, removes approval page)."
wrangler versions deploy "$setup_version@100%" -c "$SETUP_CONFIG"
wrangler deployments status -c "$SETUP_CONFIG"

echo "Promote protected MCP with reads and direct writes enabled."
wrangler versions deploy "$mcp_version@100%" -c "$MCP_CONFIG"
wrangler deployments status -c "$MCP_CONFIG"

echo "M24 now requires mcp:read + mcp:write client scopes."
echo "Reconnect Google Master MCP ONCE in ChatGPT to obtain the client write scope."
echo "Thereafter operations execute directly. No browser approval per mutation."
echo "Google connection, 23 personal scopes and existing D1 records are preserved."
