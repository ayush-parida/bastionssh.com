import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Ctx } from './context.js';
import { CADDY_IMAGE, IMAGES, NODE_IMAGE } from './images.js';
import { LABEL_MANAGED } from './names.js';
import { tarBuffer } from './tar.js';

/**
 * The proxy container's image, built on the server by setup from two pinned
 * images: Node.js (the one bastionctl runs in) for the front (front.ts), and
 * Caddy's binary copied from the pinned Caddy image. Its tag is a hash of
 * what goes into it, so a bastionctl with another front or other images
 * builds (and setup switches to) a new one.
 */

// Filled in by build.mjs (and vitest.config.ts) with the bundled front-main.ts
declare const BASTION_FRONT_SOURCE: string;

/** Where the front lives in the image; bastionctl runs `node <this> reload` in the container. */
export const FRONT_PATH = '/usr/local/lib/bastion-proxy.mjs';
const LABEL_PROXY_IMAGE = 'bastion.proxy-image';

export function frontSource(): string {
  return typeof BASTION_FRONT_SOURCE === 'string' ? BASTION_FRONT_SOURCE : '';
}

export function proxyDockerfile(): string {
  return [
    `FROM ${NODE_IMAGE}`,
    `COPY --from=${CADDY_IMAGE} /usr/bin/caddy /usr/bin/caddy`,
    `COPY bastion-proxy.mjs ${FRONT_PATH}`,
    // Caddy's image keeps its state here; <root>/proxy/data and config are mounted on them
    'ENV XDG_CONFIG_HOME=/config XDG_DATA_HOME=/data',
    `ENTRYPOINT ["node", "${FRONT_PATH}"]`,
    'CMD ["run"]',
    '',
  ].join('\n');
}

/** `bastion-proxy:<hash>` of the Dockerfile, the front and the pinned images. */
export const PROXY_IMAGE = `bastion-proxy:${createHash('sha256')
  .update(JSON.stringify([proxyDockerfile(), frontSource(), IMAGES.node, IMAGES.caddy]))
  .digest('hex')
  .slice(0, 16)}`;

/** Build the proxy image unless the server has it. */
export async function ensureProxyImage(ctx: Pick<Ctx, 'docker' | 'log'>): Promise<void> {
  const { docker } = ctx;
  if (!(await docker.imageExists(PROXY_IMAGE))) {
    if (!frontSource()) throw new Error('This bastionctl was built without the proxy front');
    for (const [name, ref] of [
      ['node', IMAGES.node],
      ['caddy', IMAGES.caddy],
    ] as const) {
      const pinned = name === 'node' ? NODE_IMAGE : CADDY_IMAGE;
      if (await docker.imageExists(pinned)) continue;
      ctx.log(`Pulling ${ref}`);
      await docker.pull(ref, (line) => ctx.log(line));
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
