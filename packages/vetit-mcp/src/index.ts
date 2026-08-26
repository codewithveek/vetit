#!/usr/bin/env node
import { createVetitApp } from './server.js';
import { resolveWorkdir } from './shared/workdir/index.js';

/**
 * vetit-mcp — review an MCP server before you trust it.
 *
 *   npx vetit-mcp                # listens on 127.0.0.1:8930
 *   npx vetit-mcp --port 9000
 *
 * Vetit is a defensive tool. Point it only at servers you own or have written
 * permission to test.
 */

const DEFAULT_PORT = 8930;

export interface VetitCliOptions {
  readonly port: number;
}

export function parseVetitArguments(argv: readonly string[]): VetitCliOptions {
  const portIndex = argv.indexOf('--port');
  const rawPort = portIndex === -1 ? undefined : argv[portIndex + 1];
  const parsedPort = rawPort === undefined ? Number.NaN : Number.parseInt(rawPort, 10);
  return { port: Number.isInteger(parsedPort) ? parsedPort : DEFAULT_PORT };
}

function startVetit(options: VetitCliOptions): void {
  createVetitApp().listen(options.port, '127.0.0.1', () => {
    process.stdout.write(
      `vetit-mcp listening on http://127.0.0.1:${String(options.port)}/mcp\n` +
        `workdir: ${resolveWorkdir()}\n`,
    );
  });
}

if (process.argv[1] !== undefined && import.meta.url.endsWith('index.js')) {
  startVetit(parseVetitArguments(process.argv.slice(2)));
}

export { createVetitApp, createVetitMcpServer } from './server.js';
