#!/usr/bin/env bash
# M23: one controlled rollout for reads and independently approved writes.
# Keep Cloudflare triggers intact; NEVER use ordinary wrangler deploy.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
ACTION="${1:-check}"
wrangler() { npx --no-install wrangler "$@"; }
MCP_CONFIG=".wrangler-deploy.mcp.jsonc"
SETUP_CONFIG=".wrangler-deploy.setup.jsonc"
DB="google-master-vault"

case "$ACTION" in check|stage|promote) ;; *)
  echo "Usage: bash scripts/release-m23.sh [check|stage|promote]" >&2
  exit 2 ;;
esac
node --version
npm run cloudflare:verify
npm test
npm run test:runtime

if [[ "$ACTION" == "check" ]]; then
  echo "Checks passed. Nothing deployed."
  exit 0
fi

echo "Migration must complete before any write operation is available."
wrangler d1 migrations apply "$DB" --remote -c "$SETUP_CONFIG"

release_dir=".m23-release"
mkdir -p "$release_dir"
chmod 700 "$release_dir"
upload() {
  local role="$1" config="$2" message="$3"
  shift 3
  local log="$release_dir/$role-upload.log" version
  wrangler versions upload -c "$config" --message "$message" "$@" | tee "$log"
  version="$(sed -n 's/^Worker Version ID: //p' "$log" | tail -1)"
  [[ "$version" =~ ^[0-9a-f-]{36}$ ]] || {
    echo "Failed to capture $role version. No deployment." >&2; exit 1;
  }
  printf "%s" "$version" > "$release_dir/$role-version"
  wrangler versions view "$version" -c "$config"
  echo "Inspect secret names, D1/service bindings and env vars above."
}
if [[ "$ACTION" == "stage" ]]; then
  upload "setup" "$SETUP_CONFIG" "M23 private owner approval browser"
  upload "mcp" "$MCP_CONFIG" "M23 broad Workspace reads and approved writes" \
    --var "GMW_WORKSPACE_READS_ENABLED:true" \
    --var "GMW_WRITES_ENABLED:true"
  echo "Both versions are STAGED, not deployed."
  echo "Review the staged versions and run: bash scripts/release-m23.sh promote"
  exit 0
fi

for role in setup mcp; do
  [[ -f "$release_dir/$role-version" ]] || {
    echo "Missing staged version for $role. Run stage first." >&2; exit 1;
  }
done
setup_version="$(cat "$release_dir/setup-version")"
mcp_version="$(cat "$release_dir/mcp-version")"
[[ "$setup_version" =~ ^[0-9a-f-]{36}$ &&
   "$mcp_version" =~ ^[0-9a-f-]{36}$ ]] || exit 1

echo "Promoting private Setup first (owner approval UI)."
wrangler versions deploy "$setup_version@100%" -c "$SETUP_CONFIG"
wrangler deployments status -c "$SETUP_CONFIG"
echo "Promoting protected MCP (only exact, owner-approved writes are allowed)."
wrangler versions deploy "$mcp_version@100%" -c "$MCP_CONFIG"
wrangler deployments status -c "$MCP_CONFIG"
echo "M23 deployed; test read catalogue, write proposal and direct unapproved write DENIAL."
echo "OAuth scopes and encrypted D1 token storage were left untouched."
