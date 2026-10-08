// Re-pin every image in ../shared/src/build/images.json (deployments spec §8): each reference's
// tag is resolved to its current multi-platform digest with
// `docker buildx imagetools inspect`, and the file is rewritten. Review the
// diff, run `pnpm --filter @smt/bastionctl test` (images.test.ts checks that
// every reference stays pinned) and rebuild; servers get the new images with
// their next Reinstall. Needs Docker with buildx and network access.
//
//   pnpm --filter @smt/bastionctl run update-images
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../shared/src/build/images.json', import.meta.url);
const images = JSON.parse(readFileSync(FILE, 'utf8'));

function repin(ref) {
  const tagged = ref.split('@')[0];
  const out = execFileSync('docker', ['buildx', 'imagetools', 'inspect', tagged, '--format', '{{json .Manifest}}'], { encoding: 'utf8' });
  const digest = JSON.parse(out).digest;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`No digest for ${tagged}: ${out}`);
  const next = `${tagged}@${digest}`;
  console.log(next === ref ? `unchanged ${tagged}` : `${tagged}: ${ref.split('@')[1] ?? '(none)'} -> ${digest}`);
  return next;
}

function walk(value) {
  if (typeof value === 'string') return repin(value);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
}

writeFileSync(FILE, JSON.stringify(walk(images), null, 2) + '\n');
