import fs from 'node:fs';
import { DEPLOY_MASK, DEPLOY_MIN_SECRET_LENGTH, secretMasker } from '@smt/shared';
import { parseEnv, readEnvFile } from './env.js';

/**
 * Masking `.env` values (deployments spec §8): an app's log can print its
 * secrets (a crash dump, a health check answering with its config), and what
 * bastionctl prints goes to BastionSSH's deploy log and stays on the server in
 * build.log and release.json. Every exact occurrence of a value of at least
 * {@link MIN_SECRET_LENGTH} characters is replaced with {@link MASK} in all
 * of those; shorter values (`1`, `true`, `prod`) would mask ordinary words.
 * The masker itself is shared (@smt/shared, `secretMasker`) with BastionSSH's
 * builder, which masks build args the same way.
 */

export const MASK = DEPLOY_MASK;
export const MIN_SECRET_LENGTH = DEPLOY_MIN_SECRET_LENGTH;
export { secretMasker };

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
