import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildGuardedToolResult } from '../../shared/redaction/index.js';
import { readStoredManifest, resolveManifestPath } from '../manifest/index.js';
import { DETECTORS } from './detectors/index.js';
import {
  FindingsStorageError,
  mergeStoredFindings,
  readStoredFindings,
  readScanCoverage,
} from './findings-store.service.js';
import { computeRisk } from './risk-score.js';
import { runDetectors } from './run-detectors.js';
import type { Finding } from './finding.types.js';

/**
 * MCP wiring for the detection feature.
 *
 * Four scanning tools, one scoring tool, and one lookup. The scanning tools
 * are the same pipeline with different detectors selected, so a finding reads
 * the same way whichever one produced it, and every one of them merges its
 * results into the manifest's stored record rather than replacing it.
 */

const manifestIdInput = {
  manifest_id: z
    .string()
    .describe('Identifier returned by fetch_manifest.'),
};

/** Detectors that read the text a server publishes about itself. */
const DESCRIPTION_DETECTORS = ['D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'D-06', 'D-10'];

interface ScanOutcome {
  readonly manifest_id: string;
  readonly manifest_path: string;
  readonly tools_scanned: number;
  readonly detectors_run: readonly string[];
  readonly new_findings: readonly Finding[];
  readonly total_findings_recorded: number;
}

interface ScanRequest {
  readonly manifestId: string;
  readonly detectorIds: readonly string[];
  /**
   * Empty for every scan except `check_shadowing`, which is the only tool that
   * takes a workspace list. Stated here rather than defaulted in the runner —
   * a scan that does not run D-09's installed-name signal should say so, not
   * have it quietly switched off on its behalf.
   */
  readonly installedToolNames?: readonly string[];
}

async function scan(request: ScanRequest): Promise<ScanOutcome> {
  const manifest = await readStoredManifest(request.manifestId);
  const manifestPath = await resolveManifestPath(request.manifestId);
  const run = runDetectors({
    manifest,
    manifestPath,
    detectorIds: request.detectorIds,
    installedToolNames: request.installedToolNames ?? [],
  });
  const merged = await mergeStoredFindings({
    manifestId: request.manifestId,
    findings: run.findings,
    // Recorded whether or not anything was found: admission has to be able to
    // tell a clean review from no review.
    detectorsRun: request.detectorIds,
  });
  return {
    manifest_id: request.manifestId,
    manifest_path: manifestPath,
    tools_scanned: run.toolCount,
    detectors_run: request.detectorIds,
    new_findings: run.findings,
    total_findings_recorded: merged.length,
  };
}

function registerScanDescriptions(server: McpServer): void {
  server.registerTool(
    'scan_descriptions',
    {
      title: 'Scan descriptions',
      description:
        'Runs the description and name detectors (D-01 to D-06, D-10) over a ' +
        'fetched manifest. Every finding carries a file path, a JSON pointer ' +
        'and a snippet that has been cleaned before being returned.',
      inputSchema: manifestIdInput,
      annotations: {
        // Persists findings to the manifest's record. Additive, never
        // destructive, but a write — see the note above registerDetectionTools.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ manifest_id }) =>
      buildGuardedToolResult(
        await scan({ manifestId: manifest_id, detectorIds: DESCRIPTION_DETECTORS }),
      ),
  );
}

function registerAnalyzeSchemas(server: McpServer): void {
  server.registerTool(
    'analyze_schemas',
    {
      title: 'Analyse schemas',
      description:
        'Flags parameters built for smuggling data out: free-text fields with ' +
        'no stated purpose, and fields the visible description never mentions.',
      inputSchema: manifestIdInput,
      annotations: {
        // Persists findings to the manifest's record. Additive, never
        // destructive, but a write — see the note above registerDetectionTools.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ manifest_id }) =>
      buildGuardedToolResult(
        await scan({ manifestId: manifest_id, detectorIds: ['D-07'] }),
      ),
  );
}

interface AnnotationRow {
  readonly tool: string;
  readonly declares_read_only: boolean;
  readonly declares_destructive: boolean;
  readonly treated_as: 'read' | 'write';
}

async function summariseAnnotations(manifestId: string): Promise<{
  readonly scan: ScanOutcome;
  readonly table: readonly AnnotationRow[];
  readonly why_silence_is_a_write: string;
}> {
  const manifest = await readStoredManifest(manifestId);
  const table = manifest.tools.map((tool): AnnotationRow => {
    const declaresReadOnly = tool.annotations?.readOnlyHint !== undefined;
    const declaresDestructive = tool.annotations?.destructiveHint !== undefined;
    const isDeclaredRead = tool.annotations?.readOnlyHint === true;
    return {
      tool: tool.name,
      declares_read_only: declaresReadOnly,
      declares_destructive: declaresDestructive,
      treated_as: declaresReadOnly && isDeclaredRead ? 'read' : 'write',
    };
  });
  return {
    scan: await scan({ manifestId, detectorIds: ['D-08'] }),
    table,
    why_silence_is_a_write:
      'TrueForge works out @read-only and @write from readOnlyHint and ' +
      'destructiveHint. A tool that declares neither cannot be classified, so ' +
      'a server that says nothing walks straight past approval settings keyed ' +
      'on those groups. Silence is therefore read as a write, not as neutral. ' +
      'Note also what this cannot tell you: these are claims. Only probe_tool ' +
      'shows whether they are true.',
  };
}

function registerCheckAnnotations(server: McpServer): void {
  server.registerTool(
    'check_annotations',
    {
      title: 'Check annotations',
      description:
        'Reports which tools declare readOnlyHint and destructiveHint and ' +
        'which say nothing. A tool that says nothing is treated as a write.',
      inputSchema: manifestIdInput,
      annotations: {
        // Persists findings to the manifest's record. Additive, never
        // destructive, but a write — see the note above registerDetectionTools.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ manifest_id }) =>
      buildGuardedToolResult(await summariseAnnotations(manifest_id)),
  );
}

function registerCheckShadowing(server: McpServer): void {
  server.registerTool(
    'check_shadowing',
    {
      title: 'Check shadowing',
      description:
        'Flags descriptions that name tools belonging to other servers, ' +
        'including any already enabled in this workspace.',
      inputSchema: {
        ...manifestIdInput,
        installed_tool_names: z
          .array(z.string())
          .default([])
          .describe('Tool names already trusted in this workspace.'),
      },
      annotations: {
        // Persists findings to the manifest's record. Additive, never
        // destructive, but a write — see the note above registerDetectionTools.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ manifest_id, installed_tool_names }) =>
      buildGuardedToolResult(
        await scan({
          manifestId: manifest_id,
          detectorIds: ['D-09'],
          installedToolNames: installed_tool_names,
        }),
      ),
  );
}

function registerComputeRisk(server: McpServer): void {
  server.registerTool(
    'compute_risk',
    {
      title: 'Compute risk',
      description:
        'Adds up the findings recorded for a manifest by severity weight. ' +
        'Plain arithmetic — the same findings always give the same score, and ' +
        'no model is asked for an opinion. The number is a recommendation; ' +
        'the human decides.',
      inputSchema: manifestIdInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ manifest_id }) => {
      let findings: readonly Finding[];
      try {
        findings = await readStoredFindings(manifest_id);
      } catch (error) {
        // A damaged record must not come back as a score. Returning the
        // refusal rather than throwing keeps the explanation inside the
        // guarded payload, where the agent will actually read it.
        if (error instanceof FindingsStorageError) {
          return buildGuardedToolResult({
            manifest_id,
            scored: false,
            refused: error.message,
          });
        }
        throw error;
      }
      const assessment = computeRisk(findings);
      return buildGuardedToolResult({
        manifest_id,
        scored: true,
        score: assessment.score,
        band: assessment.band,
        counts: assessment.counts,
        finding_count: assessment.findingCount,
        working_out: assessment.workingOut,
        note: describeScore({
          findingCount: findings.length,
          detectorsRun: (await readScanCoverage(manifest_id)).detectorsRun,
        }),
      });
    },
  );
}

interface ScoreContext {
  readonly findingCount: number;
  readonly detectorsRun: readonly string[];
}

/**
 * What a zero means, which is two opposite things.
 *
 * A count alone cannot tell "nothing was found" from "nothing was looked for",
 * and this used to answer both with the second: a server that passed all ten
 * detectors cleanly was told its score meant nothing had been checked. That is
 * the same confusion `write_admission` refuses on, and the coverage record
 * that settles it there was already being written here — it just was not being
 * read.
 *
 * Getting this backwards is worse than a wrong number. It teaches a reader to
 * disbelieve a clean result, which is how a real pass gets re-run until
 * something turns up.
 */
function describeScore(context: ScoreContext): string {
  const missing = DETECTORS.map((definition) => definition.id).filter(
    (id) => !context.detectorsRun.includes(id),
  );
  if (missing.length === DETECTORS.length) {
    return (
      'Nothing has been checked. No detector has run against this manifest, ' +
      'so this zero is the absence of a review rather than the result of one. ' +
      'Run scan_descriptions, analyze_schemas, check_annotations and ' +
      'check_shadowing.'
    );
  }
  if (missing.length > 0) {
    return (
      `Partial review: ${missing.join(', ')} never ran. This score covers ` +
      'only the detectors that did, and says nothing about the rest.'
    );
  }
  if (context.findingCount === 0) {
    return (
      'All ten detectors ran and found nothing. This is a clean result rather ' +
      'than an unchecked one — though a static review cannot see behaviour, ' +
      'so probe anything whose annotations matter to you.'
    );
  }
  return 'Score computed from the stored findings for this manifest.';
}

function registerLookupAdvisories(server: McpServer): void {
  server.registerTool(
    'lookup_advisories',
    {
      title: 'Look up advisories',
      description:
        'Returns the searches worth running against a package or server name. ' +
        'It does not return advisories: Vetit has no advisory database, and a ' +
        'CVE number invented to look thorough is worse than no answer. Run ' +
        'these searches with exa and cite what you actually find.',
      inputSchema: {
        identifier: z
          .string()
          .describe('Package name, server name or repository to look up.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ identifier }) =>
      buildGuardedToolResult({
        identifier,
        advisories: [],
        performed: false,
        reason:
          'Vetit does not hold advisory data and will not guess. Hand these ' +
          'searches to exa and report only what comes back.',
        suggested_searches: [
          `${identifier} CVE`,
          `${identifier} security advisory`,
          `${identifier} MCP server vulnerability`,
          `${identifier} malicious npm package`,
        ],
      }),
  );
}

/**
 * Why four of these are not read-only.
 *
 * Every scanning tool merges its results into the manifest's findings record,
 * which is a file on disk. They were annotated `readOnlyHint: true` anyway —
 * in a project whose entire argument is that a tool which catches servers
 * lying about their labels has to get its own right. A client trusting that
 * hint would auto-approve an operation that changes state.
 *
 * `destructiveHint` stays false because the merge is additive: it adds
 * findings to a record, and never removes one. `idempotentHint` is true
 * because running the same scan twice leaves the same set.
 *
 * `compute_risk` and `lookup_advisories` really are read-only, and keep the
 * annotation they have earned.
 */
export function registerDetectionTools(server: McpServer): void {
  registerScanDescriptions(server);
  registerAnalyzeSchemas(server);
  registerCheckAnnotations(server);
  registerCheckShadowing(server);
  registerComputeRisk(server);
  registerLookupAdvisories(server);
}
