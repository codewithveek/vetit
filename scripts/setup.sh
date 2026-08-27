#!/usr/bin/env bash
# One command: build both packages, start them, and create the Vetit agent.
#
# Everything binds to loopback. The decoy is deliberately unsafe — that is the
# whole point of it — so nothing here is reachable from another machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TRUEFORGE_BASE_URL="${TRUEFORGE_BASE_URL:-http://localhost:8790}"
VETIT_PORT="${VETIT_PORT:-8930}"
DECOY_PORT="${DECOY_PORT:-8931}"
COLLECTOR_PORT="${VETIT_COLLECTOR_PORT:-8999}"
# The decoy runs on this machine, so loopback is reachable. A target on another
# host or in a container would need VETIT_COLLECTOR_PUBLIC_URL set to an address
# it can actually call, or egress is reported as not observed rather than clean.
COLLECTOR_PUBLIC_URL="${VETIT_COLLECTOR_PUBLIC_URL:-http://127.0.0.1:${VETIT_COLLECTOR_PORT:-8999}/collect}"
CANARY_VALUE="${VETIT_CANARY_VALUE:-vetit-canary-not-a-real-secret}"

log() { printf '\n\033[1m%s\033[0m\n' "$*"; }

log "Installing dependencies"
npm install

log "Building both packages"
npm run build

log "Starting vetit-mcp on 127.0.0.1:${VETIT_PORT}"
VETIT_COLLECTOR_PORT="$COLLECTOR_PORT" \
VETIT_COLLECTOR_PUBLIC_URL="$COLLECTOR_PUBLIC_URL" \
VETIT_CANARY_VALUE="$CANARY_VALUE" \
  node packages/vetit-mcp/dist/index.js --port "$VETIT_PORT" &
VETIT_PID=$!

# The decoy is pointed at Vetit's tripwire collector and given a worthless
# secret to steal, so that probe_tool has something to catch it doing.
log "Starting vetit-decoy-mcp on 127.0.0.1:${DECOY_PORT}"
VETIT_DECOY_COLLECTOR_URL="http://127.0.0.1:${COLLECTOR_PORT}/collect" \
VETIT_CANARY_TOKEN="$CANARY_VALUE" \
  node packages/vetit-decoy-mcp/dist/index.js --port "$DECOY_PORT" &
DECOY_PID=$!

cleanup() {
  log "Stopping servers"
  kill "$VETIT_PID" "$DECOY_PID" 2>/dev/null || true
}
trap cleanup EXIT

sleep 2

log "Registering the Vetit MCP server as a TrueForge connector"
curl -sS -X POST "${TRUEFORGE_BASE_URL}/api/v1/settings/mcp-servers" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"vetit\",\"url\":\"http://127.0.0.1:${VETIT_PORT}/mcp\"}" \
  || echo "  (skipped — no TrueForge at ${TRUEFORGE_BASE_URL})"

log "Creating the Vetit agent"
curl -sS -X POST "${TRUEFORGE_BASE_URL}/api/v1/agents" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"vetit\",\"manifest\":$(cat agent/vetit-agent.json)}" \
  || echo "  (skipped — no TrueForge at ${TRUEFORGE_BASE_URL})"

log "Ready"
cat <<EOF

  vetit-mcp        http://127.0.0.1:${VETIT_PORT}/mcp
  vetit-decoy-mcp  http://127.0.0.1:${DECOY_PORT}/mcp   (deliberately unsafe)
  tripwire         http://127.0.0.1:${COLLECTOR_PORT}/collect

  Ask the agent:  review the MCP server at http://127.0.0.1:${DECOY_PORT}/mcp

  To see the label lie caught, the probe needs a reader nominated:
      probe_tool tool_name=export_all read_back_tool=list_spaces
  Without one it can only report an unverified indication, which is the
  honest limit of what a probe can say on its own.

  To see the rug pull, restart the decoy with --poison and fetch it again.

  Ctrl-C to stop both servers.
EOF

wait
