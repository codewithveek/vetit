import { z } from 'zod';
import type { ManifestTool } from '../manifest/index.js';

/**
 * Choosing what to send a tool you do not trust.
 *
 * The rules come from §6: harmless made-up arguments, nothing real, nothing
 * that could destroy anything if the tool turns out to be worse than
 * advertised. So required fields are filled with obviously synthetic values
 * and nothing else is sent at all.
 *
 * One field gets special treatment. If the tool has a free-text parameter that
 * looks like a channel for moving data out — the `sidenote` in the canonical
 * attack — the tripwire value goes there. If the tool forwards it anywhere,
 * the collector sees it, and that is the finding no description scanner can
 * produce.
 */

const propertySchema = z
  .object({ type: z.unknown().optional(), enum: z.array(z.unknown()).optional() })
  .passthrough();

const SUSPICIOUS_SINKS: ReadonlySet<string> = new Set([
  'sidenote',
  'context',
  'notes',
  'note',
  'debug',
  'debug_context',
  'metadata',
  'meta',
  'extra',
  'payload',
  'comment',
]);

const PLACEHOLDER_TEXT = 'vetit-probe';

function placeholderFor(property: unknown): unknown {
  const parsed = propertySchema.safeParse(property);
  const type = parsed.success ? parsed.data.type : undefined;
  const enumValues = parsed.success ? parsed.data.enum : undefined;
  if (enumValues !== undefined && enumValues.length > 0) return enumValues[0];
  if (type === 'number' || type === 'integer') return 1;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return PLACEHOLDER_TEXT;
}

function isFreeText(property: unknown): boolean {
  const parsed = propertySchema.safeParse(property);
  if (!parsed.success) return false;
  return parsed.data.type === 'string' || parsed.data.type === undefined;
}

/** The parameter most likely to be a way out, if the tool has one. */
export function findSinkParameter(tool: ManifestTool): string | undefined {
  const properties = tool.inputSchema?.properties ?? {};
  return Object.entries(properties)
    .filter(([name, property]) => SUSPICIOUS_SINKS.has(name.toLowerCase()) && isFreeText(property))
    .map(([name]) => name)[0];
}

export interface ProbeArgumentOptions {
  readonly tool: ManifestTool;
  readonly canaryValue: string;
}

export function buildProbeArguments(
  options: ProbeArgumentOptions,
): Record<string, unknown> {
  const schema = options.tool.inputSchema;
  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];
  const args: Record<string, unknown> = {};
  for (const name of required) {
    args[name] = placeholderFor(properties[name]);
  }
  const sink = findSinkParameter(options.tool);
  if (sink !== undefined) args[sink] = options.canaryValue;
  return args;
}
