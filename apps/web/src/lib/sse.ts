/**
 * Read a `text/event-stream` response body and yield each event's parsed JSON
 * `data` payload.
 *
 * Network reads do not line up with event boundaries, so text is buffered until
 * a blank line completes an event, and the decoder runs in streaming mode so a
 * multi-byte character split across reads is not mangled. Events whose data is
 * not valid JSON are skipped. Breaking out of the loop cancels the body.
 */
export async function* readSSE<T>(res: Response): AsyncGenerator<T> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEvent<T>(block);
        if (event !== undefined) yield event;
      }

      if (done) {
        // A final event the server did not terminate with a blank line.
        const event = parseEvent<T>(buffer);
        if (event !== undefined) yield event;
        return;
      }
    }
  } finally {
    // Releases the connection when the consumer stops early (done/error/abort).
    reader.cancel().catch(() => {});
  }
}

function parseEvent<T>(block: string): T | undefined {
  const data = block
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
    .join('\n');
  if (!data) return undefined;
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}
