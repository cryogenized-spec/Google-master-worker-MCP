#!/usr/bin/env bash
# Historical M23 deployment script intentionally disabled.
# M24 replaces the per-action approval architecture with direct OAuth-scoped writes.
set -euo pipefail
echo "The M23 approval-flow deployment has been retired." >&2
echo "Use: bash scripts/release-m24.sh check|stage|promote" >&2
exit 1
