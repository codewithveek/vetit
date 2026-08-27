import { z } from 'zod';

/**
 * What a target server is allowed to have sent us.
 *
 * Everything here arrives from a server we do not trust, so nothing is cast —
 * it is checked, at runtime, and the types are derived from the checks with
 * `z.infer` so the two cannot drift apart (spec §16.1).
 *
 * These schemas are permissive about *shape* and strict about *type*: a tool
 * with a missing description is a finding, not a parse failure, and Vetit
 * cannot report a finding on a manifest it refused to read.
 *
 * Every object schema here passes unknown keys through. A schema that drops
 * fields it was not expecting would quietly delete the very thing a reviewer
 * is looking for — an undeclared field on a tool is interesting precisely
 * because nobody expected it.
 */

export const toolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .passthrough();

export const jsonSchemaObjectSchema = z
  .object({
    type: z.string().optional(),
    properties: z.record(z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  })
  .passthrough();

export const manifestToolSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: jsonSchemaObjectSchema.optional(),
    outputSchema: jsonSchemaObjectSchema.optional(),
    annotations: toolAnnotationsSchema.optional(),
  })
  .passthrough();

export const namedEntrySchema = z.object({ name: z.string() }).passthrough();

export const serverInfoSchema = z
  .object({ name: z.string().optional(), version: z.string().optional() })
  .passthrough();

/** How a manifest was obtained. It changes what the review can honestly claim. */
export const manifestSourceSchema = z.union([
  z.object({ kind: z.literal('direct'), url: z.string() }),
  z.object({ kind: z.literal('connector'), connectorName: z.string() }),
]);

/**
 * The listing exactly as it arrived, before anything looked at it.
 *
 * This is the half of the file that earns the phrase "raw manifest". The
 * validated `tools` array below is a *view* for the machinery; this is the
 * evidence, and it keeps items that failed validation entirely, which the view
 * by definition cannot.
 */
export const rawListingSchema = z.object({
  serverInfo: z.unknown().optional(),
  capabilities: z.unknown().optional(),
  tools: z.array(z.unknown()),
  resources: z.array(z.unknown()).optional(),
  prompts: z.array(z.unknown()).optional(),
  pageCounts: z.object({
    tools: z.number(),
    resources: z.number(),
    prompts: z.number(),
  }),
});

/**
 * Where a listing operation stood.
 *
 * `unsupported` is the server saying it does not offer the operation.
 * A failure to find out is never recorded here — it fails the fetch instead.
 */
export const listingStatusSchema = z.enum(['listed', 'unsupported']);

/**
 * The on-disk record. Read back through this schema rather than trusted:
 * a file in the workdir is still input, and a half-written or hand-edited
 * manifest should fail loudly rather than quietly review as clean.
 */
export const storedManifestSchema = z.object({
  manifestId: z.string(),
  fetchedAt: z.string(),
  source: manifestSourceSchema,
  serverName: z.string().optional(),
  serverVersion: z.string().optional(),
  /** The validated view the detectors and the hash work from. */
  tools: z.array(manifestToolSchema),
  /** Items the target sent that are not usable as tools. Kept, not hidden. */
  unparseableToolCount: z.number(),
  resourceNames: z.array(z.string()),
  promptNames: z.array(z.string()),
  resourcesStatus: listingStatusSchema,
  promptsStatus: listingStatusSchema,
  manifestHash: z.string(),
  perToolHashes: z.record(z.string()),
  duplicateToolNames: z.array(z.string()),
  /** Verbatim. See `rawListingSchema`. */
  raw: rawListingSchema,
});

export type ManifestTool = z.infer<typeof manifestToolSchema>;
export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;
export type JsonSchemaObject = z.infer<typeof jsonSchemaObjectSchema>;
export type ManifestSource = z.infer<typeof manifestSourceSchema>;
export type RawListing = z.infer<typeof rawListingSchema>;
export type ListingStatus = z.infer<typeof listingStatusSchema>;
export type StoredManifest = z.infer<typeof storedManifestSchema>;
