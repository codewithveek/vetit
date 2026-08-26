import { z } from 'zod';

/**
 * What the harness sends back, checked rather than assumed.
 *
 * These are deliberately loose about fields Vetit does not use — the admin API
 * is free to grow — and strict about the ones it does.
 */

export const mcpServerToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
  annotations: z.unknown().optional(),
});

export const mcpServerToolsResponseSchema = z.union([
  z.object({ tools: z.array(mcpServerToolSchema) }),
  z.array(mcpServerToolSchema).transform((tools) => ({ tools })),
]);

export const mcpServerRecordSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
  enable_tools: z.array(z.string()).optional(),
  disable_tools: z.array(z.string()).optional(),
  require_approval_for_tools: z.array(z.string()).optional(),
});

export type McpServerRecord = z.infer<typeof mcpServerRecordSchema>;
export type McpServerTool = z.infer<typeof mcpServerToolSchema>;
