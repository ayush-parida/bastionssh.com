// Runs the built server (apps/server/dist) against a throwaway SQLite database,
// serving the built web app (apps/web/dist) from the same origin. Playwright
// starts this as its webServer and passes the SMT_* environment; the temp
// directory is removed when the server exits.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const serverDist = path.join(root, 'apps/server/dist');
const webDist = path.join(root, 'apps/web/dist');

for (const [what, file] of [
  ['server', path.join(serverDist, 'index.js')],
  ['web app', path.join(webDist, 'index.html')],
]) {
  if (!fs.existsSync(file)) {
    console.error(`[e2e] The ${what} is not built (${path.relative(root, file)} is missing). Run \`pnpm test:e2e\` from the repo root, or \`pnpm build\` first.`);
    process.exit(1);
  }
}

// tsc does not copy the SQL migrations; the Docker image copies them the same way
fs.cpSync(path.join(root, 'apps/server/src/db/migrations'), path.join(serverDist, 'db/migrations'), {
  recursive: true,
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-e2e-'));
const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

const child = spawn(process.execPath, [path.join(serverDist, 'index.js')], {
  cwd: path.join(root, 'apps/server'),
  env: {
    ...process.env,
    SMT_DB_URL: path.join(tmp, 'smt.db'),
    // Terminal recordings default to /data/recordings; keep them with the throwaway database
    SMT_RECORDINGS_DIR: path.join(tmp, 'recordings'),
    SMT_STATIC_DIR: webDist,
  },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 0 : 1));
});
