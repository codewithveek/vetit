import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { readScanCoverage, readStoredFindings } from '../detection/index.js';
import { readStoredManifest } from '../manifest/index.js';
import { buildGuardedToolResult } from '../../shared/redaction/index.js';
import {
  registerQuarantinedServer,
  writeAgentServerEntry,
} from '../../shared/trueforge-client/index.js';
import { buildScopedGrant } from './build-grant.js';
import { findReasonToRefuse } from './refuse-to-apply.js';

/**
 * The two tools that change something, and the two that therefore pause.
 *
 * `quarantine_server` and `write_admission` are annotated honestly as writes.
 * The agent spec gates them by literal tool name rather than by the `@write`
 * group, on purpose: a project about servers that lie in their labels must not
 * depend on labels for its own approval settings.
 */

const authSchema = z
  .unknown()
  .optional()
  .describe(
    'Auth block passed straight to the harness and never read back. Use a ' +
      'throwaway credential with the smallest access that works.',
  );

const agentNameSchema = z
  .string()
  .describe(
    'Agent the hold is written to. Tool permissions live on an agent, not on ' +
      'a connector, so this is the subject of the restriction.',
  );

interface QuarantineRequest {
  readonly url: string;
  readonly name: string;
  readonly agentName: string;
  readonly auth?: unknown;
}

/**
 * Register, then hold — two objects, because the harness keeps them apart.
 *
 * The connector says where the server is and carries the credential. The
 * agent's entry says what may be called. Registering alone leaves a server
 * attached to nothing, which is already unreachable; the explicit
 * `disable_tools: ["@all"]` is written so the hold is visible to anyone
 * reading the agent rather than inferred from an absence.
 */
async function holdServer(request: QuarantineRequest): Promise<CallToolResult> {
  const connector = await registerQuarantinedServer({
    name: request.name,
    url: request.url,
    ...(request.auth === undefined ? {} : { auth: request.auth }),
  });
  const agent = await writeAgentServerEntry({
    agentName: request.agentName,
    entry: { name: connector.name, disable_tools: ['@all'] },
  });
  return buildGuardedToolResult({
    connector: connector.name,
    agent: agent.name,
    status: 'on_hold',
    disable_tools: ['@all'],
    note:
      'Held with disable_tools ["@all"], not enable_tools []. An absent ' +
      'enable_tools falls back to ["@all"], and disable_tools is subtracted ' +
      'from whatever is enabled, so this phrasing is the only one that leaves ' +
      'nothing callable. The credential, if any, went to the harness with the ' +
      'connector and was never read back.',
  });
}

function registerQuarantine(server: McpServer): void {
  server.registerTool(
    'quarantine_server',
    {
      title: 'Quarantine server',
      description:
        'Stage 1: registers a target as a TrueForge connector and writes it ' +
        'into an agent with every tool switched off. The harness stores the ' +
        'credential; Vetit never sees it. Every server lands here first.',
      inputSchema: {
        url: z.string().url().describe('Streamable HTTP endpoint of the target.'),
        name: z.string().describe('Connector name to register it under.'),
        agent_name: agentNameSchema,
        auth: authSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, name, agent_name, auth }) =>
      await holdServer({
        url,
        name,
        agentName: agent_name,
        ...(auth === undefined ? {} : { auth }),
      }),
  );
}

const admissionInput = {
  manifest_id: z.string().describe('Manifest the decision is based on.'),
  connector_name: z.string().describe('Connector the review was performed on.'),
  agent_name: agentNameSchema,
  not_covered: z
    .array(z.string())
    .default([])
    .describe(
      'What the review could not check — for example behavioural ' +
        'verification when no credential was supplied. Recorded on the grant.',
    ),
  apply: z
    .boolean()
    .default(false)
    .describe(
      'False proposes the grant without writing it. True writes it to the ' +
        'connector, which is what actually lets the server out of quarantine.',
    ),
};

interface WriteAdmissionRequest {
  readonly connectorName: string;
  readonly agentName: string;
  readonly notCovered: readonly string[];
  readonly apply: boolean;
}

interface WriteAdmissionOptions {
  readonly manifestId: string;
  readonly request: WriteAdmissionRequest;
}

/**
 * Propose, then apply — and the gap between the two is where the checks live.
 *
 * A proposal is always available and costs nothing. Applying releases a server
 * from quarantine, so it happens only once the review is complete and the
 * connector is the one that was actually reviewed.
 */
async function handleWriteAdmission(
  options: WriteAdmissionOptions,
): Promise<CallToolResult> {
  const { manifestId, request } = options;
  const manifest = await readStoredManifest(manifestId);
  const coverage = await readScanCoverage(manifestId);
  const grant = buildScopedGrant({
    connectorName: request.connectorName,
    manifest,
    findings: await readStoredFindings(manifestId),
    detectorsRun: coverage.detectorsRun,
    notCovered: request.notCovered,
  });

  if (!request.apply) {
    return buildGuardedToolResult({
      applied: false,
      grant,
      note: 'Proposed only. Call again with apply true to write it.',
    });
  }

  const refusal = await findReasonToRefuse({
    manifest,
    connectorName: request.connectorName,
    detectorsRun: coverage.detectorsRun,
  });
  if (refusal !== undefined) {
    return buildGuardedToolResult({ applied: false, refused: refusal, grant });
  }

  const agent = await writeAgentServerEntry({
    agentName: request.agentName,
    entry: {
      name: grant.name,
      enable_tools: [...grant.enable_tools],
      disable_tools: [...grant.disable_tools],
      require_approval_for_tools: [...grant.require_approval_for_tools],
    },
  });
  return buildGuardedToolResult({
    applied: true,
    connector: grant.name,
    agent: agent.name,
    grant,
  });
}

function registerWriteAdmission(server: McpServer): void {
  server.registerTool(
    'write_admission',
    {
      title: 'Write admission',
      description:
        'Stage 3: builds the least-privilege permission list from the ' +
        'recorded findings and, when apply is true, writes it into the ' +
        "agent's entry for this server. Every restriction cites the finding " +
        'that caused it.',
      inputSchema: admissionInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ manifest_id, connector_name, agent_name, not_covered, apply }) =>
      await handleWriteAdmission({
        manifestId: manifest_id,
        request: {
          connectorName: connector_name,
          agentName: agent_name,
          notCovered: not_covered,
          apply,
        },
      }),
  );
}

export function registerAdmissionTools(server: McpServer): void {
  registerQuarantine(server);
  registerWriteAdmission(server);
}
