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

export const manifestToolSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: jsonSchemaObjectSchema.optional(),
  outputSchema: jsonSchemaObjectSchema.optional(),
  annotations: toolAnnotationsSchema.optional(),
});

export const namedEntrySchema = z.object({ name: z.string() }).passthrough();

export const serverInfoSchema = z
  .object({ name: z.string().optional(), version: z.string().optional() })
  .passthrough();

export const targetListingSchema = z.object({
  serverInfo: serverInfoSchema.optional(),
  capabilities: z.unknown().optional(),
  tools: z.object({ tools: z.array(manifestToolSchema) }),
  resources: z.object({ resources: z.array(namedEntrySchema) }).optional(),
  prompts: z.object({ prompts: z.array(namedEntrySchema) }).optional(),
});

/** How a manifest was obtained. It changes what the review can honestly claim. */
export const manifestSourceSchema = z.union([
  z.object({ kind: z.literal('direct'), url: z.string() }),
  z.object({ kind: z.literal('connector'), connectorName: z.string() }),
]);

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
  tools: z.array(manifestToolSchema),
  resourceNames: z.array(z.string()),
  promptNames: z.array(z.string()),
  manifestHash: z.string(),
  perToolHashes: z.record(z.string()),
});

export type ManifestTool = z.infer<typeof manifestToolSchema>;
export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;
export type JsonSchemaObject = z.infer<typeof jsonSchemaObjectSchema>;
export type TargetListingShape = z.infer<typeof targetListingSchema>;
export type ManifestSource = z.infer<typeof manifestSourceSchema>;
export type StoredManifest = z.infer<typeof storedManifestSchema>;
