// Re-pin every quick-service image in src/services/images.json (services
// spec §3.1). Each entry follows a moving `track` tag of its line
// (`postgres:17-alpine`); the script resolves the tag to its current
// multi-platform index digest with `docker buildx imagetools inspect`,
// checks that linux/amd64 and linux/arm64 are both in it, then names the
// exact release that digest is (`postgres:17.6-alpine`) from the most
// specific tag on Docker Hub pointing at the same digest — the reference
// written is `postgres:17.6-alpine@sha256:…`. A line whose track moved to
// another major (an entry's `match` no longer matches any tag of the digest)
// stops the script: the catalog needs a reviewed change, not a re-pin.
//
// Review the diff, run `pnpm --filter @smt/bastionctl test` (catalog.test.ts
// checks every reference is digest-pinned and every template still makes a
// valid bastion.yml) and rebuild; servers get the new images when a service
// is updated (Update version) or created. Needs Docker with buildx and
// network access. Docker Hub limits anonymous manifest requests; when
// buildx is refused (429) the digest is read from Docker Hub's tag API
// instead and the script says so.
//
// Entries marked `"community": true` (MinIO: pgsty/minio, a third-party
// rebuild — MinIO no longer publishes images) are left out unless named on
// the command line: one publisher's account is all that stands between a
// re-pin and every server that updates. Re-pin them on purpose, and check
// the provenance of the new digest first (`docker buildx imagetools inspect
// <ref> --format '{{json .Provenance}}'`: its source revision on GitHub).
//
//   pnpm --filter @smt/shared run update-service-images [id …]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../src/services/images.json', import.meta.url);
const pins = JSON.parse(readFileSync(FILE, 'utf8'));
const only = new Set(process.argv.slice(2));
const PLATFORMS = ['linux/amd64', 'linux/arm64'];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `valkey/valkey:9-alpine` → { namespace: 'valkey', repo: 'valkey', tag: '9-alpine' }; Docker Hub only (no registry host). */
function parseRef(ref) {
  const at = ref.lastIndexOf(':');
  const path = ref.slice(0, at);
  if (path.split('/')[0].includes('.')) throw new Error(`${ref}: only Docker Hub images are supported`);
  const [namespace, repo] = path.includes('/') ? path.split('/') : ['library', path];
  return { path, namespace, repo, tag: ref.slice(at + 1) };
}

async function hub(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** The tag's index digest and platforms: buildx first, Docker Hub's API when the registry refuses. */
async function resolve(ref) {
  try {
    const out = execFileSync('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const manifest = JSON.parse(out);
    const platforms = (manifest.manifests ?? []).map((m) => `${m.platform?.os}/${m.platform?.architecture}`);
    return { digest: manifest.digest, platforms, via: 'buildx' };
  } catch (err) {
    const why = String(err.stderr ?? err.message).trim().split('\n').pop();
    const { namespace, repo, tag } = parseRef(ref);
    const info = await hub(`https://hub.docker.com/v2/namespaces/${namespace}/repositories/${repo}/tags/${encodeURIComponent(tag)}`);
    console.warn(`  buildx could not read ${ref} (${why}); using Docker Hub's tag API`);
    return { digest: info.digest, platforms: (info.images ?? []).map((i) => `${i.os}/${i.architecture}`), via: 'hub' };
  }
}

/** The most specific tag pointing at `digest` that `match` accepts. */
async function exactTag(ref, digest, major, match) {
  const { namespace, repo } = parseRef(ref);
  const filter = major.replace(/^v/, '');
  const page = await hub(`https://hub.docker.com/v2/namespaces/${namespace}/repositories/${repo}/tags?page_size=100&name=${encodeURIComponent(filter)}`);
  const tags = (page.results ?? []).filter((t) => t.digest === digest && match.test(t.name)).map((t) => t.name);
  tags.sort((a, b) => b.length - a.length || b.localeCompare(a));
  return tags[0] ?? null;
}

let changed = 0;
for (const [id, lines] of Object.entries(pins)) {
  if (only.size > 0 && !only.has(id)) continue;
  for (const [major, entry] of Object.entries(lines)) {
    if (entry.community && !only.has(id)) {
      console.log(`skipped ${id} ${major}: a community image, re-pinned only when named (update-service-images ${id})`);
      continue;
    }
    if (entry.community) console.warn(`  ${id} is a community image (${entry.track}): check the new digest's provenance before committing`);
    const { path, tag } = parseRef(entry.track);
    // The track's own suffix (`-alpine`, `-management-alpine`) follows the version in the exact tag
    const suffix = tag.replace(/^v?\d+(\.\d+)*/, '');
    const match = new RegExp(entry.match ?? `^${escape(major)}(\\.\\d+)*${escape(suffix)}$`);
    const { digest, platforms, via } = await resolve(entry.track);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new Error(`No digest for ${entry.track}`);
    const missing = PLATFORMS.filter((p) => !platforms.includes(p));
    if (missing.length > 0) throw new Error(`${entry.track} (${digest}) has no ${missing.join(', ')} image`);
    const exact = await exactTag(entry.track, digest, major, match);
    if (!exact) throw new Error(`${id} ${major}: no tag matching ${match} points at ${digest} (${entry.track}); has the line moved to another major? Edit images.json and the catalog.`);
    const image = `${path}:${exact}@${digest}`;
    const version = exact.slice(0, exact.length - (entry.match ? 0 : suffix.length));
    if (image === entry.image && version === entry.version) {
      console.log(`unchanged ${id} ${major}: ${exact}`);
      continue;
    }
    console.log(`${id} ${major}: ${entry.image || '(none)'} -> ${image}${via === 'hub' ? ' (digest from Docker Hub)' : ''}`);
    Object.assign(entry, { image, version });
    changed++;
  }
}
writeFileSync(FILE, JSON.stringify(pins, null, 2) + '\n');
console.log(changed ? `${changed} image${changed === 1 ? '' : 's'} re-pinned` : 'Every image is current');
