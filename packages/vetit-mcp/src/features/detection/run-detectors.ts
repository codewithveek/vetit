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
 * Every tool, every detector, in a fixed order. `installedToolNames` defaults
 * to the manifest's own tools so that a shadowing check still has something to
 * compare against when the caller does not supply a workspace list.
 */
export function runDetectors(options: RunDetectorsOptions): DetectionRun {
  return runDetectorsWithInstalled({ ...options, installedToolNames: [] });
}

export interface RunDetectorsWithInstalledOptions extends RunDetectorsOptions {
  readonly installedToolNames: readonly string[];
}

export function runDetectorsWithInstalled(
  options: RunDetectorsWithInstalledOptions,
): DetectionRun {
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
