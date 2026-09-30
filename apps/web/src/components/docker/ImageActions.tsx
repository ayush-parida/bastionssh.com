import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DockerImage } from '@smt/shared';
import { Trash2 } from 'lucide-react';
import { dockerKeys, shortId } from '@/lib/docker.js';
import { removeImage } from '@/lib/docker-actions.js';
import ConfirmDialog from './ConfirmDialog.js';

/** Remove an image (for those who may remove), after naming it in a confirmation. */
export default function ImageActions({ serverId, image }: { serverId: string; image: DockerImage }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const name = image.repoTags[0] ?? `<none> ${shortId(image.id)}`;

  return (
    <>
      <button
        onClick={() => setConfirming(true)}
        title="Remove image"
        aria-label={`Remove image ${name}`}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-red-600"
      >
        <Trash2 size={14} />
      </button>
      {confirming && (
        <ConfirmDialog
          title="Remove image"
          subject={`${image.repoTags.join(', ') || '<none>'} (${shortId(image.id)})`}
          confirmLabel="Remove"
          options={[
            {
              key: 'force',
              label: 'Force',
              hint: image.inUse
                ? 'A container uses it: its tags are removed and the image is deleted once nothing uses it.'
                : 'Remove it even if it has several tags.',
            },
          ]}
          onConfirm={async (options) => {
            // By id, so every tag goes; a tagged image is removed by its first tag when not forced
            const target = options.force || image.repoTags.length === 0 ? image.id : image.repoTags[0]!;
            await removeImage(serverId, target, !!options.force);
            toast.success(`Removed ${name}`);
            qc.invalidateQueries({ queryKey: dockerKeys.images(serverId) });
            qc.invalidateQueries({ queryKey: dockerKeys.info(serverId) });
          }}
          onClose={() => setConfirming(false)}
        >
          <p className="text-muted-foreground">
            {image.repoTags.length > 1
              ? `It has ${image.repoTags.length} tags; without force only the first tag is removed.`
              : 'The image is deleted from the server. It can be pulled again later.'}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
