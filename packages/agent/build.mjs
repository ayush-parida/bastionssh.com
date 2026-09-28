// Bundle the agent into one dependency-free file that runs on any Node >= 18:
// dist/bastion-agent.cjs is what the app serves to the install script.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/bastion-agent.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  legalComments: 'inline',
  banner: { js: '#!/usr/bin/env node' },
  // Optional native speed-ups that ws loads inside try/catch; absent is fine
  external: ['bufferutil', 'utf-8-validate'],
});
