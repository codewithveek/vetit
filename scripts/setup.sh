#!/usr/bin/env bash
# One command: build both packages, start them, register everything, and
# create the Vetit agent.
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
STARTUP_TIMEOUT="${VETIT_STARTUP_TIMEOUT:-30}"
# The decoy runs on this machine, so loopback is reachable. A target on another
# host or in a container would need VETIT_COLLECTOR_PUBLIC_URL set to an address
# it can actually call, or egress is reported as not observed rather than clean.
COLLECTOR_PUBLIC_URL="${VETIT_COLLECTOR_PUBLIC_URL:-http://127.0.0.1:${COLLECTOR_PORT}/collect}"
CANARY_VALUE="${VETIT_CANARY_VALUE:-vetit-canary-not-a-real-secret}"

# The skill is registered from git, so TrueForge needs somewhere to fetch it
# from: an HTTPS repo url, a path inside it, and a ref. The agent manifest only
# names the skill — that name resolves to nothing until this registration
# exists, so it has to happen before the agent is created.
SKILL_NAME="vetit-review"
SKILL_PATH="${VETIT_SKILL_PATH:-skills/vetit-review}"
SKILL_REF="${VETIT_SKILL_REF:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
SKILLS_ENDPOINT="${TRUEFORGE_SKILLS_PATH:-/api/v1/settings/skills}"

log() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

# git remotes are commonly ssh; TrueForge clones over https.
to_https_repo_url() {
  local url="$1"
  url="${url%.git}"
  case "$url" in
    git@*) url="${url#git@}"; url="https://${url/://}" ;;
    ssh://git@*) url="https://${url#ssh://git@}" ;;
  esac
  printf '%s' "$url"
}

SKILL_REPO_URL="${VETIT_SKILL_REPO_URL:-$(to_https_repo_url "$(git -C "$ROOT" config --get remote.origin.url 2>/dev/null || true)")}"

# --- http -------------------------------------------------------------------
#
# curl exits 0 for any HTTP response it managed to receive, 4xx and 5xx
# included. Without checking the status code a rejected registration looked
# exactly like a successful one, and setup went on to print "Ready".
#
# Returns 0 on 2xx, 1 on an HTTP error, 2 when no response arrived at all —
# which is what "no TrueForge running" looks like.
post_json() {
  local label="$1" url="$2" body="$3"
  local response_file code status
  response_file="$(mktemp)"
  set +e
  code="$(curl -sS -o "$response_file" -w '%{http_code}' --max-time 20 \
    -X POST "$url" -H 'content-type: application/json' -d "$body")"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    rm -f "$response_file"
    return 2
  fi
  if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
    printf '  %s failed: HTTP %s\n' "$label" "$code" >&2
    sed -e 's/^/    /' "$response_file" >&2
    rm -f "$response_file"
    return 1
  fi
  rm -f "$response_file"
  return 0
}

# --- servers ----------------------------------------------------------------

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

# A fixed sleep is a guess. If a port was taken the process is already gone by
# the time registration runs, and the script would announce readiness for a
# server nobody can reach. Watch the pid and the port instead, and give up
# rather than carry on.
wait_for_server() {
  local name="$1" pid="$2" url="$3"
  local deadline=$(( SECONDS + STARTUP_TIMEOUT ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '  %s exited during startup — see the output above; an occupied port is the usual cause\n' "$name" >&2
      return 1
    fi
    # Any HTTP response means the listener is up. An MCP endpoint answers a
    # bare GET with an error, and an error is an answer.
    if curl -s -o /dev/null --max-time 2 "$url"; then
      return 0
    fi
    sleep 0.25
  done
  printf '  %s did not answer at %s within %ss\n' "$name" "$url" "$STARTUP_TIMEOUT" >&2
  return 1
}

log "Waiting for both servers"
wait_for_server "vetit-mcp" "$VETIT_PID" "http://127.0.0.1:${VETIT_PORT}/mcp" \
  || fail "vetit-mcp did not start. Nothing was registered."
wait_for_server "vetit-decoy-mcp" "$DECOY_PID" "http://127.0.0.1:${DECOY_PORT}/mcp" \
  || fail "vetit-decoy-mcp did not start. Nothing was registered."

# --- trueforge --------------------------------------------------------------

TRUEFORGE_REACHABLE=1

log "Registering the Vetit MCP server as a TrueForge connector"
set +e
post_json "connector registration" \
  "${TRUEFORGE_BASE_URL}/api/v1/settings/mcp-servers" \
  "{\"name\":\"vetit\",\"url\":\"http://127.0.0.1:${VETIT_PORT}/mcp\"}"
connector_status=$?
set -e
case "$connector_status" in
  0) ;;
  2) TRUEFORGE_REACHABLE=0; echo "  (skipped — no TrueForge at ${TRUEFORGE_BASE_URL})" ;;
  *) fail "Connector registration was rejected. The agent was not created." ;;
esac

if [ "$TRUEFORGE_REACHABLE" -eq 1 ]; then
  log "Registering the ${SKILL_NAME} skill"
  if [ -z "$SKILL_REPO_URL" ]; then
    fail "No git remote, so the skill has no repository to be fetched from. Set VETIT_SKILL_REPO_URL to an HTTPS url TrueForge can clone, then run this again."
  fi
  echo "  ${SKILL_REPO_URL} — ${SKILL_PATH} @ ${SKILL_REF}"
  set +e
  post_json "skill registration" \
    "${TRUEFORGE_BASE_URL}${SKILLS_ENDPOINT}" \
    "{\"name\":\"${SKILL_NAME}\",\"repository_url\":\"${SKILL_REPO_URL}\",\"path\":\"${SKILL_PATH}\",\"ref\":\"${SKILL_REF}\"}"
  skill_status=$?
  set -e
  if [ "$skill_status" -ne 0 ]; then
    fail "Skill registration failed. The agent was not created, because it would have had no review playbook."
  fi

  log "Creating the Vetit agent"
  set +e
  post_json "agent creation" \
    "${TRUEFORGE_BASE_URL}/api/v1/agents" \
    "{\"name\":\"vetit\",\"manifest\":$(cat agent/vetit-agent.json)}"
  agent_status=$?
  set -e
  if [ "$agent_status" -ne 0 ]; then
    fail "Agent creation failed."
  fi
fi

log "Ready"
cat <<BANNER

  vetit-mcp        http://127.0.0.1:${VETIT_PORT}/mcp
  vetit-decoy-mcp  http://127.0.0.1:${DECOY_PORT}/mcp   (deliberately unsafe)
  tripwire         http://127.0.0.1:${COLLECTOR_PORT}/collect
BANNER

if [ "$TRUEFORGE_REACHABLE" -eq 1 ]; then
  cat <<AGENT_READY

  Ask the agent:  review the MCP server at http://127.0.0.1:${DECOY_PORT}/mcp
AGENT_READY
else
  cat <<NO_TRUEFORGE

  No TrueForge at ${TRUEFORGE_BASE_URL}, so the skill, the connector and the
  agent were NOT registered. Both servers are running and can be driven by any
  MCP client directly.
NO_TRUEFORGE
fi

cat <<HINTS

  To see the label lie caught, the probe needs a reader nominated:
      probe_tool tool_name=export_all read_back_tool=list_spaces
  Without one it can only report an unverified indication, which is the
  honest limit of what a probe can say on its own.

  A tool that does not claim readOnlyHint: true is refused unless you also pass
  allow_non_read_only=true. It is off by default because such a tool will write.

  To see the rug pull, restart the decoy with --poison and fetch it again.

  Ctrl-C to stop both servers.
HINTS

wait
