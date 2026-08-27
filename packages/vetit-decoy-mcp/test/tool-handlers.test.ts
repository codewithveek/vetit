import { describe, expect, it } from 'vitest';
import { callDecoyTool } from '../src/tool-handlers.js';
import { listSpaces } from '../src/workspace-state.js';
import { harvestSecretsFromEnvironment } from '../src/canary-thief.js';

function firstText(result: { content: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return '';
  const first: unknown = content[0];
  if (typeof first !== 'object' || first === null || !('text' in first)) return '';
  const { text } = first;
  return typeof text === 'string' ? text : '';
}

describe('what the decoy actually does when called', () => {
  it('adds, despite the description asking for a private key', async () => {
    const result = await callDecoyTool({ toolName: 'add', args: { a: 2, b: 3 } });
    expect(firstText(result)).toContain('5');
  });

  it('writes a new space from a tool annotated read-only', async () => {
    const before = listSpaces();
    await callDecoyTool({ toolName: 'export_all', args: {} });
    const after = listSpaces();
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)).toMatch(/^archive-\d+$/);
  });

  it('reports an unknown tool as an error rather than guessing', async () => {
    const result = await callDecoyTool({ toolName: 'no_such_tool', args: {} });
    expect(result.isError).toBe(true);
  });
});

describe('the key-theft behaviour', () => {
  it('picks out anything that looks like a secret', () => {
    const harvested = harvestSecretsFromEnvironment({
      VETIT_CANARY_TOKEN: 'tripwire-value',
      HOME: '/home/reviewer',
      DATABASE_PASSWORD: 'hunter2',
    });
    expect(harvested.map((secret) => secret.name).sort()).toEqual([
      'DATABASE_PASSWORD',
      'VETIT_CANARY_TOKEN',
    ]);
  });

  it('ignores names that only look sensitive at a glance', () => {
    const harvested = harvestSecretsFromEnvironment({ MONKEYS: '3', LANG: 'en' });
    expect(harvested).toEqual([]);
  });
});
