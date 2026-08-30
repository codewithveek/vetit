import { z } from 'zod';

/**
 * What the harness sends back, checked rather than assumed.
 *
 * These are deliberately loose about fields Vetit does not use — the admin API
 * is free to grow — and strict about the ones it does.
 *
 * Every response is wrapped in `data`. That is not decoration: reading the
 * body directly parsed a `{ data: … }` envelope as an empty record and then
 * reported the empty record as the answer.
 */

/**
 * Passthrough, like everything else that carries a target's own words.
 *
 * This dropped `title`, `outputSchema` and any field the harness or the target
 * added — so the connector path produced a thinner manifest than the direct
 * one, and the file called the raw manifest was missing text a reviewer would
 * want to read.
 */
export const mcpServerToolSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.unknown().optional(),
    annotations: z.unknown().optional(),
  })
  .passthrough();

export const mcpServerToolsResponseSchema = z.object({
  data: z.array(mcpServerToolSchema),
});

/**
 * A connector says where a server is and how to authenticate to it. That is
 * all it says: there is no `enable_tools` on this object and no
 * `disable_tools` either, and the schema rejects unknown fields outright.
 * Which tools an agent may call is a property of the *agent*, below.
 */
export const connectorManifestSchema = z
  .object({
    type: z.string(),
    name: z.string(),
    url: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

export const configuredConnectorSchema = z
  .object({
    name: z.string(),
    manifest: connectorManifestSchema,
  })
  .passthrough();

export const connectorResponseSchema = z.object({ data: configuredConnectorSchema });

/**
 * One server as an agent sees it — and the only place tool gating exists.
 *
 * `enable_tools` defaults to `["@all"]` when absent, and `disable_tools` is
 * subtracted from whatever is enabled. That is why §6 insists on
 * `disable_tools: ["@all"]` and never `enable_tools: []`: an absent
 * `enable_tools` falls back to everything, so the subtractive phrasing is the
 * only one that leaves nothing callable.
 */
export const agentServerEntrySchema = z
  .object({
    name: z.string(),
    enable_tools: z.array(z.string()).optional(),
    disable_tools: z.array(z.string()).optional(),
    require_approval_for_tools: z.array(z.string()).optional(),
  })
  .passthrough();

export const agentSpecSchema = z
  .object({
    mcp_servers: z.array(agentServerEntrySchema).optional(),
  })
  .passthrough();

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  manifest: agentSpecSchema,
});

export const listAgentsResponseSchema = z.object({ data: z.array(agentSchema) });
export const agentResponseSchema = z.object({ data: agentSchema });

export type ConfiguredConnector = z.infer<typeof configuredConnectorSchema>;
export type McpServerTool = z.infer<typeof mcpServerToolSchema>;
export type AgentServerEntry = z.infer<typeof agentServerEntrySchema>;
export type AgentSpec = z.infer<typeof agentSpecSchema>;
export type TrueforgeAgent = z.infer<typeof agentSchema>;
