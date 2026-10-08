import { kernelAtLeast, serviceKernelRefusal, serviceKernelRuleOfImage, serviceTemplate, type DeployAppConfig } from '@smt/shared';
import type { Ctx } from './context.js';
import { BastionError } from './names.js';

/**
 * Lines that will not start on the host's kernel (services spec §3.1, the
 * catalog's `kernelIncompatibility`): MongoDB 8 refuses kernels it reads as
 * 6.19 or newer. A deploy, Update version (set-image) or rollback to such a
 * line is refused before anything is pulled or changed, rather than pulling
 * hundreds of megabytes to watch the container exit. A kernel that cannot be
 * read is no reason to refuse: the check is skipped, with a warning.
 */

/** The host's kernel release as Docker reports it (`7.0.0-1012-aws`), or null when it cannot be read. */
export async function hostKernel(ctx: Pick<Ctx, 'docker' | 'log'>): Promise<string | null> {
  try {
    const raw = (await ctx.docker.info()).KernelVersion;
    // eslint-disable-next-line no-control-regex
    const clean = typeof raw === 'string' ? raw.replace(/[\0-\x1f\x7f]/g, '').trim().slice(0, 100) : '';
    return clean || null;
  } catch (err) {
    ctx.log(`warning: could not read the host's kernel from Docker: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Refuse image `ref` of a quick service when its line will not start on this
 * host's kernel; `after` ends the message (what was left alone).
 */
export async function checkKernel(ctx: Pick<Ctx, 'docker' | 'log'>, config: Pick<DeployAppConfig, 'service'>, ref: string | null, after: string): Promise<void> {
  if (!config.service || !ref) return;
  const t = serviceTemplate(config.service);
  const match = t ? serviceKernelRuleOfImage(t, ref) : null;
  if (!match) return;
  const kernel = await hostKernel(ctx);
  const newer = kernelAtLeast(kernel, match.rule.from);
  if (newer === null) {
    ctx.log(`warning: the host's kernel version${kernel ? ` ${JSON.stringify(kernel)}` : ''} cannot be read, so whether ${match.label} starts on it (kernels ${match.rule.from} and newer are refused) was not checked`);
    return;
  }
  if (newer) {
    throw new BastionError(serviceKernelRefusal(match.label, kernel!, match.rule, after), 1, { refused: 'kernel', kernel, docs: match.rule.docs });
  }
}
