import type {
  DetectorContext,
  DetectorDefinition,
  DraftFinding,
} from '../../../../src/features/detection/index.js';
import type { ManifestTool } from '../../../../src/features/manifest/index.js';

/**
 * Shared setup for the detector tests.
 *
 * Detectors are pure — text in, findings out — so a test needs nothing but a
 * tool and a context. Keeping the construction here means each test file reads
 * as a list of cases rather than a list of fixtures.
 */

const MANIFEST_PATH = '/tmp/vetit/manifests/TEST.json';

export interface ContextOptions {
  readonly tool?: Partial<ManifestTool>;
  readonly installedToolNames?: readonly string[];
}

export function buildContext(options: ContextOptions = {}): DetectorContext {
  return {
    tool: { name: 'search_docs', ...options.tool },
    toolIndex: 0,
    manifestPath: MANIFEST_PATH,
    installedToolNames: options.installedToolNames ?? [],
  };
}

export interface RunOptions {
  readonly detector: DetectorDefinition;
  readonly text: string;
  readonly context?: DetectorContext;
}

export function run(options: RunOptions): readonly DraftFinding[] {
  return options.detector.run(options.text, options.context ?? buildContext());
}

/** Every finding must be checkable. Asserted once, in every detector's suite. */
export function expectWellFormed(findings: readonly DraftFinding[]): void {
  for (const finding of findings) {
    if (finding.evidence.path !== MANIFEST_PATH) {
      throw new Error(`finding ${finding.detector} has no manifest path`);
    }
    if (!finding.evidence.jsonPointer.startsWith('/tools/0')) {
      throw new Error(`finding ${finding.detector} has no usable JSON pointer`);
    }
    if (!finding.evidence.snippet.startsWith('\u27E6UNTRUSTED_TEXT: ')) {
      throw new Error(`finding ${finding.detector} returned an uncleaned snippet`);
    }
    if (finding.fix.length < 20) {
      throw new Error(`finding ${finding.detector} does not say what to do`);
    }
  }
}
