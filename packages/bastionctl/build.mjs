// Bundle bastionctl into one dependency-free ES module (yaml included) and
// write the POSIX wrapper next to it with the pinned Node.js image filled in.
// dist/manifest.json carries the files' SHA-256: BastionSSH ships these
// files, upgrades a server's copy that does not match (unless it is pinned)
// and never runs a bastionctl (or nginx helper) that does not match.
//
// The version is build-aware: `<package version>+<build>`, the build being
// the first 7 hex digits of the bundle hash — SHA-256 over the three files'
// own SHA-256, computed with the build id still a placeholder (it cannot
// hash itself), then written into the program's banner and
// `bastionctl version`. Same sources, same build id.
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

const BUILD_PLACEHOLDER = '@BASTION_BUILD_ID@';
const draftVersion = `${version}+${BUILD_PLACEHOLDER}`;

const program = await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/bastionctl.mjs',
  write: false,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  legalComments: 'inline',
  define: { BASTION_FRONT_SOURCE: JSON.stringify(front.outputFiles[0].text), BASTION_VERSION: JSON.stringify(draftVersion) },
  // Line 2 names the build, where BastionSSH reads which one a server has (deploy/bundle.ts).
  // yaml's Node build is CommonJS and requires Node built-ins; give the bundle a require
  banner: {
    js: `#!/usr/bin/env node\n// bastionctl ${draftVersion}\nimport { createRequire as __bastionRequire } from 'node:module';\nconst require = __bastionRequire(import.meta.url);`,
  },
});

const hash = (data) => createHash('sha256').update(data).digest('hex');
const draft = program.outputFiles[0].text;
const wrapper = readFileSync('wrapper.sh', 'utf8').replace('@NODE_IMAGE@', images.node);
// The nginx-mode helper an administrator installs root-owned (spec §6); shipped as is
const helper = readFileSync('bastion-nginx.sh');

const buildId = hash([hash(draft), hash(wrapper), hash(helper)].join('\n')).slice(0, 7);
const fullVersion = `${version}+${buildId}`;
if (!draft.includes(`// bastionctl ${draftVersion}\n`) || !draft.includes(JSON.stringify(draftVersion))) throw new Error('build.mjs: the version placeholder is missing from the bundle');

writeFileSync('dist/bastionctl.mjs', draft.replaceAll(BUILD_PLACEHOLDER, buildId));
writeFileSync('dist/bastionctl', wrapper, { mode: 0o755 });
writeFileSync('dist/bastion-nginx', helper, { mode: 0o755 });

const sha256 = (file) => hash(readFileSync(file));
writeFileSync(
  'dist/manifest.json',
  JSON.stringify(
    {
      version: fullVersion,
      build: buildId,
      script: { file: 'bastionctl.mjs', sha256: sha256('dist/bastionctl.mjs') },
      wrapper: { file: 'bastionctl', sha256: sha256('dist/bastionctl') },
      nginxHelper: { file: 'bastion-nginx', sha256: sha256('dist/bastion-nginx') },
    },
    null,
    2,
  ) + '\n',
);
