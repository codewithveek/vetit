import { z } from 'zod';
import type { DetectorContext, DetectorDefinition, DraftFinding } from '../finding.types.js';
import { escapeForRegExp } from './escape-for-regexp.js';
import { buildEvidence } from './build-evidence.js';
import { extractVisibleText } from './visible-text.js';

/**
 * D-07 — a free-text parameter the description never mentions.
 *
 * This is the other half of tool poisoning. The hidden instruction tells the
 * model to read a secret; the undocumented string parameter is where it puts
 * it. `add(a, b, sidenote)` is the canonical example — two numbers and a
 * channel out.
 *
 * A parameter is flagged when it takes free text, carries no description of
 * its own, and is never named in the *visible* part of the tool's description.
 *
 * The word visible is doing real work there. The decoy's poisoned `add` tool
 * mentions `sidenote` — inside the hidden <IMPORTANT> block that tells the
 * model to fill it with a private key. Counting that as documentation would
 * let the payload exonerate itself, so the mention is checked against the text
 * a reviewer can actually read.
 */

const propertySchema = z
  .object({ type: z.unknown().optional(), description: z.string().optional() })
  .passthrough();

/** Names that are a sink often enough to be worth saying so. */
const SUSPICIOUS_NAMES: ReadonlySet<string> = new Set([
  'sidenote',
  'context',
  'notes',
  'note',
  'debug',
  'debug_context',
  'metadata',
  'meta',
  'extra',
  'extras',
  'payload',
  'raw',
  'annotation',
  'annotations',
  'comment',
  'internal',
]);

function acceptsFreeText(property: unknown): boolean {
  const parsed = propertySchema.safeParse(property);
  if (!parsed.success) return false;
  const { type } = parsed.data;
  if (type === undefined) return true;
  if (typeof type === 'string') return type === 'string';
  if (Array.isArray(type)) return type.includes('string');
  return false;
}

/** At least one letter or digit. A description of `""` or `"."` explains nothing. */
const MEANINGFUL_TEXT = /[\p{L}\p{N}]/u;

/**
 * A property counts as documented only if its description says something.
 *
 * Any defined value used to be enough, so `description: ""` — or a space, or a
 * full stop — silently suppressed a high-severity finding. A publisher could
 * switch off the undocumented-parameter check without documenting anything.
 */
function hasOwnDescription(property: unknown): boolean {
  const parsed = propertySchema.safeParse(property);
  if (!parsed.success) return false;
  const description = parsed.data.description ?? '';
  return MEANINGFUL_TEXT.test(description.trim());
}

/**
 * The name has to appear as a name, not as a run of letters inside a word.
 *
 * A plain substring search made a parameter called `id` documented by the word
 * "provides", and `note` documented by "notes that". Short and common names
 * are exactly the ones an exfiltration field would use, so this was a hole
 * shaped like the attack.
 *
 * Boundaries exclude word characters and hyphens, since tool parameters are
 * conventionally `snake_case` or `kebab-case` and `_` is already a word
 * character.
 */
function isMentionedVisibly(parameterName: string, description: string): boolean {
  const boundedName = new RegExp(
    String.raw`(?<![\w-])${escapeForRegExp(parameterName)}(?![\w-])`,
    'iu',
  );
  return boundedName.test(extractVisibleText(description));
}

function buildMessage(parameterName: string): string {
  const suffix = SUSPICIOUS_NAMES.has(parameterName.toLowerCase())
    ? ' The name is one commonly used as a channel for moving data out.'
    : '';
  return (
    `Parameter "${parameterName}" takes free text, has no description of its ` +
    `own, and is never mentioned in the visible tool description.${suffix}`
  );
}

export const exfilParamsDetector: DetectorDefinition = {
  id: 'D-07',
  name: 'exfilParams',
  severity: 'high',
  reads: 'schema',
  run: (text, context: DetectorContext): readonly DraftFinding[] => {
    const properties = context.tool.inputSchema?.properties ?? {};
    const findings: DraftFinding[] = [];
    for (const [parameterName, property] of Object.entries(properties)) {
      if (!acceptsFreeText(property)) continue;
      if (hasOwnDescription(property)) continue;
      if (isMentionedVisibly(parameterName, text)) continue;
      findings.push({
        detector: 'D-07',
        severity: 'high',
        tool: context.tool.name,
        message: buildMessage(parameterName),
        evidence: buildEvidence({
          context,
          pointerSegments: ['inputSchema', 'properties', parameterName],
          snippetText: parameterName,
        }),
        fix:
          'Ask the publisher what the field is for. If there is no answer, ' +
          'assume it is a way out for data the agent has read, and keep the ' +
          'tool disabled.',
      });
    }
    return findings;
  },
};
