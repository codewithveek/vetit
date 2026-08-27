import type { DetectorContext, DetectorDefinition, DraftFinding } from '../finding.types.js';
import { escapeForRegExp } from './escape-for-regexp.js';
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

/** A dotted or colon-separated chain: `github.create_issue`, `docs.example.com`. */
const QUALIFIED_CHAIN = /\b[a-z][\w-]{2,}(?:[.:]{1,2}[a-z][\w-]+)+\b/gi;

const SEPARATOR = /[.:]{1,2}/;

/** URLs are D-06's finding. Their hostnames are not tool references. */
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;

/**
 * The last segment decides.
 *
 * The rule used to be "the member must be longer than four characters and
 * contain an underscore", which was a lazy way of excluding `manifest.json`
 * and threw away every ordinary name with it — `filesystem.read`,
 * `github.search`, `server.lookup` all went unreported. What actually
 * distinguishes a file or a host from a tool is its last segment, so that is
 * what is checked.
 */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'json', 'md', 'markdown', 'txt', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'xml', 'html', 'htm', 'csv', 'tsv', 'log', 'lock', 'js', 'mjs', 'cjs', 'ts',
  'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'cpp', 'php', 'sh',
  'bash', 'zsh', 'ps1', 'sql', 'css', 'scss', 'svg', 'png', 'jpg', 'jpeg',
  'gif', 'webp', 'pdf', 'zip', 'gz', 'tar', 'env', 'pem', 'crt', 'lockb',
]);

const TOP_LEVEL_DOMAINS: ReadonlySet<string> = new Set([
  'com', 'org', 'net', 'io', 'dev', 'ai', 'co', 'uk', 'us', 'eu', 'app', 'gg',
  'me', 'info', 'biz', 'edu', 'gov', 'mil', 'int', 'xyz', 'cloud', 'tech',
  'run', 'so', 'to', 'ly', 'fm', 'tv', 'local', 'localhost', 'example',
]);

const COMMON_ABBREVIATIONS: ReadonlySet<string> = new Set(['e.g', 'i.e', 'etc']);

function isPlausibleToolReference(chain: string): boolean {
  const lower = chain.toLowerCase();
  if (COMMON_ABBREVIATIONS.has(lower)) return false;
  const segments = lower.split(SEPARATOR).filter((segment) => segment.length > 0);
  const last = segments.at(-1) ?? '';
  return !FILE_EXTENSIONS.has(last) && !TOP_LEVEL_DOMAINS.has(last);
}

function findQualifiedReferences(
  text: string,
  context: DetectorContext,
): DraftFinding[] {
  // Blanking URLs rather than removing them keeps every index aligned with the
  // original text, so the evidence still points where the reader will look.
  const withoutUrls = text.replaceAll(URL_PATTERN, (url) => ' '.repeat(url.length));
  const findings: DraftFinding[] = [];
  const seen = new Set<string>();
  for (const match of withoutUrls.matchAll(QUALIFIED_CHAIN)) {
    const chain = match[0];
    if (!isPlausibleToolReference(chain) || seen.has(chain)) continue;
    seen.add(chain);
    findings.push({
      detector: 'D-09',
      severity: 'critical',
      tool: context.tool.name,
      message:
        `Description names "${chain}", which reads as a tool belonging to ` +
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

interface NamedMatch {
  readonly name: string;
  readonly index: number;
}

/**
 * An installed name counts when it appears as a name, not inside a word.
 *
 * A plain substring search meant an installed tool called `read` made
 * "Reads documentation" a critical finding — forty points of risk, on an
 * honest server, from a coincidence of spelling. Boundaries exclude the
 * characters a tool name is made of, so a name inside a longer identifier does
 * not count either; that case is the qualified-reference signal's job.
 */
function findInstalledName(text: string, name: string): NamedMatch | undefined {
  // A separator only disqualifies the match when something name-shaped is on
  // the other side of it. Otherwise `post_message.` ending a sentence would be
  // read as part of a longer identifier and missed, while `filesystem.read`
  // and `read.json` are still correctly left to the qualified-reference signal.
  const pattern = new RegExp(
    String.raw`(?<![\w-])(?<![\w-][.:])${escapeForRegExp(name)}(?![\w-])(?![.:][\w-])`,
    'iu',
  );
  const match = pattern.exec(text);
  return match === null ? undefined : { name, index: match.index };
}

function findInstalledToolNames(
  text: string,
  context: DetectorContext,
): DraftFinding[] {
  const matches = context.installedToolNames
    .filter((name) => name !== context.tool.name)
    .map((name) => findInstalledName(text, name))
    .filter((match): match is NamedMatch => match !== undefined);
  if (matches.length === 0) return [];
  const names = matches.map((match) => match.name);
  return [
    {
      detector: 'D-09',
      severity: 'critical',
      tool: context.tool.name,
      message:
        `Description names ${String(names.length)} tool(s) already enabled in ` +
        `this workspace: ${names.join(', ')}.`,
      evidence: buildEvidence({
        context,
        pointerSegments: ['description'],
        snippetText: excerptAround({ text, matchIndex: matches[0]?.index ?? 0 }),
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
