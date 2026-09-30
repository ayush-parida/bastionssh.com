/**
 * Environment variables are where containers keep their secrets (database
 * passwords, API tokens), so inspect payloads never leave the server with
 * their values: `KEY=value` becomes `KEY=••••`. Names stay, so it is still
 * clear what is set. Labels are shown as they are. Only an admin's explicit,
 * audited reveal returns the real values.
 */

export const REDACTED = '••••';

/** `['A=1', 'B=', 'C']` → `['A=••••', 'B=••••', 'C']`. An entry without `=` has no value to hide. */
export function redactEnv(env: unknown): unknown {
  if (!Array.isArray(env)) return env;
  return env.map((entry) => {
    if (typeof entry !== 'string') return REDACTED;
    const eq = entry.indexOf('=');
    return eq === -1 ? entry : `${entry.slice(0, eq)}=${REDACTED}`;
  });
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A copy of `section` with its `Env` redacted; anything else is returned as it is. */
function redactSection(section: unknown): unknown {
  if (!isObject(section) || !('Env' in section)) return section;
  return { ...section, Env: redactEnv(section.Env) };
}

/**
 * A container's or image's inspect payload with every `Env` it carries
 * redacted: `Config.Env` on both, and `ContainerConfig.Env` on images built
 * by older engines. Returns a new object; the input is not modified.
 */
export function redactInspect<T>(payload: T): T {
  if (!isObject(payload)) return payload;
  const out: Json = { ...payload };
  if ('Config' in out) out.Config = redactSection(out.Config);
  if ('ContainerConfig' in out) out.ContainerConfig = redactSection(out.ContainerConfig);
  return out as T;
}
