/**
 * Kubernetes resource quantities (`250m`, `1.5`, `128Mi`, `1G`, `1e3`) as
 * plain numbers: CPU in millicores, everything else in base units (bytes).
 * Anything unreadable counts as 0 rather than failing a whole view.
 */

const BINARY: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

const DECIMAL: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

const PATTERN = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E))?$/;

/** A quantity in base units (`128Mi` → 134217728, `250m` → 0.25). */
export function parseQuantity(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const match = PATTERN.exec(value.trim());
  if (!match) return 0;
  const base = Number(match[1]);
  if (match[2]) return base * 10 ** Number(match[2].slice(1));
  const suffix = match[3] ?? '';
  return base * (BINARY[suffix] ?? DECIMAL[suffix] ?? 1);
}

/** CPU in millicores (`250m` → 250, `2` → 2000). */
export function cpuMillis(value: unknown): number {
  return Math.round(parseQuantity(value) * 1000);
}

/** Memory (or storage) in bytes. */
export function bytes(value: unknown): number {
  return Math.round(parseQuantity(value));
}
