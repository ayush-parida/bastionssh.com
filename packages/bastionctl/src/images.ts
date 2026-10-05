import images from './images.json' with { type: 'json' };
import { BastionError } from './names.js';

/**
 * Every image bastionctl runs or builds from, pinned by digest in
 * images.json (deployments spec §8): the Node.js image bastionctl itself
 * runs in (`node`, filled into the wrapper), Caddy (the proxy, and the
 * server of static sites), Bun (copied into Node build stages for bun
 * projects) and one Node.js build image per supported major version. A tag
 * on the registry can move; a digest cannot, so a build or proxy never
 * changes under a server without a new bastionctl.
 *
 * Updating: `pnpm --filter @smt/bastionctl run update-images` resolves each
 * reference's tag to its current multi-platform digest (docker buildx
 * imagetools), rewrites images.json, and `images.test.ts` checks that every
 * reference stays pinned. Review the diff, run the tests, rebuild; servers
 * then get the new images with their next Reinstall (setup).
 */

export const IMAGES = images;

/** `repo:tag@sha256:…` → `repo@sha256:…`, the form the Engine API and Dockerfiles take. */
export function pinnedRef(ref: string): string {
  return ref.replace(/:[^/@]*@/, '@');
}

export const CADDY_IMAGE = pinnedRef(images.caddy);
export const NODE_IMAGE = pinnedRef(images.node);
export const BUN_IMAGE = pinnedRef(images.bun);

/** Node.js major versions a nextjs or static build can use. */
export const NODE_BUILD_VERSIONS: readonly string[] = Object.keys(images.build).sort((a, b) => Number(a) - Number(b));

/** The pinned build image for a Node.js version (`20`, `20.11`, `20.11.1`: its major version picks it). */
export function nodeBuildImage(version: string): string {
  const major = /^(\d+)/.exec(version)?.[1] ?? '';
  const ref = (images.build as Record<string, string>)[major];
  if (!ref) throw new BastionError(`Node.js ${version} is not available for builds; use one of ${NODE_BUILD_VERSIONS.join(', ')}`);
  return pinnedRef(ref);
}
