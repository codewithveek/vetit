import {
  buildTrueforgeHeaders,
  resolveTrueforgeEndpoint,
} from './trueforge.config.js';
import { normaliseUrl } from '../url/index.js';
import {
  agentResponseSchema,
  connectorResponseSchema,
  listAgentsResponseSchema,
  mcpServerToolsResponseSchema,
  type AgentServerEntry,
  type ConfiguredConnector,
  type McpServerTool,
  type TrueforgeAgent,
} from './trueforge.schema.js';

/**
 * The admin API client.
 *
 * Two-stage registration lives here (spec §6): a server is registered with
 * every tool switched off, its tools are listed *by the harness* so the
 * credential resolves server-side, and only then can a permission list be
 * written. Vetit never sees the key at any point in that sequence.
 *
 * One thing the spec got wrong about the harness, found by running against a
 * real one rather than by reading. A connector carries `type`, `name`, `url`,
 * `description` and `auth`, and nothing else — the schema is closed, so a
 * `disable_tools` sent alongside them is a 400, not an ignored field. Tool
 * gating is a property of an **agent**: `enable_tools`, `disable_tools` and
 * `require_approval_for_tools` live on the agent's `mcp_servers` entry.
 *
 * The security model is untouched by that. Vetit still never holds a
 * credential, servers are still held with everything switched off before
 * anything else happens, and the hold is still written as
 * `disable_tools: ["@all"]` rather than `enable_tools: []`. Only the object
 * carrying the grant is different, and it is different because that is where
 * the harness keeps it.
 */

const CONNECTORS_PATH = '/api/v1/settings/mcp-servers';
/** Listing a connector's tools is not under `/settings` — a 404 taught us. */
const CONNECTOR_TOOLS_PATH = '/api/v1/mcp-servers';
const AGENTS_PATH = '/api/v1/agents';
const CONFLICT_STATUS = 409;

export interface TrueforgeRequest {
  readonly path: string;
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly body?: unknown;
}

export class TrueforgeRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TrueforgeRequestError';
    this.status = status;
  }
}

/**
 * The same deadline the direct listing path uses.
 *
 * `fetch` has no timeout of its own, so an unresponsive admin API left a
 * connector-mode review pending for however long the HTTP stack felt like —
 * making the connector path far less bounded than the direct one, which has
 * always had 20 seconds. Overridable, because an admin API behind a slow link
 * is a configuration problem rather than a code one.
 */
const DEFAULT_TIMEOUT_MS = 20_000;
const TIMEOUT_STATUS = 504;

function resolveTimeoutMs(): number {
  const configured = Number.parseInt(process.env['TRUEFORGE_TIMEOUT_MS'] ?? '', 10);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

async function sendTrueforgeRequest(request: TrueforgeRequest): Promise<Response> {
  const endpoint = resolveTrueforgeEndpoint();
  const timeoutMs = resolveTimeoutMs();
  try {
    return await fetch(`${endpoint.baseUrl}${request.path}`, {
      method: request.method,
      headers: buildTrueforgeHeaders(endpoint),
      signal: AbortSignal.timeout(timeoutMs),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
  } catch (error) {
    if (isTimeout(error)) {
      throw new TrueforgeRequestError(
        TIMEOUT_STATUS,
        `${request.method} ${request.path} timed out after ${String(timeoutMs)}ms.`,
      );
    }
    throw error;
  }
}

async function callTrueforge(request: TrueforgeRequest): Promise<unknown> {
  const response = await sendTrueforgeRequest(request);
  if (!response.ok) {
    const detail = await response.text();
    throw new TrueforgeRequestError(
      response.status,
      `${request.method} ${request.path} failed: ${response.status} ${detail.slice(0, 200)}`,
    );
  }
  if (response.status === 204) return undefined;
  return await response.json();
}

/** Stage 1 of §6. The connector, and only what a connector can carry. */
export interface QuarantineRegistration {
  readonly name: string;
  readonly url: string;
  /** Handed straight to the harness and never read back. */
  readonly auth?: unknown;
}

const HOLD_DESCRIPTION =
  'Registered by Vetit for review. Not attached to any agent until a human ' +
  'approves a grant.';

function buildConnectorManifest(
  registration: QuarantineRegistration,
): Record<string, unknown> {
  return {
    type: 'remote',
    name: registration.name,
    url: registration.url,
    description: HOLD_DESCRIPTION,
    ...(registration.auth === undefined ? {} : { auth: registration.auth }),
  };
}

/**
 * A name already taken is not automatically the same server.
 *
 * A connector is global; the permissions that gate it are per-agent. So
 * replacing a connector on a name conflict — which is what a re-run looks like
 * — could point an existing, *enabled* connector at a new URL and new
 * credentials on every other agent using it, while quarantining only the agent
 * named here. The hold would look applied and the tools would keep being
 * callable, now against somewhere else. Quarantine defeated by the step meant
 * to establish it.
 *
 * So a conflict is resolved by reading rather than writing: same endpoint means
 * this really is the re-run it looks like, and anything else is refused.
 */
async function resolveConflict(
  registration: QuarantineRegistration,
): Promise<ConfiguredConnector> {
  const existing = await readConnector(registration.name);
  if (normaliseUrl(existing.manifest.url) !== normaliseUrl(registration.url)) {
    throw new TrueforgeRequestError(
      CONFLICT_STATUS,
      `A connector named ${registration.name} already exists and points at ` +
        `${existing.manifest.url}, not ${registration.url}. Replacing it would ` +
        'retarget every agent already using that name — including agents this ' +
        'review is not quarantining — so it is refused. Register this target ' +
        'under a different name, or take the existing connector out of service ' +
        'deliberately first.',
    );
  }
  // Same endpoint. With no new credential there is nothing to write, so the
  // quieter path is to leave it alone; a supplied credential is an explicit
  // request to set or rotate one, and the URL is unchanged either way.
  if (registration.auth === undefined) return existing;
  const raw = await callTrueforge({
    path: CONNECTORS_PATH,
    method: 'PUT',
    body: { manifest: buildConnectorManifest(registration) },
  });
  return connectorResponseSchema.parse(raw).data;
}

export async function registerQuarantinedServer(
  registration: QuarantineRegistration,
): Promise<ConfiguredConnector> {
  const body = { manifest: buildConnectorManifest(registration) };
  try {
    const raw = await callTrueforge({ path: CONNECTORS_PATH, method: 'POST', body });
    return connectorResponseSchema.parse(raw).data;
  } catch (error) {
    if (!(error instanceof TrueforgeRequestError) || error.status !== CONFLICT_STATUS) {
      throw error;
    }
    return await resolveConflict(registration);
  }
}

/** Stage 2 of §6: the harness resolves the credential and lists the tools. */
export async function listConnectorTools(
  connectorName: string,
): Promise<readonly McpServerTool[]> {
  const raw = await callTrueforge({
    path: `${CONNECTOR_TOOLS_PATH}/${encodeURIComponent(connectorName)}/tools`,
    method: 'GET',
  });
  return mcpServerToolsResponseSchema.parse(raw).data;
}

export async function readConnector(
  connectorName: string,
): Promise<ConfiguredConnector> {
  const raw = await callTrueforge({
    path: `${CONNECTORS_PATH}/${encodeURIComponent(connectorName)}`,
    method: 'GET',
  });
  return connectorResponseSchema.parse(raw).data;
}

/**
 * Agents are addressed by an immutable id, and named by a human. Everything
 * Vetit is told refers to the name, so the id is looked up rather than asked
 * for.
 */
export async function findAgentByName(agentName: string): Promise<TrueforgeAgent> {
  const raw = await callTrueforge({ path: AGENTS_PATH, method: 'GET' });
  const agent = listAgentsResponseSchema
    .parse(raw)
    .data.find((candidate) => candidate.name === agentName);
  if (agent === undefined) {
    throw new TrueforgeRequestError(
      404,
      `No agent named ${agentName} is configured. A grant has to be written ` +
        'to an agent: that is where the harness keeps tool permissions.',
    );
  }
  return agent;
}

export interface AgentServerEntryUpdate {
  readonly agentName: string;
  readonly entry: AgentServerEntry;
}

function replaceServerEntry(
  agent: TrueforgeAgent,
  entry: AgentServerEntry,
): readonly AgentServerEntry[] {
  const existing = agent.manifest.mcp_servers ?? [];
  const without = existing.filter((candidate) => candidate.name !== entry.name);
  return [...without, entry];
}

/**
 * Read, change one entry, write the whole thing back.
 *
 * The update endpoint replaces an agent's entire manifest, so sending only the
 * server block would delete the model, the instructions and the skills along
 * with it. Everything else is carried through untouched.
 */
async function putServerEntry(
  agent: TrueforgeAgent,
  entry: AgentServerEntry,
): Promise<TrueforgeAgent> {
  const manifest = {
    ...agent.manifest,
    mcp_servers: [...replaceServerEntry(agent, entry)],
  };
  const raw = await callTrueforge({
    path: `${AGENTS_PATH}/${encodeURIComponent(agent.id)}`,
    method: 'PUT',
    body: { manifest },
  });
  return agentResponseSchema.parse(raw).data;
}

/** Two writers in one process is the likely case, and it can be removed. */
const agentWritesInFlight = new Map<string, Promise<unknown>>();

const MAX_REBASE_ATTEMPTS = 3;

/**
 * The manifest we are about to overwrite must be the one we based the edit on.
 *
 * The API has no conditional update: no ETag, no If-Match, no per-entry
 * endpoint, only a whole-manifest PUT. So a read-modify-write can silently
 * drop whatever landed in between — another admission's grant, or a change to
 * the model, the instructions or the skills that has nothing to do with us.
 *
 * Two things narrow that, and it is worth being exact about which:
 *
 *  - writes for one agent are serialised in this process, which removes the
 *    case that actually happens: two tools in a single review interleaving
 *  - before writing, the agent is read again and compared with the snapshot
 *    the edit was built on. If it moved, the edit is rebuilt on the newer one
 *    and retried, so a concurrent change is preserved rather than clobbered
 *
 * What remains is the gap between that last read and the PUT, which cannot be
 * closed from the client. It is small, it is not zero, and saying so is better
 * than implying this is atomic.
 */
async function writeWithRebase(
  update: AgentServerEntryUpdate,
): Promise<TrueforgeAgent> {
  let snapshot = await findAgentByName(update.agentName);
  for (let attempt = 1; attempt <= MAX_REBASE_ATTEMPTS; attempt += 1) {
    const current = await findAgentByName(update.agentName);
    if (JSON.stringify(current.manifest) === JSON.stringify(snapshot.manifest)) {
      return await putServerEntry(current, update.entry);
    }
    snapshot = current;
  }
  throw new TrueforgeRequestError(
    409,
    `Agent ${update.agentName} is being changed by something else — it moved ` +
      `under this update ${String(MAX_REBASE_ATTEMPTS)} times running. ` +
      'Refusing to overwrite newer state with an older manifest. Try again ' +
      'once the other change has settled.',
  );
}

export async function writeAgentServerEntry(
  update: AgentServerEntryUpdate,
): Promise<TrueforgeAgent> {
  const previous = agentWritesInFlight.get(update.agentName);
  const run = (async () => {
    // A failed write must not cancel the one queued behind it.
    if (previous !== undefined) await previous;
    return await writeWithRebase(update);
  })();
  // The tail is stored already-settled so the next writer only waits for the
  // turn, never inherits the failure. Keyed by agent name, so the map holds
  // one entry per agent rather than one per call.
  agentWritesInFlight.set(update.agentName, run.catch(() => undefined));
  return await run;
}
