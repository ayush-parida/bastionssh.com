import { buildSync } from 'esbuild';
import { defineConfig } from 'vitest/config';

// The proxy front's bundled source, as build.mjs puts it into bastionctl (proxy-image.ts)
const front = buildSync({ entryPoints: ['src/front-main.ts'], bundle: true, write: false, platform: 'node', target: 'node22', format: 'esm' });

export default defineConfig({
  define: { BASTION_FRONT_SOURCE: JSON.stringify(front.outputFiles[0]!.text) },
});
