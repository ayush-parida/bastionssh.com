import fs from 'node:fs';
import { parseEnv, readEnvFile } from './env.js';

/**
 * Masking `.env` values (deployments spec §8): an app's log can print its
 * secrets (a crash dump, a health check answering with its config), and what
 * bastionctl prints goes to BastionSSH's deploy log and stays on the server in
 * build.log and release.json. Every exact occurrence of a value of at least
 * {@link MIN_SECRET_LENGTH} characters is replaced with {@link MASK} in all
 * of those; shorter values (`1`, `true`, `prod`) would mask ordinary words.
 */

export const MASK = '••••';
export const MIN_SECRET_LENGTH = 6;

/**
 * The texts a value can show up as: itself; each of its lines, since a
 * multi-line value (a PEM key) printed by the app reaches bastionctl one log
 * line at a time; and its JSON-escaped form (an app logging its config as
 * JSON, release.json).
 */
function forms(value: string): string[] {
  const out = [value];
  if (/[\r\n]/.test(value)) out.push(...value.split(/\r?\n|\r/).map((line) => line.trim()));
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value) out.push(escaped);
  return out;
}

/** A function replacing every occurrence of `values` (long enough) in a text. */
export function secretMasker(values: Iterable<string>): (text: string) => string {
  // Longest first: a value containing another is masked whole
  const secrets = [...new Set([...values].filter((v) => v.length >= MIN_SECRET_LENGTH).flatMap(forms).filter((v) => v.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  if (secrets.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(MASK);
    return out;
  };
}

/**
 * A masker for the values in an env file, read again whenever the file
 * changes (a value set during a deploy is masked from then on).
 */
export function envFileMasker(file: string): (text: string) => string {
  let stamp = '';
  let mask: (text: string) => string = (text) => text;
  return (text) => {
    let next = 'missing';
    try {
      const stat = fs.statSync(file);
      next = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {
      // no env file: nothing to mask
    }
    if (next !== stamp) {
      stamp = next;
      try {
        mask = secretMasker(parseEnv(readEnvFile(file)).values());
      } catch {
        mask = (t) => t;
      }
    }
    return mask(text);
  };
}
