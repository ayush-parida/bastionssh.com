// Bundle bastionctl into one dependency-free ES module (yaml included) and
// write the POSIX wrapper next to it with the pinned Node.js image filled in.
// dist/manifest.json carries the files' SHA-256: BastionSSH ships these
// files and refuses to run a bastionctl (or nginx helper) on a server that
// does not match.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const images = JSON.parse(readFileSync('src/images.json', 'utf8'));
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

mkdirSync('dist', { recursive: true });

// The proxy front (src/front-main.ts) goes into the proxy image setup builds; bastionctl carries its source
const front = await build({
  entryPoints: ['src/front-main.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  legalComments: 'none',
});

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/bastionctl.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  legalComments: 'inline',
  define: { BASTION_FRONT_SOURCE: JSON.stringify(front.outputFiles[0].text) },
  // yaml's Node build is CommonJS and requires Node built-ins; give the bundle a require
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __bastionRequire } from 'node:module';\nconst require = __bastionRequire(import.meta.url);" },
});

const wrapper = readFileSync('wrapper.sh', 'utf8').replace('@NODE_IMAGE@', images.node);
writeFileSync('dist/bastionctl', wrapper, { mode: 0o755 });

// The nginx-mode helper an administrator installs root-owned (spec §6); shipped as is
writeFileSync('dist/bastion-nginx', readFileSync('bastion-nginx.sh'), { mode: 0o755 });

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync(
  'dist/manifest.json',
  JSON.stringify(
    {
      version,
      script: { file: 'bastionctl.mjs', sha256: sha256('dist/bastionctl.mjs') },
      wrapper: { file: 'bastionctl', sha256: sha256('dist/bastionctl') },
      nginxHelper: { file: 'bastion-nginx', sha256: sha256('dist/bastion-nginx') },
    },
    null,
    2,
  ) + '\n',
);
