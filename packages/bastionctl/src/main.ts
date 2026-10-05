import { readProcessStdin, run } from './cli.js';

// The bundled entry point (dist/bastionctl.mjs), run by the bastionctl wrapper inside node:22-alpine
const code = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin: readProcessStdin,
});
process.exitCode = code;
