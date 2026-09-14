import { join, normalize, sep } from 'path';

/**
 * Join `name` onto `dir`, returning null if the result escapes `dir`.
 *
 * Containment is checked instead of allowlisting characters because generated
 * file names legitimately contain backticks (generics, `Aggregator`1.json`),
 * spaces, parentheses and braces (doc slugs).
 */
export function resolveInside(dir: string, name: string): string | null {
  const full = normalize(join(dir, name));
  return full === dir || full.startsWith(dir + sep) ? full : null;
}
