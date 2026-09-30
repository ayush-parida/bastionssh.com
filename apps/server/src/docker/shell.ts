/**
 * Quoting for the few remote commands Docker support runs over SSH (the probe,
 * `docker system dial-stdio`, and later `docker compose`). Every argument is
 * single-quoted, so nothing in it — spaces, `$`, backticks, `;`, newlines —
 * is interpreted by the remote shell. User or daemon input is only ever passed
 * as a separate argument, never spliced into a command string.
 */

/** `it's` → `'it'\''s'`. */
export function shellQuote(arg: string): string {
  if (arg.includes('\0')) throw new Error('Arguments cannot contain NUL bytes');
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A command line from argv, every element quoted. */
export function shellCommand(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}
