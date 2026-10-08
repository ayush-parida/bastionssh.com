/**
 * Archive entry names. Every name is built from the walker's segments,
 * relative to the chosen folder, so nothing can be absolute or climb out
 * with `..`; separators, backslashes (a separator to Windows extractors) and
 * control characters inside a segment become `_`.
 */

/** A safe archive path segment, or null when the name cannot be kept (empty, `.`, `..`). */
export function sanitizeSegment(name: string): string | null {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_');
  if (clean === '' || clean === '.' || clean === '..') return null;
  return clean;
}

/**
 * Hands out archive paths, suffixing ` (2)`, ` (3)`… when two source names
 * sanitise to the same path (`a\b` and `a_b`), or a real file takes the name
 * of a note such as `_skipped.txt`.
 */
export class NameRegistry {
  private readonly used = new Set<string>();

  /** `dir` is '' or ends with '/'. Directories come back with a trailing '/'. */
  claim(dir: string, segment: string, isDir: boolean): string {
    const dot = isDir ? -1 : segment.lastIndexOf('.');
    const stem = dot > 0 ? segment.slice(0, dot) : segment;
    const ext = dot > 0 ? segment.slice(dot) : '';
    for (let n = 1; ; n++) {
      const candidate = dir + (n === 1 ? segment : `${stem} (${n})${ext}`) + (isDir ? '/' : '');
      const key = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
      if (!this.used.has(key)) {
        this.used.add(key);
        return candidate;
      }
    }
  }
}

/** `attachment` Content-Disposition with an ASCII fallback and the RFC 5987 UTF-8 name. */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
