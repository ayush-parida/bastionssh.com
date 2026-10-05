import type { DeployBuildType } from '@smt/shared';
import { Lightbulb } from 'lucide-react';
import { BUILD_TYPE_GUIDES } from '@/lib/deploy-help.js';
import DocsLink from '@/components/docs/DocsLink.js';

/**
 * For the config editor: what to upload for the chosen build type and the
 * smallest config for it, with the full guide one click away. Open by
 * default for a new app, folded away when editing one.
 */
export default function BuildGuide({ type, open }: { type: DeployBuildType; open?: boolean }) {
  const guide = BUILD_TYPE_GUIDES[type];
  return (
    <details open={open} aria-label="Build guide" className="rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-sm">
      <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
        <Lightbulb size={14} className="text-sky-600 dark:text-sky-400" /> How to deploy: {guide.title}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-muted-foreground">{guide.upload}</p>
        <div>
          <p className="mb-1 text-xs text-muted-foreground">The build part of bastion.yml:</p>
          <pre className="overflow-x-auto rounded bg-zinc-950 px-3 py-2 font-mono text-xs leading-5 text-zinc-100">{guide.yaml}</pre>
        </div>
        <DocsLink to={guide.docs}>Full guide</DocsLink>
      </div>
    </details>
  );
}
