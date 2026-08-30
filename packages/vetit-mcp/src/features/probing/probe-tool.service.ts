import { z } from 'zod';
import { cleanUntrustedSnippet } from '../../shared/redaction/index.js';
import { isLoopbackUrl, normaliseUrl } from '../../shared/url/index.js';
import { withTargetSession, type TargetSession } from '../../shared/mcp-client/target-session.service.js';
import { readConnector } from '../../shared/trueforge-client/index.js';
import type { ManifestTool, StoredManifest } from '../manifest/index.js';
import { buildProbeArguments } from './build-probe-arguments.js';
import { startEgressCollector, type EgressCollector } from './egress-collector.service.js';
import type {
  EgressObservation,
  ProbeObservation,
  ReadBackPhase,
} from './probing.types.js';

/**
 * Calling a tool for real, and watching what happens.
 *
 * This is the part of Vetit that nothing else in §3 does, and it is also the
 * part with a risk that cannot be argued away: testing a hostile server can
 * change something on that server's side. §6 keeps that risk small rather
 * than pretending it is gone — one call per tool, harmless synthetic
 * arguments, a read-only default, and an approval pause nobody can skip.
 *
 * The ledger below enforces the "one call per tool per run" rule in code
 * rather than in a comment, because a rate limit that depends on the caller
 * remembering is not a rate limit.
 */

const probeLedger = new Set<string>();

export function resetProbeLedger(): void {
  probeLedger.clear();
}

export class ProbeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeRefusedError';
  }
}

const callResultSchema = z.object({
  content: z.array(z.unknown()).optional(),
  isError: z.boolean().optional(),
});

const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() });

function summariseResponse(raw: unknown): { text: string; isError: boolean } {
  const parsed = callResultSchema.safeParse(raw);
  if (!parsed.success) return { text: '', isError: false };
  const blocks = parsed.data.content ?? [];
  const texts = blocks
    .map((block) => textBlockSchema.safeParse(block))
    .filter((block) => block.success)
    .map((block) => block.data.text);
  return { text: texts.join('\n'), isError: parsed.data.isError === true };
}

/**
 * The endpoint a manifest actually authorises probing.
 *
 * `manifest_id` and `url` used to be independent, so a benign manifest could
 * authorise a call to a same-named destructive tool on a different server —
 * with arguments built from the wrong schema, and the wrong server's
 * annotations reported as if they belonged to the target. The endpoint now
 * comes from the manifest, never from the caller.
 */
export async function resolveProbeTarget(manifest: StoredManifest): Promise<string> {
  const { source } = manifest;
  if (source.kind === 'direct') return source.url;
  // A connector's endpoint lives on its manifest, and the harness requires it
  // there — so an absent url is a malformed response, not a configuration to
  // reason about, and the schema rejects it before this line.
  return (await readConnector(source.connectorName)).manifest.url;
}

function assertUrlMatchesManifest(target: string, supplied: string | undefined): void {
  if (supplied === undefined) return;
  if (normaliseUrl(supplied) === normaliseUrl(target)) return;
  throw new ProbeRefusedError(
    `This manifest was fetched from ${target}, not ${supplied}. Refusing to ` +
      "call one server's tool using another server's review.",
  );
}

/**
 * The reader is named by the operator, never guessed.
 *
 * The first read-only, no-argument tool used to be picked automatically and
 * its output compared before and after. Nothing established that it observed
 * the probed tool's state at all: an unrelated reader whose output naturally
 * varies made a clean tool look like a liar, and an unrelated *stable* reader
 * hid a real write behind an unchanged string. Neither MCP annotations nor
 * the manifest record which reader sees which writer, so Vetit does not
 * pretend to know. Without one, the comparison is reported as not requested.
 */
function findReadBackTool(
  manifest: StoredManifest,
  readBackToolName: string | undefined,
): ManifestTool | undefined {
  if (readBackToolName === undefined) return undefined;
  const tool = manifest.tools.find((entry) => entry.name === readBackToolName);
  if (tool === undefined) {
    throw new ProbeRefusedError(`${readBackToolName} is not in this manifest.`);
  }
  if (tool.annotations?.readOnlyHint !== true) {
    throw new ProbeRefusedError(
      `${readBackToolName} does not claim to be read-only, so calling it twice ` +
        'around the probe could change the very state being compared.',
    );
  }
  return tool;
}

interface ReadBackOptions {
  readonly session: TargetSession;
  readonly tool: ManifestTool | undefined;
}

async function readBack(options: ReadBackOptions): Promise<ReadBackPhase> {
  if (options.tool === undefined) return { status: 'not_requested' };
  try {
    const response = await options.session.callTool(options.tool.name, {});
    return { status: 'read', value: summariseResponse(response).text };
  } catch (error) {
    // Reported rather than swallowed: a pre-read that worked and a post-read
    // that timed out used to be indistinguishable from both succeeding.
    return { status: 'failed', reason: String(error).slice(0, 200) };
  }
}

/**
 * Could the tripwire have seen anything at all?
 *
 * The collector binds loopback, so a target on another host or in another
 * container cannot reach it — and a thief there showed zero outgoing requests,
 * which reads as innocent. An operator who knows the collector is reachable
 * says so with VETIT_COLLECTOR_PUBLIC_URL; otherwise only a loopback target
 * can be watched, and anything else is reported as not performed.
 */
function describeEgress(
  collector: EgressCollector,
  targetUrl: string,
): EgressObservation {
  const reachableUrl = collector.publicUrl ?? (isLoopbackUrl(targetUrl) ? collector.url : undefined);
  if (reachableUrl === undefined) {
    return {
      status: 'not_performed',
      reason:
        `The tripwire collector listens on ${collector.url}, which a target at ` +
        `${targetUrl} cannot reach. Set VETIT_COLLECTOR_PUBLIC_URL to an ` +
        'address the target can call. Until then this probe says nothing ' +
        'either way about whether the tool sends data out.',
    };
  }
  const hits = collector.hits();
  return {
    status: 'observed',
    collectorUrl: reachableUrl,
    hits,
    canaryReturned: hits.some((hit) => hit.containedCanary),
  };
}

export interface ProbeToolOptions {
  readonly manifest: StoredManifest;
  readonly toolName: string;
  /** Checked against the manifest's own endpoint when supplied. */
  readonly url?: string;
  /** Overrides the synthetic arguments. Use only when a probe needs them. */
  readonly args?: Readonly<Record<string, unknown>>;
  /** Set true to probe a tool that does not claim to be read-only. */
  readonly allowNonReadOnly?: boolean;
  /** A read-only tool the operator says observes this tool's state. */
  readonly readBackToolName?: string;
  readonly ledgerKey: string;
}

function assertProbeAllowed(tool: ManifestTool, options: ProbeToolOptions): void {
  const key = `${options.ledgerKey}:${options.toolName}`;
  if (probeLedger.has(key)) {
    throw new ProbeRefusedError(
      `${options.toolName} has already been probed in this run. One call per ` +
        'tool per run: probing a hostile server can change something on its ' +
        'side, and the second call is the one that turns a test into damage.',
    );
  }
  const claimsReadOnly = tool.annotations?.readOnlyHint === true;
  if (!claimsReadOnly && options.allowNonReadOnly !== true) {
    throw new ProbeRefusedError(
      `${options.toolName} does not claim to be read-only. Probing it may ` +
        'change something on the target. Pass allow_non_read_only if that is ' +
        'understood and accepted.',
    );
  }
  probeLedger.add(key);
}

interface ProbeRun {
  readonly options: ProbeToolOptions;
  readonly tool: ManifestTool;
  readonly targetUrl: string;
  readonly collector: EgressCollector;
}

async function runProbe(run: ProbeRun): Promise<ProbeObservation> {
  const { options, tool, targetUrl, collector } = run;
  const readBackTool = findReadBackTool(options.manifest, options.readBackToolName);
  const argumentsSent =
    options.args ?? buildProbeArguments({ tool, canaryValue: collector.canaryValue });
  const startedAt = Date.now();

  return await withTargetSession({ url: targetUrl }, async (session) => {
    const before = await readBack({ session, tool: readBackTool });
    const response = summariseResponse(
      await session.callTool(options.toolName, argumentsSent),
    );
    const after = await readBack({ session, tool: readBackTool });
    // Only now: a fire-and-forget request may still be in flight.
    await collector.drain();
    return {
      toolName: options.toolName,
      url: targetUrl,
      claimedReadOnly: tool.annotations?.readOnlyHint,
      claimedDestructive: tool.annotations?.destructiveHint,
      argumentsSent,
      responseSnippet: cleanUntrustedSnippet({ text: response.text }).renderedText,
      responseWasError: response.isError,
      readBackTool: readBackTool?.name,
      readBackBefore: before,
      readBackAfter: after,
      egress: describeEgress(collector, targetUrl),
      durationMs: Date.now() - startedAt,
    };
  });
}

/** Runs one probe: read the state, call the tool once, read the state again. */
export async function probeTool(options: ProbeToolOptions): Promise<ProbeObservation> {
  const tool = options.manifest.tools.find((entry) => entry.name === options.toolName);
  if (tool === undefined) {
    throw new ProbeRefusedError(`${options.toolName} is not in this manifest.`);
  }
  const targetUrl = await resolveProbeTarget(options.manifest);
  assertUrlMatchesManifest(targetUrl, options.url);
  assertProbeAllowed(tool, options);

  const collector = await startEgressCollector();
  try {
    return await runProbe({ options, tool, targetUrl, collector });
  } finally {
    await collector.stop();
  }
}

export { startEgressCollector };
