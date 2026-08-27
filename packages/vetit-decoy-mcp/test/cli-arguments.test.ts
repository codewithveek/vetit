import { describe, expect, it } from 'vitest';
import { parseDecoyArguments } from '../src/index.js';
import type { DecoyCliOptions } from '../src/index.js';

/**
 * What the CLI accepts, and what it refuses.
 *
 * The old parser used `Number.parseInt`, which reads a prefix and stops. That
 * turned `--port 8931junk` into a silent 8931 and let `-1` and `99999` through
 * to `app.listen`, where they throw. Both halves mattered: quietly listening
 * somewhere other than where you were asked is its own kind of wrong.
 */

function optionsFor(argv: readonly string[]): DecoyCliOptions {
  const parsed = parseDecoyArguments(argv);
  if (!parsed.ok) throw new Error(`expected success, got: ${parsed.message}`);
  return parsed.options;
}

function messageFor(argv: readonly string[]): string {
  const parsed = parseDecoyArguments(argv);
  if (parsed.ok) throw new Error('expected a rejection, got options');
  return parsed.message;
}

describe('what it accepts', () => {
  it('defaults to 8931 with no arguments', () => {
    expect(optionsFor([])).toEqual({ port: 8931, isPoisoned: false });
  });

  it('takes a port', () => {
    expect(optionsFor(['--port', '9000']).port).toBe(9000);
  });

  it('takes the flags in either order', () => {
    expect(optionsFor(['--poison', '--port', '9000'])).toEqual({
      port: 9000,
      isPoisoned: true,
    });
    expect(optionsFor(['--port', '9000', '--poison'])).toEqual({
      port: 9000,
      isPoisoned: true,
    });
  });

  it('takes the ends of the valid range', () => {
    expect(optionsFor(['--port', '1']).port).toBe(1);
    expect(optionsFor(['--port', '65535']).port).toBe(65_535);
  });

  it('takes a padded number, which is unambiguous', () => {
    expect(optionsFor(['--port', '08931']).port).toBe(8931);
  });

  it('ignores arguments it does not know about', () => {
    expect(optionsFor(['--verbose', '--port', '9000']).port).toBe(9000);
  });
});

describe('what it refuses', () => {
  it('refuses a numeric prefix rather than silently using it', () => {
    // The original bug: this used to start a server on 8931.
    expect(messageFor(['--port', '8931junk'])).toContain('whole number');
  });

  it('refuses a negative port', () => {
    expect(messageFor(['--port', '-1'])).toContain('whole number');
  });

  it('refuses a port above the valid range', () => {
    expect(messageFor(['--port', '99999'])).toContain('between 1 and 65535');
  });

  it('refuses port 0, which would make the startup line a lie', () => {
    expect(messageFor(['--port', '0'])).toContain('between 1 and 65535');
  });

  it('refuses a decimal', () => {
    expect(messageFor(['--port', '80.5'])).toContain('whole number');
  });

  it('refuses hex, which parseInt would have read as 0', () => {
    expect(messageFor(['--port', '0x20'])).toContain('whole number');
  });

  it('refuses an explicit plus sign', () => {
    expect(messageFor(['--port', '+9000'])).toContain('whole number');
  });

  it('refuses whitespace around the number', () => {
    expect(messageFor(['--port', ' 9000'])).toContain('whole number');
  });

  it('refuses --port with nothing after it', () => {
    expect(messageFor(['--port'])).toContain('requires a value');
  });

  it('refuses --port swallowing the next flag', () => {
    // Without the anchored pattern this parsed as NaN and fell back to 8931,
    // so `--port --poison` started a server and looked like it worked.
    expect(messageFor(['--port', '--poison'])).toContain('whole number');
  });

  it('names the value it refused, so the message is actionable', () => {
    expect(messageFor(['--port', '8931junk'])).toContain('8931junk');
  });
});
