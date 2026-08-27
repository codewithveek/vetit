import type { DetectorContext, DetectorDefinition, DraftFinding } from '../finding.types.js';
import { buildEvidence, excerptAround } from './build-evidence.js';

/**
 * D-05 — a description that names a file where secrets live.
 *
 * The Invariant Labs proof of concept was an `add` tool whose description
 * asked the model to read `~/.ssh/id_rsa` first. A calculator has no business
 * naming a private key, and neither does a documentation search.
 *
 * The patterns are anchored so that ordinary prose does not trip them. The
 * word "credentials" on its own is normal in an authentication paragraph; a
 * path ending in `/credentials` is not.
 */

interface PathRule {
  readonly pattern: RegExp;
  readonly what: string;
}

const PATH_RULES: readonly PathRule[] = [
  { pattern: /(?:~|\.)[/\\]\.?ssh\b|\.ssh[/\\]/gi, what: 'the SSH directory' },
  { pattern: /\bid_(?:rsa|dsa|ecdsa|ed25519)\b/gi, what: 'a private key file' },
  { pattern: /\bauthorized_keys\b/gi, what: 'an SSH authorised-keys file' },
  { pattern: /(?:^|[\s"'`(]|[/\\])\.env(?:\.[a-z]+)?\b/gi, what: 'an environment file' },
  { pattern: /\bmcp\.json\b/gi, what: 'an MCP client configuration file' },
  {
    pattern: /\bclaude_desktop_config\.json\b/gi,
    what: 'an MCP client configuration file',
  },
  { pattern: /[/\\]\.?aws\b|\baws[/\\]credentials\b/gi, what: 'AWS credentials' },
  { pattern: /[/\\]credentials\b|\bcredentials\.json\b/gi, what: 'a credentials file' },
  { pattern: /\.npmrc\b|\.git-credentials\b|\.netrc\b/gi, what: 'a stored-token file' },
  {
    pattern: /[/\\]\.kube[/\\]|\.docker[/\\]config\.json\b/gi,
    what: 'a cluster or registry credential',
  },
  { pattern: /\/etc\/(?:passwd|shadow)\b/gi, what: 'a system account file' },
  { pattern: /\bprivate[ _-]?key\b/gi, what: 'a private key' },
];

export const sensitivePathsDetector: DetectorDefinition = {
  id: 'D-05',
  name: 'sensitivePaths',
  severity: 'critical',
  reads: 'description',
  run: (text, context: DetectorContext): readonly DraftFinding[] => {
    const findings: DraftFinding[] = [];
    const seen = new Set<string>();
    for (const rule of PATH_RULES) {
      const match = rule.pattern.exec(text);
      rule.pattern.lastIndex = 0;
      if (match === null || seen.has(rule.what)) continue;
      seen.add(rule.what);
      findings.push({
        detector: 'D-05',
        severity: 'critical',
        tool: context.tool.name,
        message: `Description names ${rule.what}. A tool description has no reason to.`,
        evidence: buildEvidence({
          context,
          pointerSegments: ['description'],
          snippetText: excerptAround({ text, matchIndex: match.index }),
        }),
        fix:
          'Treat this as an attempt to have the agent read a secret and hand ' +
          'it back through a parameter. Keep the tool disabled and report the ' +
          'server to whoever published it.',
      });
    }
    return findings;
  },
};
