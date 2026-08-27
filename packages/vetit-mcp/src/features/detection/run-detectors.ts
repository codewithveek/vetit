import type { ManifestTool, StoredManifest } from '../manifest/index.js';
import { DETECTORS } from './detectors/index.js';
import type {
  Detector,
  DetectorContext,
  DetectorDefinition,
  DraftFinding,
  Finding,
} from './finding.types.js';

/**
 * Running the detectors over a manifest, and numbering what comes back.
 *
 * The model decides *that* this runs. It does not do the scanning — that is
 * spec §4 Rule 2: a fixed rule check is plain text matching, so it belongs in
 * code where the same input gives the same answer every time and every case
 * can be tested.
 */

export interface RunDetectorsOptions {
  readonly manifest: StoredManifest;
  readonly manifestPath: string;
  /**
   * Tool names already trusted in this workspace, for D-09's shadowing check.
   *
   * Required, with no default, on purpose — see `runDetectors`.
   */
  readonly installedToolNames: readonly string[];
}

/** Which field of the tool each detector is handed. */
function selectText(definition: DetectorDefinition, tool: ManifestTool): string {
  switch (definition.reads) {
    case 'name': {
      return tool.name;
    }
    case 'description':
    case 'schema': {
      return tool.description ?? '';
    }
    case 'annotations': {
      return '';
    }
  }
}

function runOneTool(
  context: DetectorContext,
  detectors: readonly DetectorDefinition[],
): DraftFinding[] {
  const drafts: DraftFinding[] = [];
  for (const definition of detectors) {
    const run: Detector = definition.run;
    drafts.push(...run(selectText(definition, context.tool), context));
  }
  return drafts;
}

function numberFindings(drafts: readonly DraftFinding[]): Finding[] {
  return drafts.map((draft, index) => ({
    id: `F-${String(index + 1).padStart(3, '0')}`,
    ...draft,
  }));
}

export interface DetectionRun {
  readonly manifestId: string;
  readonly manifestPath: string;
  readonly toolCount: number;
  readonly findings: readonly Finding[];
}

/**
 * Every tool, every detector, in a fixed order.
 *
 * `installedToolNames` has no default. There were two functions here — one
 * that took a workspace list and one that quietly supplied an empty one — and
 * the second carried a comment claiming it defaulted to the manifest's own
 * tools. Code and comment disagreed, and review found it twice.
 *
 * Both candidate defaults are wrong, which is why there is none:
 *
 *  - an empty list silently switches off D-09's installed-name signal, and a
 *    security check that turns itself off without saying so is the worst kind
 *  - the manifest's own tools makes a tool that mentions a sibling — "call
 *    `list_spaces` first", which honest servers write constantly — a critical
 *    cross-server-shadowing finding worth forty points of risk. D-09 is about
 *    a server naming tools belonging to *other* servers; a server describing
 *    itself is not that
 *
 * So every caller states what it means. Passing `[]` is still allowed and
 * still switches the signal off, but it is now a decision somebody wrote down
 * rather than one the runner made on their behalf.
 */
export function runDetectors(options: RunDetectorsOptions): DetectionRun {
  const drafts: DraftFinding[] = [];
  options.manifest.tools.forEach((tool, toolIndex) => {
    drafts.push(
      ...runOneTool(
        {
          tool,
          toolIndex,
          manifestPath: options.manifestPath,
          installedToolNames: options.installedToolNames,
        },
        DETECTORS,
      ),
    );
  });
  return {
    manifestId: options.manifest.manifestId,
    manifestPath: options.manifestPath,
    toolCount: options.manifest.tools.length,
    findings: numberFindings(drafts),
  };
}
