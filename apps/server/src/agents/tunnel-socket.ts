import { Duplex } from 'node:stream';

/** A tunnelled stream failed: the agent is offline, refused the port, or went away. */
export class AgentTunnelError extends Error {
  constructor(
    message: string,
    /** errno-style code, e.g. ECONNREFUSED from the agent's own connect(). */
    readonly code: string = 'EAGENTTUNNEL',
  ) {
    super(message);
    this.name = 'AgentTunnelError';
  }
}

/** What a {@link TunnelSocket} needs from the agent connection carrying it. */
export interface TunnelLink {
  /** Send bytes for this stream; `done` fires once they are handed to the WebSocket. */
  write(data: Buffer, done: (err?: Error | null) => void): void;
  /** Tell the agent this side is finished with the stream. */
  close(): void;
  /** Forget the stream (no frame is sent). */
  release(): void;
}

/** Most bytes kept for a reader that has stopped reading before the stream is cut off. */
const MAX_READ_BUFFER = 16 * 1024 * 1024;

/**
 * A duplex stream over an agent tunnel that stands in for a net.Socket, so
 * ssh2 can be handed it as `sock`. It starts "connecting" (ssh2 then waits for
 * its `connect` event) and is only opened once ssh2 listens for that event —
 * so it cannot emit an error before anything is listening, and a config that
 * is built but never used opens nothing.
 *
 * The agent is untrusted transport: ssh2 still runs the full handshake over
 * this stream, host key verification included.
 */
export class TunnelSocket extends Duplex {
  /** Mirrors net.Socket: true until the agent confirms the stream is open. */
  connecting = true;
  readonly remoteAddress: string;
  readonly remotePort: number;

  private link: TunnelLink | undefined;
  private started = false;
  private remoteEnded = false;
  private pending: { data: Buffer; cb: (err?: Error | null) => void }[] = [];

  constructor(
    /** Starts opening the stream: must eventually call attach(), opened() or fail(). */
    private readonly start: (socket: TunnelSocket) => void,
    label: { agentId: string; port: number },
  ) {
    super({ allowHalfOpen: false });
    this.remoteAddress = `agent:${label.agentId}`;
    this.remotePort = label.port;
    this.on('newListener', this.onNewListener);
  }

  private onNewListener = (event: string | symbol) => {
    if (event !== 'connect' || this.started) return;
    this.started = true;
    this.off('newListener', this.onNewListener);
    // After ssh2 has attached its other listeners (error, close…)
    process.nextTick(() => {
      if (!this.destroyed) this.start(this);
    });
  };

  /** Open it now rather than waiting for a `connect` listener. */
  open(): this {
    if (!this.started) this.onNewListener('connect');
    return this;
  }

  // ── Called by the agent connection ─────────────────────────────────────────

  attach(link: TunnelLink) {
    this.link = link;
  }

  opened() {
    if (!this.connecting || this.destroyed) return;
    this.connecting = false;
    for (const { data, cb } of this.pending.splice(0)) this.link!.write(data, cb);
    this.emit('connect');
  }

  receive(data: Buffer) {
    if (this.destroyed || this.remoteEnded) return;
    if (this.readableLength > MAX_READ_BUFFER) {
      // Not the agent's doing: tell it to drop the stream too
      this.destroy(new AgentTunnelError('Tunnel reader stopped reading', 'EOVERFLOW'));
      return;
    }
    this.push(data);
  }

  /** The agent closed the stream: end the readable side; the writable side follows. */
  remoteClose() {
    if (this.remoteEnded) return;
    this.remoteEnded = true;
    this.link?.release();
    this.push(null);
  }

  /** The stream failed on the agent's side, or the agent went away; nothing is sent back. */
  fail(err: Error) {
    this.remoteEnded = true;
    this.link?.release();
    this.destroy(err);
  }

  // ── Duplex ────────────────────────────────────────────────────────────────

  override _read() {
    // Data is pushed as frames arrive; the tunnel has no per-stream window
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
    if (this.connecting || !this.link) {
      this.pending.push({ data: chunk, cb });
      return;
    }
    this.link.write(chunk, cb);
  }

  override _final(cb: (err?: Error | null) => void) {
    // CLOSE ends the whole stream (the tunnel has no half-close) and the agent
    // does not answer it, so the readable side ends here too — otherwise
    // 'close' would never fire and ssh2 would wait for it forever.
    if (!this.remoteEnded) {
      this.remoteEnded = true;
      this.link?.close();
      this.push(null);
    }
    cb();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void) {
    this.off('newListener', this.onNewListener);
    if (!this.remoteEnded) {
      this.remoteEnded = true;
      this.link?.close();
    }
    const failed = err ?? new AgentTunnelError('Tunnel closed');
    for (const { cb: pendingCb } of this.pending.splice(0)) pendingCb(failed);
    cb(err);
  }

  // net.Socket methods ssh2 (or a caller) may use; meaningless over a tunnel
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  setTimeout() {
    return this;
  }
}
