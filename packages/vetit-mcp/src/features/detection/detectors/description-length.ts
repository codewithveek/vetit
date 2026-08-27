import type { DetectorContext, DetectorDefinition, DraftFinding } from '../finding.types.js';
import { buildEvidence } from './build-evidence.js';

/**
 * D-10 — a description long enough to hide something in.
 *
 * Length is not an attack, and this fires at `low` accordingly. It is a
 * pointer: an instruction buried at line forty of a rambling description is
 * one a reviewer scrolls past, and padding is a cheap way to buy that.
 *
 * The threshold is set where honest descriptions stop. A thorough one runs to
 * a few hundred characters; past 800 the text has usually stopped explaining
 * what the tool does.
 */

const LENGTH_THRESHOLD = 800;

export const descriptionLengthDetector: DetectorDefinition = {
  id: 'D-10',
  name: 'descriptionLength',
  severity: 'low',
  reads: 'description',
  run: (text, context: DetectorContext): readonly DraftFinding[] => {
    if (text.length <= LENGTH_THRESHOLD) return [];
    return [
      {
        detector: 'D-10',
        severity: 'low',
        tool: context.tool.name,
        message:
          `Description is ${String(text.length)} characters, past the ` +
          `${String(LENGTH_THRESHOLD)}-character mark where honest ones stop. ` +
          'Long text is room to hide an instruction in.',
        evidence: buildEvidence({
          context,
          pointerSegments: ['description'],
          snippetText: text,
        }),
        fix:
          'Read the whole description in the manifest file, not the summary. ' +
          'Check the end of it especially — padding goes at the front.',
      },
    ];
  },
};
