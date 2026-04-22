import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface XTerminalProps {
  sessionId: string;
  /** Triggered when the WS connection closes */
  onClose?: () => void;
}

export default function XTerminal({ sessionId, onClose }: XTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, Fira Code, Cascadia Code, monospace',
      fontSize: 14,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#0d1117', brightBlack: '#6e7681',
        red: '#ff7b72',   brightRed: '#ffa198',
        green: '#3fb950', brightGreen: '#56d364',
        yellow: '#d29922', brightYellow: '#e3b341',
        blue: '#58a6ff',  brightBlue: '#79c0ff',
        magenta: '#bc8cff', brightMagenta: '#d2a8ff',
        cyan: '#76e3ea',  brightCyan: '#b3f0ff',
        white: '#c9d1d9', brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    const linksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(linksAddon);
    term.open(containerRef.current);
    try { fitAddon.fit(); } catch { /* container may have zero dimensions on first paint */ }

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/api/ssh-sessions/${sessionId}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send initial terminal size — also triggers shell to redraw prompt
      const resize = JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows });
      ws.send(resize);
    };

    ws.binaryType = 'arraybuffer';

    ws.onmessage = (e) => {
      term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
    };

    ws.onclose = () => {
      if (cancelled) return; // StrictMode cleanup — ignore
      term.writeln('\r\n\x1b[33m[Session closed]\x1b[0m');
      onClose?.();
    };

    ws.onerror = () => {
      if (cancelled) return;
      term.writeln('\r\n\x1b[31m[Connection error]\x1b[0m');
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { return; }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, [sessionId, onClose]);

  return <div ref={containerRef} className="size-full" />;
}
