import fs from 'node:fs';
import path from 'node:path';
import { BastionError, envKey, ENV_KEY_PATTERN } from './names.js';

/**
 * The app's `.env` (deployments spec §3): secrets, mode 0600, injected into
 * the container at run time as its environment. Values are never printed —
 * `keys` lists names, and only `get` (BastionSSH's step-up reveal) returns
 * one value.
 *
 * Format: `KEY=value` lines; `#` comments and blank lines are kept as they
 * are. A value may be "double quoted" (with \n, \r, \t, \" and \\ escapes) or
 * 'single quoted' (literal); written values are always double quoted, so any
 * value round-trips.
 */

export const MAX_ENV_BYTES = 256 * 1024;
export const MAX_VALUE_BYTES = 64 * 1024;

interface Line {
  raw: string;
  key: string | null;
}

function splitLines(text: string): Line[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return lines.map((raw) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw);
    return { raw, key: m ? m[1]! : null };
  });
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, (_m, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c as 'n' | 'r' | 't'] ?? c);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  // Unquoted: a trailing ` # comment` is not part of the value
  return v.replace(/\s+#.*$/, '');
}

export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/** Variables in file order; a repeated key keeps its last value, as shells do. */
export function parseEnv(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of splitLines(text)) {
    if (!line.key) continue;
    vars.delete(line.key);
    vars.set(line.key, unquote(line.raw.slice(line.raw.indexOf('=') + 1)));
  }
  return vars;
}

/** `text` with `key` set to `value` (in place when present, appended otherwise). */
export function setEnv(text: string, key: string, value: string): string {
  envKey(key);
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new BastionError(`Value is larger than ${MAX_VALUE_BYTES / 1024} KiB`);
  if (value.includes('\0')) throw new BastionError('Values cannot contain NUL bytes');
  const lines = splitLines(text);
  const entry = `${key}=${quote(value)}`;
  let replaced = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.key !== key) out.push(line.raw);
    else if (!replaced) {
      out.push(entry);
      replaced = true;
    }
  }
  if (!replaced) out.push(entry);
  return out.join('\n') + '\n';
}

/** `text` without `key`; null when it was not set. */
export function unsetEnv(text: string, key: string): string | null {
  envKey(key);
  const lines = splitLines(text);
  if (!lines.some((l) => l.key === key)) return null;
  const kept = lines.filter((l) => l.key !== key).map((l) => l.raw);
  return kept.length > 0 ? kept.join('\n') + '\n' : '';
}

export function readEnvFile(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_ENV_BYTES) throw new BastionError(`${path.basename(file)} is larger than ${MAX_ENV_BYTES / 1024} KiB`);
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** Replace the env file atomically, mode 0600 from the moment it exists. */
export function writeEnvFile(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** `KEY=value` entries for the Docker API, valid names only. */
export function containerEnv(file: string): string[] {
  return [...parseEnv(readEnvFile(file))].filter(([k]) => ENV_KEY_PATTERN.test(k)).map(([k, v]) => `${k}=${v}`);
}
