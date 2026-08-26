import { describe, expect, it } from 'vitest';
import { lookAlikeCharactersDetector } from '../../../../src/features/detection/detectors/index.js';
import { buildContext, expectWellFormed, run } from './detector-support.js';

const detector = lookAlikeCharactersDetector;

function runOnName(name: string): ReturnType<typeof run> {
  return run({ detector, text: name, context: buildContext({ tool: { name } }) });
}

describe('D-03 lookAlikeCharacters — fires', () => {
  it('on a Cyrillic e hiding in an ASCII name', () => {
    const findings = runOnName('sendm\u0435ssage');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('high');
    expect(findings[0]?.message).toContain('U+0435');
    expectWellFormed(findings);
  });

  it('on a Cyrillic a', () => {
    expect(runOnName('cre\u0430te_page')).toHaveLength(1);
  });

  it('on a Greek omicron', () => {
    expect(runOnName('exp\u03BFrt_all')).toHaveLength(1);
  });

  it('on mixed script even when the character is not in the table', () => {
    const findings = runOnName('search_\u4E2D\u6587_docs');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('mixes ASCII letters');
  });

  it('points at the name, not the description', () => {
    expect(runOnName('sendm\u0435ssage')[0]?.evidence.jsonPointer).toBe('/tools/0/name');
  });
});

describe('D-03 lookAlikeCharacters — stays quiet', () => {
  it('on an ordinary name', () => {
    expect(runOnName('search_docs')).toEqual([]);
  });

  it('on names with digits, dashes and dots', () => {
    expect(runOnName('get-page.v2')).toEqual([]);
  });

  it('on a name written entirely in another script, which impersonates nothing', () => {
    expect(runOnName('\u691C\u7D22')).toEqual([]);
  });

  it('on a description that happens to contain Cyrillic', () => {
    expect(
      run({
        detector,
        text: 'search_docs',
        context: buildContext({ tool: { name: 'search_docs' } }),
      }),
    ).toEqual([]);
  });
});
