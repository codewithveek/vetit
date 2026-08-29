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
# The address TrueForge is told to reach these servers on. Loopback is right
# when TrueForge runs on this machine. A TrueForge in a container needs an
# address that means "the host" from inside it — host.docker.internal on
# Docker Desktop — or every connector it registers points at itself.
ADVERTISED_HOST="${VETIT_ADVERTISED_HOST:-127.0.0.1}"
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
SKILL_DESCRIPTION="Review an MCP server before it is trusted, and produce a least-privilege permission list a human approves."
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
# which is what "no TrueForge running" looks like — and 3 on a 409, so a caller
# can upgrade a create into a replace.
send_json() {
  local method="$1" label="$2" url="$3" body="$4"
  local response_file code status
  response_file="$(mktemp)"
  status=0
  # `|| status=$?` rather than `set +e`: errexit is global, so a helper that
  # switched it back on left it armed in its caller, and the next non-zero
  # return killed the whole script silently.
  code="$(curl -sS -o "$response_file" -w '%{http_code}' --max-time 20 \
    -X "$method" "$url" -H 'content-type: application/json' -d "$body")" || status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$response_file"
    return 2
  fi
  if [ "$code" = '409' ]; then
    rm -f "$response_file"
    return 3
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

# Setup gets re-run — after a reboot, after a port change, by a judge reading
# the README twice. Creating is not idempotent and a second run died on
# "name already exists", so a conflict becomes a replace.
post_json() {
  local label="$1" url="$2" body="$3"
  local status
  status=0
  send_json POST "$label" "$url" "$body" || status=$?
  if [ "$status" -ne 3 ]; then return "$status"; fi
  echo "  (already registered — replacing)"
  status=0
  send_json PUT "$label" "$url" "$body" || status=$?
  return "$status"
}

# Agents are replaced by immutable id rather than by name, so a conflict here
# means looking the id up first.
upsert_agent() {
  local manifest="$1" status agent_id
  status=0
  send_json POST "agent creation" \
    "${TRUEFORGE_BASE_URL}/api/v1/agents" \
    "{\"name\":\"vetit\",\"manifest\":${manifest}}" || status=$?
  if [ "$status" -ne 3 ]; then return "$status"; fi

  echo "  (agent exists — replacing its manifest)"
  agent_id="$(curl -sS --max-time 20 "${TRUEFORGE_BASE_URL}/api/v1/agents" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const found = JSON.parse(raw).data.find((agent) => agent.name === "vetit");
      process.stdout.write(found === undefined ? "" : found.id);
    });
  ')"
  if [ -z "$agent_id" ]; then
    printf '  agent update failed: the name is taken but no agent named vetit was listed\n' >&2
    return 1
  fi
  status=0
  send_json PUT "agent update" \
    "${TRUEFORGE_BASE_URL}/api/v1/agents/${agent_id}" \
    "{\"manifest\":${manifest}}" || status=$?
  return "$status"
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
connector_status=0
post_json "connector registration" \
  "${TRUEFORGE_BASE_URL}/api/v1/settings/mcp-servers" \
  "{\"manifest\":{\"type\":\"remote\",\"name\":\"vetit\",\"url\":\"http://${ADVERTISED_HOST}:${VETIT_PORT}/mcp\",\"description\":\"Vetit - reviews an MCP server before it is trusted.\"}}" \n  || connector_status=$?
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
  skill_status=0
  post_json "skill registration" \
    "${TRUEFORGE_BASE_URL}${SKILLS_ENDPOINT}" \
    "{\"manifest\":{\"type\":\"git\",\"name\":\"${SKILL_NAME}\",\"url\":\"${SKILL_REPO_URL}\",\"ref\":\"${SKILL_REF}\",\"path\":\"${SKILL_PATH}\",\"description\":\"${SKILL_DESCRIPTION}\"}}" \n    || skill_status=$?
  if [ "$skill_status" -ne 0 ]; then
    fail "Skill registration failed. The agent was not created, because it would have had no review playbook."
  fi

  # The agent manifest names `exa` for the advisory cross-check, and TrueForge
  # refuses to create an agent that references a connector nobody registered.
  # Exa needs a key we have no business inventing, so it is registered when one
  # is supplied and dropped from the manifest when it is not — a review that
  # runs without the cross-check, rather than a setup that will not run.
  EXA_READY=0
  if [ -n "${EXA_API_KEY:-}" ]; then
    log "Registering the exa connector"
    exa_status=0
    post_json "exa registration" \
      "${TRUEFORGE_BASE_URL}/api/v1/settings/mcp-servers" \
      "{\"manifest\":{\"type\":\"remote\",\"name\":\"exa\",\"url\":\"${EXA_MCP_URL:-https://mcp.exa.ai/mcp}\",\"description\":\"Exa search, used for the advisory cross-check.\",\"auth\":{\"type\":\"header\",\"headers\":{\"Authorization\":\"Bearer ${EXA_API_KEY}\"}}}}" \n      || exa_status=$?
    if [ "$exa_status" -ne 0 ]; then
      fail "exa registration failed. Unset EXA_API_KEY to set up without the cross-check pass."
    fi
    EXA_READY=1
  fi

  log "Creating the Vetit agent"
  AGENT_MANIFEST="$(EXA_READY="$EXA_READY" node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync("agent/vetit-agent.json", "utf8"));
    if (process.env.EXA_READY !== "1") {
      manifest.mcp_servers = manifest.mcp_servers.filter((s) => s.name !== "exa");
    }
    process.stdout.write(JSON.stringify(manifest));
  ')"
  agent_status=0
  upsert_agent "$AGENT_MANIFEST" || agent_status=$?
  if [ "$agent_status" -ne 0 ]; then
    fail "Agent creation failed — the response above says why. The two
prerequisites TrueForge will not create an agent without:

  * a model provider, for the model named in agent/vetit-agent.json
  * a sandbox provider, because the review playbook is a git-backed skill and
    skills are materialised in a sandbox

TrueForge falls back to a local sandbox on macOS and Linux with nothing to
configure. On Windows there is no local provider, so a sandbox has to be
registered before the agent will accept the skill.

Configure both in TrueForge settings, then run this again."
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
  if [ "$EXA_READY" -ne 1 ]; then
    cat <<NO_EXA

  No EXA_API_KEY was set, so the agent was created without the exa connector.
  Every pass runs except the advisory cross-check, and the report will say so.
NO_EXA
  fi
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
