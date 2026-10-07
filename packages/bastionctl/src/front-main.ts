import { FRONT_CONTROL, requestReload, serveControl, startFront, type ListenKind } from './front.js';

// The proxy container's entry point (bundled into the bastion-proxy image, see proxy-image.ts):
//   run                                own the public ports and serve through Caddy (the default)
//   reload [--sha256 <hex>] [--caddy <path>] [names…]
//                                      switch to a new Caddy with the config file (bastionctl runs it with docker exec)
const [command = 'run', ...args] = process.argv.slice(2);
const env = process.env;
const control = env.BASTION_PROXY_CONTROL || FRONT_CONTROL;

if (command === 'reload') {
  // [--sha256 <hex>] [--caddy <path>] in any order, then the names to check
  const flags = new Map<string, string>();
  let rest = args;
  while ((rest[0] === '--sha256' || rest[0] === '--caddy') && rest[1] !== undefined) {
    flags.set(rest[0], rest[1]);
    rest = rest.slice(2);
  }
  process.exitCode = await requestReload(
    control,
    rest,
    {
      log: (line) => process.stderr.write(`${line}\n`),
      error: (line) => process.stderr.write(`${line}\n`),
    },
    flags.get('--sha256'),
    flags.get('--caddy'),
  );
} else if (command === 'run') {
  // `80:http,443:https`
  const listen = (env.BASTION_PROXY_LISTEN || '80:http,443:https').split(',').map((entry) => {
    const [port, kind] = entry.split(':');
    if (!port || !/^\d{1,5}$/.test(port) || (kind !== 'http' && kind !== 'https')) throw new Error(`Bad BASTION_PROXY_LISTEN entry ${entry}`);
    return { port: Number(port), kind: kind as ListenKind };
  });
  const front = await startFront({
    config: env.BASTION_PROXY_CONFIG || '/bastion-proxy/Caddyfile',
    listen,
    control,
    caddy: env.BASTION_CADDY || 'caddy',
    drainMs: env.BASTION_PROXY_DRAIN_MS ? Number(env.BASTION_PROXY_DRAIN_MS) : undefined,
    onFatal: (message) => {
      process.stderr.write(`bastion-proxy: ${message}\n`);
      process.exit(1);
    },
  });
  serveControl(front, control);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void front.stop().then(() => process.exit(0));
    });
  }
} else {
  process.stderr.write('Usage: bastion-proxy [run | reload [names…]]\n');
  process.exitCode = 2;
}
