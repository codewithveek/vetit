import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildGuardedToolResult } from '../../shared/redaction/index.js';
import { fetchManifest } from './fetch-manifest.service.js';

/**
 * MCP wiring for the manifest feature.
 *
 * Note the annotations. A project about servers that lie in their labels has
 * to get its own right, so every tool here is annotated honestly and every
 * annotation is true of what the handler does.
 */

const fetchManifestInput = {
  url: z
    .string()
    .url()
    .optional()
    .describe('Streamable HTTP endpoint of the server to review.'),
  connector_name: z
    .string()
    .optional()
    .describe(
      'TrueForge connector to route through, so the credential resolves ' +
        'server-side and never reaches Vetit. Supply this or url.',
    ),
};

export function registerManifestTools(server: McpServer): void {
  server.registerTool(
    'fetch_manifest',
    {
      title: 'Fetch manifest',
      description:
        'Lists everything a target MCP server offers and writes the raw ' +
        'result to a file. Returns counts and hashes only — no text the ' +
        'target wrote is returned, because that text is the attack.',
      inputSchema: fetchManifestInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, connector_name }) =>
      buildGuardedToolResult(
        await fetchManifest({ url, connectorName: connector_name }),
      ),
  );
}
