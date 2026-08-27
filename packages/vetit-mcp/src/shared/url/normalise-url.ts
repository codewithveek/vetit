/**
 * Comparing two URLs for "is this the same endpoint?".
 *
 * Admission uses it to refuse applying one server's review to another, and
 * probing uses it to refuse calling a tool on a server the manifest did not
 * come from. Those are the same question, and a near-copy in each feature is
 * how they would come to answer it differently.
 *
 * Deliberately shallow: it folds a trailing slash, case in the host, and a
 * default port. It is not a security boundary on its own — two URLs that
 * normalise alike still might not be the same server tomorrow — and both
 * callers say so where they use it.
 */

const DEFAULT_PORTS: ReadonlyMap<string, string> = new Map([
  ['http:', '80'],
  ['https:', '443'],
]);

export function normaliseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.trim().toLowerCase();
  }
  const isDefaultPort = DEFAULT_PORTS.get(url.protocol) === url.port;
  const host = isDefaultPort ? url.hostname : url.host;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${host.toLowerCase()}${path}`;
}

/** Whether a URL points at this machine, and so at the same network namespace. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}
