import type { DetectorContext, DetectorDefinition, DraftFinding } from '../finding.types.js';
import { buildEvidence, excerptAround } from './build-evidence.js';

/**
 * D-06 — a URL sitting inside a description.
 *
 * On its own this is not an attack. Plenty of honest tools link to their own
 * documentation. It is flagged at medium because a URL in a description is
 * where stolen data goes: the model is told to post something "for
 * aggregation", and the address is right there in the text.
 *
 * The severity is chosen to match how often it is innocent. A reviewer should
 * glance at the host and move on, not stop the review.
 */

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

export const embeddedUrlsDetector: DetectorDefinition = {
  id: 'D-06',
  name: 'embeddedUrls',
  severity: 'medium',
  reads: 'description',
  run: (text, context: DetectorContext): readonly DraftFinding[] => {
    const matches = [...text.matchAll(URL_PATTERN)];
    if (matches.length === 0) return [];
    const hosts = [...new Set(matches.map((match) => extractHost(match[0])))];
    const firstIndex = matches[0]?.index ?? 0;
    return [
      {
        detector: 'D-06',
        severity: 'medium',
        tool: context.tool.name,
        message:
          `Description contains ${String(matches.length)} URL(s), pointing at: ` +
          `${hosts.join(', ')}.`,
        evidence: buildEvidence({
          context,
          pointerSegments: ['description'],
          snippetText: excerptAround({ text, matchIndex: firstIndex }),
        }),
        fix:
          'Check each host against the publisher. A link to the tool’s own ' +
          'documentation is fine. A collector, a webhook or a shortener in a ' +
          'description is where data leaves.',
      },
    ];
  },
};
