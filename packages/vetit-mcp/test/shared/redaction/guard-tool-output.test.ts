import { describe, expect, it } from 'vitest';
import {
  cleanUntrustedSnippet,
  guardToolPayload,
} from '../../../src/shared/redaction/index.js';

/**
 * The gate at the transport boundary. Its job is the strings Vetit did not
 * write and would otherwise forward without thinking: tool names, host names,
 * and the tag name interpolated into a detector's message.
 */

describe('guardToolPayload', () => {
  it('makes an invisible character in a tool name visible', () => {
    const guarded = guardToolPayload({ tool: 'search\u200Bdocs' });
    expect(JSON.stringify(guarded)).toContain('ZWSP');
  });

  it('neutralises a tag name that reached a message', () => {
    const guarded = guardToolPayload({
      message: 'Description contains a <IMPORTANT> block.',
    });
    expect(JSON.stringify(guarded)).not.toContain('<IMPORTANT>');
  });

  it('guards object keys, because a tool name becomes one', () => {
    const guarded = guardToolPayload({ per_tool_hashes: { 'a\u202Eb': 'hash' } });
    expect(JSON.stringify(guarded)).toContain('RLO');
  });

  it('walks arrays and nested objects', () => {
    const guarded = guardToolPayload({
      findings: [{ evidence: { snippet: 'plain', pointer: '<x>' } }],
    });
    expect(JSON.stringify(guarded)).not.toContain('<x>');
  });

  it('leaves an already-cleaned snippet exactly as it is', () => {
    const cleaned = cleanUntrustedSnippet({ text: '<!-- hidden -->' }).renderedText;
    const guarded = guardToolPayload({ snippet: cleaned });
    expect(JSON.stringify(guarded)).toContain(JSON.stringify(cleaned).slice(1, -1));
  });

  it('leaves numbers, booleans and null alone', () => {
    expect(guardToolPayload({ count: 3, ok: true, missing: null })).toEqual({
      count: 3,
      ok: true,
      missing: null,
    });
  });

  it('does not mangle a Windows path', () => {
    const path = String.raw`C:\Users\reviewer\.vetit\manifests\01J.json`;
    expect(guardToolPayload({ path })).toEqual({ path });
  });
});
