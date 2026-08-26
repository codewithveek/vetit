import { describe, expect, it } from 'vitest';
import { descriptionLengthDetector } from '../../../../src/features/detection/detectors/index.js';
import { expectWellFormed, run } from './detector-support.js';

const detector = descriptionLengthDetector;

describe('D-10 descriptionLength — fires', () => {
  it('on a description long enough to bury something in', () => {
    const findings = run({ detector, text: 'padding. '.repeat(120) });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('low');
    expectWellFormed(findings);
  });

  it('says how long the description actually is', () => {
    const text = 'x'.repeat(1200);
    expect(run({ detector, text })[0]?.message).toContain('1200 characters');
  });

  it('still cuts the snippet to the untrusted budget', () => {
    const findings = run({ detector, text: 'y'.repeat(1200) });
    expect(findings[0]?.evidence.snippet.length).toBeLessThan(300);
  });
});

describe('D-10 descriptionLength — stays quiet', () => {
  it('on a short description', () => {
    expect(run({ detector, text: 'Searches the documentation index.' })).toEqual([]);
  });

  it('on a thorough but honest description', () => {
    expect(run({ detector, text: 'a'.repeat(700) })).toEqual([]);
  });

  it('exactly at the threshold, so the boundary is not off by one', () => {
    expect(run({ detector, text: 'a'.repeat(800) })).toEqual([]);
    expect(run({ detector, text: 'a'.repeat(801) })).toHaveLength(1);
  });

  it('on an empty description, which is a different finding entirely', () => {
    expect(run({ detector, text: '' })).toEqual([]);
  });
});
