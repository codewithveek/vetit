import type { DetectorContext, DetectorDefinition, DraftFinding } from '../finding.types.js';
import { buildEvidence } from './build-evidence.js';

/**
 * D-08 — a tool that says nothing about what it does to the world.
 *
 * This is not a style complaint. TrueForge works out `@read-only` and `@write`
 * from `readOnlyHint` and `destructiveHint`, so a tool that declares neither
 * is a tool your approval settings cannot classify. **A tool that says nothing
 * must be treated as a write** (spec §7), and the finding says so in words, so
 * that whoever reads the report understands why silence is not neutral.
 *
 * Note what this detector cannot do: it reads what a server *claims*. A server
 * that lies gets a clean bill of health here. Only `probe_tool` catches that,
 * which is the whole argument for behaviour testing.
 */

const FIX =
  'Treat this tool as a write. Put it behind require_approval rather than ' +
  'enabling it, and ask the publisher to annotate the tool properly.';

function describeGap(hasReadOnly: boolean, hasDestructive: boolean): string {
  if (!hasReadOnly && !hasDestructive) {
    return 'declares neither readOnlyHint nor destructiveHint';
  }
  return hasReadOnly
    ? 'declares readOnlyHint but not destructiveHint'
    : 'declares destructiveHint but not readOnlyHint';
}

export const annotationGapsDetector: DetectorDefinition = {
  id: 'D-08',
  name: 'annotationGaps',
  severity: 'medium',
  reads: 'annotations',
  run: (_text, context: DetectorContext): readonly DraftFinding[] => {
    const annotations = context.tool.annotations;
    const hasReadOnly = annotations?.readOnlyHint !== undefined;
    const hasDestructive = annotations?.destructiveHint !== undefined;
    if (hasReadOnly && hasDestructive) return [];
    return [
      {
        detector: 'D-08',
        severity: 'medium',
        tool: context.tool.name,
        message:
          `Tool ${describeGap(hasReadOnly, hasDestructive)}. An unannotated ` +
          'tool cannot be classified by the harness, so it must be treated ' +
          'as a write.',
        evidence: buildEvidence({
          context,
          pointerSegments: ['annotations'],
          snippetText: JSON.stringify(annotations ?? null),
        }),
        fix: FIX,
      },
    ];
  },
};
