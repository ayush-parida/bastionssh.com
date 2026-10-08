import { BUILD_IMAGES, BUN_IMAGE, CADDY_IMAGE, NODE_BUILD_VERSIONS, NODE_IMAGE, nodeBuildImage as sharedNodeBuildImage, pinnedRef } from '@smt/shared/build';
import { BastionError } from './names.js';

/**
 * Every image bastionctl runs or builds from, pinned by digest (deployments
 * spec §8): the list lives in @smt/shared (`src/build/images.json`), shared
 * with BastionSSH's builder so a build on either side uses the same images.
 * The Node.js image bastionctl itself runs in (`node`, filled into the
 * wrapper), Caddy (the proxy, and the server of static sites), Bun (copied
 * into Node build stages for bun projects) and one Node.js build image per
 * supported major version. A tag on the registry can move; a digest cannot,
 * so a build or proxy never changes under a server without a new bastionctl.
 *
 * Updating: `pnpm --filter @smt/bastionctl run update-images` resolves each
 * reference's tag to its current multi-platform digest (docker buildx
 * imagetools), rewrites images.json, and `images.test.ts` checks that every
 * reference stays pinned. Review the diff, run the tests, rebuild; servers
 * then get the new images with their next Reinstall (setup).
 */

export const IMAGES = BUILD_IMAGES;
export { BUN_IMAGE, CADDY_IMAGE, NODE_BUILD_VERSIONS, NODE_IMAGE, pinnedRef };

/** The pinned build image for a Node.js version (`20`, `20.11`, `20.11.1`: its major version picks it). */
export function nodeBuildImage(version: string): string {
  try {
    return sharedNodeBuildImage(version);
  } catch (err) {
    throw new BastionError((err as Error).message);
  }
}
