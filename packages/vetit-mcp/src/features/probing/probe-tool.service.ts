import { z } from 'zod';
import { cleanUntrustedSnippet } from '../../shared/redaction/index.js';
import { withTargetSession, type TargetSession } from '../../shared/mcp-client/target-session.service.js';
import type { ManifestTool, StoredManifest } from '../manifest/index.js';
import { buildProbeArguments } from './build-probe-arguments.js';
import { startEgressCollector } from './egress-collector.service.js';
import type { ProbeObservation } from './probing.types.js';

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
 * A tool that reads state and needs no arguments, so it can be called before
 * and after without changing anything itself. Without one, a probe can still
 * observe egress and read the response, and the report says the read-back was
 * not available rather than implying the tool did not write.
 */
export function findReadBackTool(
  manifest: StoredManifest,
  excludeToolName: string,
): ManifestTool | undefined {
  return manifest.tools.find((tool) => {
    if (tool.name === excludeToolName) return false;
    if (tool.annotations?.readOnlyHint !== true) return false;
    return (tool.inputSchema?.required ?? []).length === 0;
  });
}

async function readBack(
  session: TargetSession,
  tool: ManifestTool | undefined,
): Promise<string | undefined> {
  if (tool === undefined) return undefined;
  try {
    return summariseResponse(await session.callTool(tool.name, {})).text;
  } catch {
    return undefined;
  }
}

export interface ProbeToolOptions {
  readonly url: string;
  readonly manifest: StoredManifest;
  readonly toolName: string;
  /** Overrides the synthetic arguments. Use only when a probe needs them. */
  readonly args?: Readonly<Record<string, unknown>>;
  /** Set true to probe a tool that does not claim to be read-only. */
  readonly allowNonReadOnly?: boolean;
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

/** Runs one probe: read the state, call the tool once, read the state again. */
export async function probeTool(options: ProbeToolOptions): Promise<ProbeObservation> {
  const tool = options.manifest.tools.find((entry) => entry.name === options.toolName);
  if (tool === undefined) {
    throw new ProbeRefusedError(`${options.toolName} is not in this manifest.`);
  }
  assertProbeAllowed(tool, options);

  const collector = await startEgressCollector();
  const readBackTool = findReadBackTool(options.manifest, options.toolName);
  const argumentsSent =
    options.args ?? buildProbeArguments({ tool, canaryValue: collector.canaryValue });
  const startedAt = Date.now();
  try {
    return await withTargetSession({ url: options.url }, async (session) => {
      const before = await readBack(session, readBackTool);
      const response = summariseResponse(
        await session.callTool(options.toolName, argumentsSent),
      );
      const after = await readBack(session, readBackTool);
      const hits = collector.hits();
      return {
        toolName: options.toolName,
        claimedReadOnly: tool.annotations?.readOnlyHint,
        claimedDestructive: tool.annotations?.destructiveHint,
        argumentsSent,
        responseSnippet: cleanUntrustedSnippet({ text: response.text }).renderedText,
        responseWasError: response.isError,
        readBackBefore: before,
        readBackAfter: after,
        egressHits: hits,
        canaryReturned: hits.some((hit) => hit.containedCanary),
        durationMs: Date.now() - startedAt,
      };
    });
  } finally {
    await collector.stop();
  }
}

export { startEgressCollector };
