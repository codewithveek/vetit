/**
 * Where the TrueForge admin API lives, and how to authenticate to it.
 *
 * Note what is *not* here: the target server's credential. Vetit registers a
 * connector, hands the key straight to the harness, and never reads it back.
 * See spec §6 — a security tool holding everyone's keys is the biggest target
 * in the stack.
 */

const DEFAULT_BASE_URL = 'http://localhost:8790';

export interface TrueforgeEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}

export function resolveTrueforgeEndpoint(): TrueforgeEndpoint {
  const configuredUrl = process.env['TRUEFORGE_BASE_URL'];
  const apiKey = process.env['TRUEFORGE_API_KEY'];
  return {
    baseUrl: (configuredUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined,
  };
}

export function buildTrueforgeHeaders(
  endpoint: TrueforgeEndpoint,
): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.apiKey !== undefined) {
    headers['authorization'] = `Bearer ${endpoint.apiKey}`;
  }
  return headers;
}
