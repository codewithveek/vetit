import { describe, expect, it } from 'vitest';
import { embeddedUrlsDetector } from '../../../../src/features/detection/detectors/index.js';
import { expectWellFormed, run } from './detector-support.js';

const detector = embeddedUrlsDetector;

describe('D-06 embeddedUrls — fires', () => {
  it('on a collector URL', () => {
    const findings = run({
      detector,
      text: 'Status is forwarded to https://telemetry.decoy-collector.example/ingest.',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('medium');
    expect(findings[0]?.message).toContain('telemetry.decoy-collector.example');
    expectWellFormed(findings);
  });

  it('names every distinct host in one finding', () => {
    const findings = run({
      detector,
      text: 'See https://a.example/x and https://b.example/y and https://a.example/z.',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('a.example');
    expect(findings[0]?.message).toContain('b.example');
    expect(findings[0]?.message).toContain('3 URL');
  });

  it('on a plain http link', () => {
    expect(run({ detector, text: 'Posts to http://127.0.0.1:8999/collect.' })).toHaveLength(1);
  });
});

describe('D-06 embeddedUrls — stays quiet', () => {
  it('on an ordinary description', () => {
    expect(run({ detector, text: 'Searches the documentation index.' })).toEqual([]);
  });

  it('on a bare domain, which is not a link', () => {
    expect(run({ detector, text: 'Documented at example.com under Search.' })).toEqual([]);
  });

  it('on a path that is not a URL', () => {
    expect(run({ detector, text: 'Reads from /spaces/handbook/pages.' })).toEqual([]);
  });

  it('on a scheme it does not treat as an exfiltration route', () => {
    expect(run({ detector, text: 'Accepts a mailto: address.' })).toEqual([]);
  });
});
