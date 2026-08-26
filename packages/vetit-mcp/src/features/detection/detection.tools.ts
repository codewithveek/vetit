import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildGuardedToolResult } from '../../shared/redaction/index.js';
import { readStoredManifest, resolveManifestPath } from '../manifest/index.js';
import { mergeStoredFindings, readStoredFindings } from './findings-store.service.js';
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
      const findings = await readStoredFindings(manifest_id);
      const assessment = computeRisk(findings);
      return buildGuardedToolResult({
        manifest_id,
        score: assessment.score,
        band: assessment.band,
        counts: assessment.counts,
        finding_count: assessment.findingCount,
        working_out: assessment.workingOut,
        note:
          findings.length === 0
            ? 'No findings are recorded for this manifest. Run the scanning ' +
              'tools first — a score of zero here means nothing was checked, ' +
              'not that nothing was found.'
            : 'Score computed from the stored findings for this manifest.',
      });
    },
  );
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

export function registerDetectionTools(server: McpServer): void {
  registerScanDescriptions(server);
  registerAnalyzeSchemas(server);
  registerCheckAnnotations(server);
  registerCheckShadowing(server);
  registerComputeRisk(server);
  registerLookupAdvisories(server);
}
