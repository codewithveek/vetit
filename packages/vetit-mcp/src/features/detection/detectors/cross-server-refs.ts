import type { ManifestTool } from '../../manifest/index.js';
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

/**
 * `key:value` search syntax, which is not a tool reference and never was.
 *
 * This is what actually cost a public search server a rejection. Its
 * description reads "Use category:people / category:company to search through
 * Linkedin profiles" — a documented query filter, in the syntax every search
 * product has used since AltaVista. Two criticals, eighty points, and a
 * recommendation to keep the server disabled, over a colon.
 *
 * Nothing about the *shape* of `category:people` differs from
 * `filesystem:read_file`, and the sentence around it genuinely does say
 * "Use" — so neither the shape rules nor the redirection signal can separate
 * them. The head is the only thing left that carries meaning, and the set of
 * words used as filter keys is small and well known.
 *
 * The exemption stops at names you actually have. `category:people` is
 * syntax; `category:people` on a workspace with a tool called `people` is a
 * filter key being used to launder one, and the installed-name signal cannot
 * catch it on its own — it reads `people` there as part of a longer
 * identifier and leaves it to this signal by design.
 *
 * Dotted chains are unaffected: filter syntax is colon-only.
 */
const QUERY_FILTER_KEYS: ReadonlySet<string> = new Set([
  'category', 'site', 'filetype', 'ext', 'lang', 'language', 'locale',
  'type', 'kind', 'status', 'state', 'label', 'tag', 'tags', 'topic',
  'author', 'from', 'before', 'after', 'since', 'until', 'date',
  'has', 'intitle', 'inurl', 'sort', 'order', 'filter', 'domain', 'source',
]);

const COLON_HEAD = /^([\w-]+):/;

function lastSegment(chain: string): string {
  const segments = chain
    .toLowerCase()
    .split(SEPARATOR)
    .filter((segment) => segment.length > 0);
  return segments.at(-1) ?? '';
}

function isQueryFilterSyntax(chain: string, context: DetectorContext): boolean {
  const head = COLON_HEAD.exec(chain.toLowerCase())?.[1];
  if (head === undefined || !QUERY_FILTER_KEYS.has(head)) return false;
  const tail = lastSegment(chain);
  return !context.installedToolNames.some((name) => name.toLowerCase() === tail);
}

function isPlausibleToolReference(chain: string): boolean {
  const lower = chain.toLowerCase();
  if (COMMON_ABBREVIATIONS.has(lower)) return false;
  const last = lastSegment(lower);
  return !FILE_EXTENSIONS.has(last) && !TOP_LEVEL_DOMAINS.has(last);
}

/**
 * The words that turn a name into a redirection.
 *
 * Naming a tool is not the attack. Naming it *and pointing the model at it*
 * is. The shape rules above cannot tell `filesystem:read` from
 * `category:people`, because there is nothing there to tell apart — they are
 * the same shape, and one of them is a search filter. What separates them is
 * whether the surrounding sentence is sending the model somewhere.
 *
 * Deliberately narrow, and matched against a window rather than the whole
 * description, so a redirection three paragraphs away does not lend its
 * severity to an unrelated name.
 */
const REDIRECTION =
  /\b(?:use|uses|using|call|calls|calling|invoke|invokes|invoking|route|routes|routing|prefer|prefers|preferred|instead|rather\s+than|replaces?|replacing|delegates?|delegating|forwards?|redirects?|supersedes?|deprecated|in\s+place\s+of)\b/i;

/** How far either side of the name a redirection still counts. */
const REDIRECTION_WINDOW = 60;

interface RedirectionWindow {
  readonly text: string;
  readonly matchIndex: number;
  readonly chainLength: number;
}

function hasRedirectionNearby(window: RedirectionWindow): boolean {
  const { text, matchIndex, chainLength } = window;
  const end = matchIndex + chainLength;
  const before = text.slice(Math.max(0, matchIndex - REDIRECTION_WINDOW), matchIndex);
  const after = text.slice(end, end + REDIRECTION_WINDOW);
  return REDIRECTION.test(before) || REDIRECTION.test(after);
}

/**
 * A tool documenting the values of its own parameter is not shadowing anyone.
 *
 * `category:people` and `category:company` in a search tool's description are
 * the `category` parameter's accepted values, written in the filter syntax
 * every search product uses. Two of those cost a public server eighty points
 * of risk and a "keep this disabled" recommendation, over a description that
 * named no tool at all.
 *
 * Only the head segment is checked, and only where nothing nearby redirects
 * the model — which is what stops a server buying silence by declaring a
 * parameter called `filesystem`. The moment its description tells the model to
 * *call* `filesystem.read`, the redirection signal takes precedence over this.
 */
function ownParameterNames(tool: ManifestTool): ReadonlySet<string> {
  const properties = tool.inputSchema?.properties;
  if (properties === undefined) return new Set<string>();
  return new Set(Object.keys(properties).map((name) => name.toLowerCase()));
}

function documentsOwnParameter(
  chain: string,
  parameterNames: ReadonlySet<string>,
): boolean {
  const head = chain.toLowerCase().split(SEPARATOR).at(0) ?? '';
  return parameterNames.has(head);
}

interface QualifiedFindingOptions {
  readonly chain: string;
  readonly redirected: boolean;
  readonly text: string;
  readonly matchIndex: number;
  readonly context: DetectorContext;
}

function qualifiedReferenceFinding(options: QualifiedFindingOptions): DraftFinding {
  const { chain, redirected, text, matchIndex, context } = options;
  return {
    detector: 'D-09',
    severity: redirected ? 'critical' : 'medium',
    tool: context.tool.name,
    message: redirected
      ? `Description names "${chain}" and points the model at it, which reads ` +
        'as a tool belonging to another server. A server has no business ' +
        'directing calls meant for one you already trust.'
      : `Description names "${chain}", which is shaped like a tool on another ` +
        'server, though nothing around it tells the model to call it.',
    evidence: buildEvidence({
      context,
      pointerSegments: ['description'],
      snippetText: excerptAround({ text, matchIndex }),
    }),
    fix: redirected
      ? 'Reject the server, or at minimum keep it disabled while every tool ' +
        'it names is checked. This is how one bad server compromises the rest.'
      : 'Find out what that name refers to before enabling the server. A name ' +
        'on its own is not a redirection, but it is where one starts.',
  };
}

function findQualifiedReferences(
  text: string,
  context: DetectorContext,
): DraftFinding[] {
  // Blanking URLs rather than removing them keeps every index aligned with the
  // original text, so the evidence still points where the reader will look.
  const withoutUrls = text.replaceAll(URL_PATTERN, (url) => ' '.repeat(url.length));
  const parameterNames = ownParameterNames(context.tool);
  const findings: DraftFinding[] = [];
  const seen = new Set<string>();
  for (const match of withoutUrls.matchAll(QUALIFIED_CHAIN)) {
    const chain = match[0];
    if (seen.has(chain) || !isPlausibleToolReference(chain)) continue;
    if (isQueryFilterSyntax(chain, context)) continue;
    const redirected = hasRedirectionNearby({
      text: withoutUrls,
      matchIndex: match.index,
      chainLength: chain.length,
    });
    // Not marked seen: a later mention of the same name may carry the
    // redirection this one lacks, and that one is worth reporting.
    if (!redirected && documentsOwnParameter(chain, parameterNames)) continue;
    seen.add(chain);
    findings.push(
      qualifiedReferenceFinding({
        chain,
        redirected,
        text,
        matchIndex: match.index,
        context,
      }),
    );
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
