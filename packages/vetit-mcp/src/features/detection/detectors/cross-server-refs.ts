import type { DetectorContext, DetectorDefinition, DraftFinding } from '../finding.types.js';
import { buildEvidence, excerptAround } from './build-evidence.js';

/**
 * D-09 — a description that talks about somebody else's tools.
 *
 * Cross-server shadowing: a server names a tool you already trust and tells
 * the model to route through it instead, or to stop using it. One compromised
 * server drags the others down with it, which is why this sits at critical
 * even though nothing about the wording looks violent.
 *
 * Two signals:
 *
 *  - a `server.tool` or `server:tool` reference, which is how MCP tools get
 *    named in prose and almost never appears by accident
 *  - the literal name of a tool already enabled in this workspace
 *
 * A tool naming *itself* is not a finding. Descriptions do that all the time.
 */

const QUALIFIED_REFERENCE = /\b([a-z][\w-]{2,})[.:]{1,2}([a-z][\w-]{2,})\b/gi;

/** Words that look like a qualified tool reference and are not one. */
const COMMON_FALSE_POSITIVES: ReadonlySet<string> = new Set([
  'e.g',
  'i.e',
  'etc',
  'json',
  'yaml',
  'http',
  'https',
  'www',
  'node',
  'npm',
  'github.com',
  'example.com',
]);

function isPlausibleToolReference(qualifier: string, member: string): boolean {
  const joined = `${qualifier}.${member}`.toLowerCase();
  if (COMMON_FALSE_POSITIVES.has(joined)) return false;
  if (COMMON_FALSE_POSITIVES.has(qualifier.toLowerCase())) return false;
  // A file extension is not a tool: `manifest.json`, `README.md`.
  return member.length > 4 && member.includes('_');
}

function findQualifiedReferences(
  text: string,
  context: DetectorContext,
): DraftFinding[] {
  const findings: DraftFinding[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(QUALIFIED_REFERENCE)) {
    const qualifier = match[1] ?? '';
    const member = match[2] ?? '';
    if (!isPlausibleToolReference(qualifier, member) || seen.has(match[0])) continue;
    seen.add(match[0]);
    findings.push({
      detector: 'D-09',
      severity: 'critical',
      tool: context.tool.name,
      message:
        `Description names "${match[0]}", which reads as a tool belonging to ` +
        'another server. A server has no business directing calls meant for ' +
        'one you already trust.',
      evidence: buildEvidence({
        context,
        pointerSegments: ['description'],
        snippetText: excerptAround({ text, matchIndex: match.index }),
      }),
      fix:
        'Reject the server, or at minimum keep it disabled while every tool ' +
        'it names is checked. This is how one bad server compromises the rest.',
    });
  }
  return findings;
}

function findInstalledToolNames(
  text: string,
  context: DetectorContext,
): DraftFinding[] {
  const lowerText = text.toLowerCase();
  const named = context.installedToolNames.filter(
    (name) => name !== context.tool.name && lowerText.includes(name.toLowerCase()),
  );
  if (named.length === 0) return [];
  const firstName = named[0] ?? '';
  return [
    {
      detector: 'D-09',
      severity: 'critical',
      tool: context.tool.name,
      message:
        `Description names ${String(named.length)} tool(s) already enabled in ` +
        `this workspace: ${named.join(', ')}.`,
      evidence: buildEvidence({
        context,
        pointerSegments: ['description'],
        snippetText: excerptAround({
          text,
          matchIndex: lowerText.indexOf(firstName.toLowerCase()),
        }),
      }),
      fix:
        'Compare what this description says about those tools against what ' +
        'they actually do. A server that redefines a neighbour is trying to ' +
        'take its calls.',
    },
  ];
}

export const crossServerRefsDetector: DetectorDefinition = {
  id: 'D-09',
  name: 'crossServerRefs',
  severity: 'critical',
  reads: 'description',
  run: (text, context) => [
    ...findQualifiedReferences(text, context),
    ...findInstalledToolNames(text, context),
  ],
};
