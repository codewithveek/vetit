#!/usr/bin/env bash
# Kept because the spec names this path. The setup itself is Node — see
# scripts/setup.js — so there is one implementation rather than two that drift,
# and so it runs the same way on Windows, where bash is not a given.
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/setup.js" "$@"
