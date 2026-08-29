import {
  buildTrueforgeHeaders,
  resolveTrueforgeEndpoint,
} from './trueforge.config.js';
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
 * Registering is a create, and a create fails on a name already taken. A
 * review being re-run is normal, so a conflict upgrades to a replace rather
 * than failing the whole quarantine step.
 */
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
    const raw = await callTrueforge({ path: CONNECTORS_PATH, method: 'PUT', body });
    return connectorResponseSchema.parse(raw).data;
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
export async function writeAgentServerEntry(
  update: AgentServerEntryUpdate,
): Promise<TrueforgeAgent> {
  const agent = await findAgentByName(update.agentName);
  const manifest = {
    ...agent.manifest,
    mcp_servers: [...replaceServerEntry(agent, update.entry)],
  };
  const raw = await callTrueforge({
    path: `${AGENTS_PATH}/${encodeURIComponent(agent.id)}`,
    method: 'PUT',
    body: { manifest },
  });
  return agentResponseSchema.parse(raw).data;
}
