import {
  buildTrueforgeHeaders,
  resolveTrueforgeEndpoint,
} from './trueforge.config.js';
import {
  mcpServerRecordSchema,
  mcpServerToolsResponseSchema,
  type McpServerRecord,
  type McpServerTool,
} from './trueforge.schema.js';

/**
 * The admin API client.
 *
 * Two-stage registration lives here (spec §6): a server is registered with
 * every tool switched off, its tools are listed *by the harness* so the
 * credential resolves server-side, and only then can a permission list be
 * written. Vetit never sees the key at any point in that sequence.
 */

const MCP_SERVERS_PATH = '/api/v1/settings/mcp-servers';

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

async function callTrueforge(request: TrueforgeRequest): Promise<unknown> {
  const endpoint = resolveTrueforgeEndpoint();
  const response = await fetch(`${endpoint.baseUrl}${request.path}`, {
    method: request.method,
    headers: buildTrueforgeHeaders(endpoint),
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
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

/** Stage 1 of §6. `disable_tools: ["@all"]`, never `enable_tools: []`. */
export interface QuarantineRegistration {
  readonly name: string;
  readonly url: string;
  /** Handed straight to the harness and never read back. */
  readonly auth?: unknown;
}

export async function registerQuarantinedServer(
  registration: QuarantineRegistration,
): Promise<McpServerRecord> {
  const payload = {
    name: registration.name,
    url: registration.url,
    disable_tools: ['@all'],
    ...(registration.auth === undefined ? {} : { auth: registration.auth }),
  };
  const raw = await callTrueforge({
    path: MCP_SERVERS_PATH,
    method: 'POST',
    body: payload,
  });
  return mcpServerRecordSchema.parse(raw);
}

/** Stage 2 of §6: the harness resolves the credential and lists the tools. */
export async function listConnectorTools(
  connectorName: string,
): Promise<readonly McpServerTool[]> {
  const raw = await callTrueforge({
    path: `${MCP_SERVERS_PATH}/${encodeURIComponent(connectorName)}/tools`,
    method: 'GET',
  });
  return mcpServerToolsResponseSchema.parse(raw).tools;
}

export async function readConnector(
  connectorName: string,
): Promise<McpServerRecord> {
  const raw = await callTrueforge({
    path: `${MCP_SERVERS_PATH}/${encodeURIComponent(connectorName)}`,
    method: 'GET',
  });
  return mcpServerRecordSchema.parse(raw);
}

/** Stage 3 of §6: coming off hold, with a written list of what is allowed. */
export interface ConnectorPermissions {
  readonly name: string;
  readonly enableTools: readonly string[];
  readonly disableTools: readonly string[];
  readonly requireApprovalForTools: readonly string[];
}

export async function writeConnectorPermissions(
  permissions: ConnectorPermissions,
): Promise<McpServerRecord> {
  const raw = await callTrueforge({
    path: MCP_SERVERS_PATH,
    method: 'PUT',
    body: {
      name: permissions.name,
      enable_tools: [...permissions.enableTools],
      disable_tools: [...permissions.disableTools],
      require_approval_for_tools: [...permissions.requireApprovalForTools],
    },
  });
  return mcpServerRecordSchema.parse(raw);
}

export interface AgentServerBlockUpdate {
  readonly agentId: string;
  readonly mcpServers: readonly unknown[];
}

export async function updateAgentServerBlock(
  update: AgentServerBlockUpdate,
): Promise<void> {
  await callTrueforge({
    path: `/api/v1/agents/${encodeURIComponent(update.agentId)}`,
    method: 'PUT',
    body: { mcp_servers: [...update.mcpServers] },
  });
}
