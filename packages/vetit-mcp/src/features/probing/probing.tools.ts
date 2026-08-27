import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mergeStoredFindings, type Finding } from '../detection/index.js';
import { readStoredManifest } from '../manifest/index.js';
import { buildGuardedToolResult } from '../../shared/redaction/index.js';
import { analyseProbe, assessWriteEvidence } from './analyse-probe.js';
import { probeTool, ProbeRefusedError } from './probe-tool.service.js';
import type { ProbeObservation } from './probing.types.js';

/**
 * MCP wiring for probing.
 *
 * `probe_tool` is annotated `destructiveHint: true` and it means it. It calls
 * a tool on a server nobody has decided to trust yet, which can change
 * something on that server's side. The agent spec gates it behind an approval
 * pause by literal name, and the description says plainly what the risk is
 * rather than burying it.
 */

const probeInput = {
  manifest_id: z.string().describe('Manifest identifying the tool to probe.'),
  url: z.string().url().describe('Endpoint of the target. Must be a server you own.'),
  tool_name: z.string().describe('The single tool to call.'),
  connector_name: z
    .string()
    .optional()
    .describe('Connector this target is registered under, recorded on the result.'),
  allow_non_read_only: z
    .boolean()
    .default(false)
    .describe(
      'Probe a tool that does not claim to be read-only. Off by default: a ' +
        'tool that admits it writes will write.',
    ),
  credential_supplied: z
    .boolean()
    .default(false)
    .describe(
      'Declare that a credential was configured for this target. Vetit cannot ' +
        'see whether it is limited, and will say so in the report.',
    ),
};

/** §6: warn whenever Vetit cannot see that the supplied key is limited. */
function buildCredentialWarning(toolName: string): Finding {
  return {
    id: 'F-000',
    detector: 'P-04',
    severity: 'high',
    tool: toolName,
    message:
      'A credential was configured for this target and Vetit cannot see ' +
      'whether it is limited. Probing invites a server you do not trust to ' +
      'act using your access.',
    evidence: {
      path: `probe:${toolName}`,
      jsonPointer: '/probe/credential',
      snippet: '⟦UNTRUSTED_TEXT:  ⟧',
    },
    fix:
      'Use a throwaway credential with the smallest access that works, a ' +
      'short expiry, and cancel it after the review. A test-mode key or a ' +
      'tripwire key is second best. Never probe with a key you would mind ' +
      'losing.',
  };
}

function numberFindings(drafts: readonly Omit<Finding, 'id'>[]): Finding[] {
  return drafts.map((draft, index) => ({
    id: `P-${String(index + 1).padStart(3, '0')}`,
    ...draft,
  }));
}

function describeObservation(observation: ProbeObservation): Record<string, unknown> {
  const evidence = assessWriteEvidence(observation);
  return {
    tool: observation.toolName,
    claimed: {
      read_only: observation.claimedReadOnly ?? null,
      destructive: observation.claimedDestructive ?? null,
    },
    observed: {
      wrote: evidence.observedWrite,
      how: evidence.how,
      read_back_available: observation.readBackBefore !== undefined,
      outgoing_requests: observation.egressHits.length,
      tripwire_value_returned: observation.canaryReturned,
      response_was_error: observation.responseWasError,
      duration_ms: observation.durationMs,
    },
    arguments_sent: observation.argumentsSent,
    response: observation.responseSnippet,
    caveat:
      observation.readBackBefore === undefined
        ? 'No read-only, no-argument tool was available for a read-back, so a ' +
          'write could have happened without being seen. This is a gap in the ' +
          'evidence, not a clean result.'
        : 'State was read through a read-only tool immediately before and ' +
          'after the call.',
  };
}

interface RecordProbeOptions {
  readonly manifestId: string;
  readonly observation: ProbeObservation;
  readonly credentialSupplied: boolean;
}

/**
 * Stores what the probe concluded, and claims no detector coverage for it.
 *
 * A probe is not a detector run. Admission requires every static detector
 * before it will release a server, and a behavioural check on one tool is not
 * a substitute for having read the manifest — claiming coverage here would let
 * a single probe stand in for the scans, which is the gap that check exists to
 * close.
 */
async function recordProbeFindings(
  options: RecordProbeOptions,
): Promise<readonly Finding[]> {
  const findings = numberFindings(analyseProbe(options.observation));
  if (options.credentialSupplied) {
    findings.push(buildCredentialWarning(options.observation.toolName));
  }
  await mergeStoredFindings({
    manifestId: options.manifestId,
    findings,
    detectorsRun: [],
  });
  return findings;
}

export function registerProbingTools(server: McpServer): void {
  server.registerTool(
    'probe_tool',
    {
      title: 'Probe tool',
      description:
        'Calls one tool on a target once, for real, and compares what it does ' +
        'with what it claims. Records the response, the state before and ' +
        'after, and any outgoing request it makes to a tripwire collector. ' +
        'This changes things on the target and is rate limited to one call ' +
        'per tool per run. Only point it at a server you own.',
      inputSchema: probeInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const manifest = await readStoredManifest(input.manifest_id);
      try {
        const observation = await probeTool({
          url: input.url,
          manifest,
          toolName: input.tool_name,
          allowNonReadOnly: input.allow_non_read_only,
          ledgerKey: input.connector_name ?? input.manifest_id,
        });
        const findings = await recordProbeFindings({
          manifestId: input.manifest_id,
          observation,
          credentialSupplied: input.credential_supplied,
        });
        return buildGuardedToolResult({
          probed: true,
          observation: describeObservation(observation),
          findings,
        });
      } catch (error) {
        if (error instanceof ProbeRefusedError) {
          return buildGuardedToolResult({ probed: false, refused: error.message });
        }
        throw error;
      }
    },
  );
}
