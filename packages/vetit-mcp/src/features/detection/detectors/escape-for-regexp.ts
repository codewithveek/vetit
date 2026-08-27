/**
 * Escaping a tool or parameter name so it can be matched literally.
 *
 * Both D-07 and D-09 build a pattern around a name the *target* chose, so a
 * name containing `.` or `(` would otherwise be matched as a pattern rather
 * than as text — which a server could use to make one name match many.
 *
 * `-` is deliberately not escaped. It is only special inside a character
 * class, and `\-` outside one is an invalid escape under the `u` flag, which
 * threw at runtime on the first `kebab-case` parameter it met. Two copies of
 * this function is how that got missed, so there is one.
 */
const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

export function escapeForRegExp(value: string): string {
  return value.replaceAll(REGEXP_METACHARACTERS, String.raw`\$&`);
}
