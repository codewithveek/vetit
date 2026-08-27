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

describe('D-03 lookAlikeCharacters — a native name is not an impersonation', () => {
  function runOnNameWithInstalled(
    name: string,
    installedToolNames: readonly string[],
  ): ReturnType<typeof run> {
    return run({
      detector,
      text: name,
      context: buildContext({ tool: { name }, installedToolNames }),
    });
  }

  it('stays quiet on an all-Cyrillic name that resembles nothing', () => {
    // "поиск" — Russian for "search". It contains о and с, both in the
    // confusable table, and it impersonates nothing whatsoever. Reporting it
    // contradicted the detector's own stated rule.
    expect(runOnNameWithInstalled('поиск', [])).toEqual([]);
  });

  it('stays quiet on an all-Greek name', () => {
    expect(runOnNameWithInstalled('αναζήτηση', [])).toEqual([]);
  });

  it('fires when flattening the look-alikes produces an installed tool name', () => {
    // Fully non-ASCII, so the mixed-script rule cannot see it — but every
    // letter is a homoglyph of "copy", which is enabled here. That is
    // impersonation proven rather than suspected.
    const disguised = 'сору';
    const findings = runOnNameWithInstalled(disguised, ['copy']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('look-alike of "copy"');
  });

  it('does not fire on a skeleton that matches nothing installed', () => {
    expect(runOnNameWithInstalled('сору', ['list_spaces'])).toEqual([]);
  });

  it('still fires on the mixed-script case with no installed list at all', () => {
    expect(runOnNameWithInstalled('sendmеssage', [])).toHaveLength(1);
  });
});

describe('D-03 lookAlikeCharacters — non-letters are not another script', () => {
  function runOnName(name: string): ReturnType<typeof run> {
    return run({ detector, text: name, context: buildContext({ tool: { name } }) });
  }

  it.each([
    ['an emoji', 'search_\u{1F50D}'],
    ['a symbol', 'convert_€'],
    ['an en dash', 'search–docs'],
    ['a curly quote', 'don’t_do_this'],
    ['a combining mark', 'café_search'],
  ])('stays quiet on a name containing %s', (_label, name) => {
    // The check was \P{ASCII}, which matches emoji, punctuation, symbols and
    // combining marks. None of those resembles an ASCII letter, so none of
    // them impersonates anything.
    expect(runOnName(name)).toEqual([]);
  });

  it('still fires when a real foreign letter is mixed in', () => {
    expect(runOnName('search_中文')).toHaveLength(1);
  });
});
