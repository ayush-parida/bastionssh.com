import {
  checkSource as sharedCheckSource,
  DeployBuildError,
  detectPackageManager,
  GENERATED_DOCKERFILE,
  nextjsDockerfile as sharedNextjsDockerfile,
  nodeVersion,
  planBuild as sharedPlanBuild,
  sourceView,
  staticDockerfile as sharedStaticDockerfile,
  type BuildPlan,
  type PackageManager,
} from '@smt/shared/build';
import type { DeployAppConfig } from '@smt/shared';
import { BastionError } from './names.js';

/**
 * How an app's image is built (deployments spec §5 step 3): nextjs (a
 * generated multi-stage Dockerfile from Next's standalone output), the
 * project's own Dockerfile, or a static site served by Caddy. The generators
 * live in @smt/shared (`src/build/dockerfiles.ts`), shared with BastionSSH's
 * builder for `build.where: bastion`, so the same upload gives the same
 * image on either side; here their refusals become bastionctl errors.
 */

export { detectPackageManager, GENERATED_DOCKERFILE, nodeVersion, sourceView, type BuildPlan, type PackageManager };

/** Run `fn`, reporting a shared build refusal as a bastionctl error (exit 1). */
export function asBastion<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DeployBuildError) throw new BastionError(err.message);
    throw err;
  }
}

export function nextjsDockerfile(dir: string, config: Pick<DeployAppConfig, 'build' | 'run'>, args: readonly string[] = []): string {
  return asBastion(() => sharedNextjsDockerfile(dir, config, args));
}

export function staticDockerfile(dir: string, config: Pick<DeployAppConfig, 'build'>, args: readonly string[] = []): string {
  return asBastion(() => sharedStaticDockerfile(dir, config, args));
}

/**
 * Refuse an upload that cannot build as configured, with what to do instead
 * (a static site's `.next` folder, a package.json without a build script, a
 * missing output folder…). The browser runs the same check before uploading.
 */
export function checkSource(extracted: string, config: Pick<DeployAppConfig, 'build'>): void {
  asBastion(() => sharedCheckSource(extracted, config));
}

/** Work out how to build the extracted upload at `extracted`; `args` are the names of the build args it gets. */
export function planBuild(extracted: string, config: Pick<DeployAppConfig, 'build' | 'run'>, args: readonly string[] = []): BuildPlan {
  return asBastion(() => sharedPlanBuild(extracted, config, args));
}
