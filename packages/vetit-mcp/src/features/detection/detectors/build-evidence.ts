import { cleanUntrustedSnippet } from '../../../shared/redaction/index.js';
import type { DetectorContext, FindingEvidence } from '../finding.types.js';

/**
 * The one way a detector is allowed to produce evidence.
 *
 * It does two jobs that must never be done separately: it builds the JSON
 * pointer so the reader can find the field, and it runs the snippet through
 * the redaction layer so the reader — or the model — cannot be attacked by it.
 * There is no variant of this function that skips the cleaning.
 */

/** RFC 6901: `~` becomes `~0` and `/` becomes `~1`, in that order. */
function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function buildToolPointer(
  toolIndex: number,
  segments: readonly string[],
): string {
  const tail = segments.map((segment) => escapePointerSegment(segment)).join('/');
  const base = `/tools/${String(toolIndex)}`;
  return tail.length > 0 ? `${base}/${tail}` : base;
}

export interface EvidenceOptions {
  readonly context: DetectorContext;
  readonly pointerSegments: readonly string[];
  readonly snippetText: string;
}

export function buildEvidence(options: EvidenceOptions): FindingEvidence {
  return {
    path: options.context.manifestPath,
    jsonPointer: buildToolPointer(options.context.toolIndex, options.pointerSegments),
    snippet: cleanUntrustedSnippet({ text: options.snippetText }).renderedText,
  };
}

/**
 * The window of text around a match, so a snippet shows the hit in context
 * rather than the first 120 characters of an unrelated paragraph.
 */
export interface ExcerptOptions {
  readonly text: string;
  readonly matchIndex: number;
}

const EXCERPT_LEAD = 40;
const EXCERPT_LENGTH = 120;

export function excerptAround(options: ExcerptOptions): string {
  const start = Math.max(0, options.matchIndex - EXCERPT_LEAD);
  return options.text.slice(start, start + EXCERPT_LENGTH);
}
