import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PROXY_MOUNT } from './caddy.js';
import type { Ctx } from './context.js';
import { CADDY_IMAGE, IMAGES, NODE_IMAGE } from './images.js';
import { BastionError, LABEL_MANAGED } from './names.js';
import { tarBuffer } from './tar.js';

/**
 * The proxy container's image, built on the server by setup from the pinned
 * Node.js image (the one bastionctl runs in) with the front (front.ts). Its
 * tag is a hash of what goes into it, so a bastionctl with another front or
 * Node.js image builds (and switches to) a new one.
 *
 * Caddy is not in the image: its binary is copied out of the pinned Caddy
 * image into `<root>/proxy/caddy/<id>/caddy`, and the front starts every
 * Caddy through the link `<root>/proxy/caddy/caddy`. A bastionctl with a new
 * Caddy moves the link and has the front start a new Caddy generation behind
 * the ports it keeps — no connection is dropped and the container stays
 * (proxy-upgrade.ts).
 */

// Filled in by build.mjs (and vitest.config.ts) with the bundled front-main.ts
declare const BASTION_FRONT_SOURCE: string;

/** Where the front lives in the image; bastionctl runs `node <this> reload` in the container. */
export const FRONT_PATH = '/usr/local/lib/bastion-proxy.mjs';
const LABEL_PROXY_IMAGE = 'bastion.proxy-image';

export function frontSource(): string {
  return typeof BASTION_FRONT_SOURCE === 'string' ? BASTION_FRONT_SOURCE : '';
}

/** The link to the Caddy binary a starting proxy front runs, as the proxy container sees it. */
export const CADDY_PATH = `${PROXY_MOUNT}/caddy/caddy`;

/**
 * Caddy `id`'s binary as the proxy container sees it. bastionctl names it
 * explicitly when it validates a config and when it has the front start a
 * generation (`reload --caddy`): the generation runs exactly the binary that
 * validated, however late a mount shows the moved link.
 */
export const caddyBinary = (id: string) => `${PROXY_MOUNT}/caddy/${id}/caddy`;

export function proxyDockerfile(): string {
  return [
    `FROM ${NODE_IMAGE}`,
    `COPY bastion-proxy.mjs ${FRONT_PATH}`,
    // Caddy keeps its state here (<root>/proxy/data and config are mounted on them); its binary comes from the mount
    `ENV XDG_CONFIG_HOME=/config XDG_DATA_HOME=/data BASTION_CADDY=${CADDY_PATH}`,
    `ENTRYPOINT ["node", "${FRONT_PATH}"]`,
    'CMD ["run"]',
    '',
  ].join('\n');
}

/** `bastion-proxy:<hash>` of the Dockerfile, the front and the pinned Node.js image — not Caddy, which is replaced behind the front. */
export const PROXY_IMAGE = `bastion-proxy:${createHash('sha256')
  .update(JSON.stringify([proxyDockerfile(), frontSource(), IMAGES.node]))
  .digest('hex')
  .slice(0, 16)}`;

/** The pinned Caddy's id: the first 16 hex digits of its image digest (`<root>/proxy/caddy/<id>/`). */
export const CADDY_ID = /@sha256:([a-f0-9]{16})/.exec(IMAGES.caddy)?.[1] ?? createHash('sha256').update(IMAGES.caddy).digest('hex').slice(0, 16);

const CADDY_ID_PATTERN = /^[a-f0-9]{16}$/;

/** `<root>/proxy/caddy`, where Caddy binaries and the link live. */
export function caddyDir(ctx: Pick<Ctx, 'layout'>): string {
  return path.join(ctx.layout.proxy, 'caddy');
}

/** The Caddy id the link points at, or null (no link yet, or not one of ours). */
export function linkedCaddy(ctx: Pick<Ctx, 'layout'>): string | null {
  try {
    const m = /^([a-f0-9]{16})\/caddy$/.exec(fs.readlinkSync(path.join(caddyDir(ctx), 'caddy')));
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Point the link at Caddy `id` (atomically: a new link renamed over the old one). */
export function linkCaddy(ctx: Pick<Ctx, 'layout'>, id: string): void {
  if (!CADDY_ID_PATTERN.test(id)) throw new BastionError(`Invalid Caddy id ${id}`);
  const dir = caddyDir(ctx);
  const tmp = path.join(dir, `.caddy.${randomBytes(4).toString('hex')}`);
  fs.symlinkSync(`${id}/caddy`, tmp);
  fs.renameSync(tmp, path.join(dir, 'caddy'));
}

/** Byte offset and size of the first regular file in a tar file. */
function firstTarFile(file: string): { offset: number; size: number } | null {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(512);
    let pos = 0;
    for (;;) {
      if (fs.readSync(fd, header, 0, 512, pos) < 512 || header.every((b) => b === 0)) return null;
      const size = parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8);
      const type = String.fromCharCode(header[156]!);
      pos += 512;
      if (type === '0' || type === '\0') return { offset: pos, size };
      // pax and GNU long-name headers, folders: skip to the next header
      pos += Math.ceil(size / 512) * 512;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copy the pinned Caddy's binary out of its image into
 * `<root>/proxy/caddy/<id>/caddy`, unless it is there: a container is
 * created from the image (never started), its `/usr/bin/caddy` read through
 * the Engine API's archive endpoint, and the container removed.
 */
export async function ensureCaddyBinary(ctx: Pick<Ctx, 'layout' | 'docker' | 'log'>): Promise<string> {
  const dir = path.join(caddyDir(ctx), CADDY_ID);
  const binary = path.join(dir, 'caddy');
  if (fs.existsSync(binary)) return binary;
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (!(await ctx.docker.imageExists(CADDY_IMAGE))) {
    ctx.log(`Pulling ${IMAGES.caddy}`);
    await ctx.docker.pull(IMAGES.caddy, (line) => ctx.log(line));
  }
  const name = `bastion-caddy-copy-${randomBytes(4).toString('hex')}`;
  const archive = path.join(dir, '.caddy.tar');
  ctx.log(`Copying Caddy ${CADDY_ID} out of ${CADDY_IMAGE}`);
  await ctx.docker.createContainer(name, { Image: CADDY_IMAGE, Labels: { [LABEL_MANAGED]: 'caddy-copy' }, Cmd: ['caddy', 'version'] });
  try {
    await ctx.docker.copyFrom(name, '/usr/bin/caddy', archive);
    const entry = firstTarFile(archive);
    if (!entry || entry.size === 0) throw new BastionError(`No Caddy binary in ${CADDY_IMAGE}`);
    const tmp = `${binary}.tmp`;
    const from = fs.openSync(archive, 'r');
    const to = fs.openSync(tmp, 'w', 0o755);
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      for (let done = 0; done < entry.size; ) {
        const n = fs.readSync(from, chunk, 0, Math.min(chunk.length, entry.size - done), entry.offset + done);
        if (n <= 0) throw new BastionError('The Caddy binary was cut short');
        fs.writeSync(to, chunk, 0, n);
        done += n;
      }
    } finally {
      fs.closeSync(from);
      fs.closeSync(to);
    }
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, binary);
  } finally {
    fs.rmSync(archive, { force: true });
    await ctx.docker.remove(name).catch(() => {});
  }
  return binary;
}

/** Remove Caddy binaries other than `keep` (the linked one and the one an older generation may still run). */
export function pruneCaddyBinaries(ctx: Pick<Ctx, 'layout'>, keep: Array<string | null>): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(caddyDir(ctx));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!CADDY_ID_PATTERN.test(entry) || keep.includes(entry)) continue;
    fs.rmSync(path.join(caddyDir(ctx), entry), { recursive: true, force: true });
  }
}

/** Build the proxy image unless the server has it. */
export async function ensureProxyImage(ctx: Pick<Ctx, 'docker' | 'log'>): Promise<void> {
  const { docker } = ctx;
  if (!(await docker.imageExists(PROXY_IMAGE))) {
    if (!frontSource()) throw new Error('This bastionctl was built without the proxy front');
    if (!(await docker.imageExists(NODE_IMAGE))) {
      ctx.log(`Pulling ${IMAGES.node}`);
      await docker.pull(IMAGES.node, (line) => ctx.log(line));
    }
    ctx.log(`Building the proxy image ${PROXY_IMAGE}`);
    const context = tarBuffer([
      { name: 'Dockerfile', content: proxyDockerfile() },
      { name: 'bastion-proxy.mjs', content: frontSource() },
    ]);
    await docker.build(
      Readable.from([context]),
      { t: PROXY_IMAGE, labels: JSON.stringify({ [LABEL_MANAGED]: 'proxy-image', [LABEL_PROXY_IMAGE]: '1' }), rm: true, forcerm: true, pull: false },
      (line) => ctx.log(line),
    );
  }
}

/** Remove bastion-proxy images of other bastionctl versions (one a container still uses stays). */
export async function pruneProxyImages(ctx: Pick<Ctx, 'docker'>): Promise<void> {
  const { docker } = ctx;
  for (const image of await docker.listImages([`${LABEL_PROXY_IMAGE}=1`])) {
    if ((image.RepoTags ?? []).includes(PROXY_IMAGE)) continue;
    await docker.removeImage(image.Id).catch(() => {});
  }
}
