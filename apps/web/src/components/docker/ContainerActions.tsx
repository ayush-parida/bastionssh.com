import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DockerContainer, DockerContainerAction, DockerPermissions } from '@smt/shared';
import { Loader2, Pause, Play, RotateCw, Skull, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { dockerKeys } from '@/lib/docker.js';
import { containerAction, openContainerShell, removeContainer } from '@/lib/docker-actions.js';
import ConfirmDialog from './ConfirmDialog.js';

type Action = DockerContainerAction | 'remove' | 'shell';

const LABEL: Record<Action, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  kill: 'Kill',
  pause: 'Pause',
  unpause: 'Unpause',
  remove: 'Remove',
  shell: 'Open shell',
};

const ICON: Record<Action, typeof Play> = {
  start: Play,
  stop: Square,
  restart: RotateCw,
  kill: Skull,
  pause: Pause,
  unpause: Play,
  remove: Trash2,
  shell: SquareTerminal,
};

/** What each state allows, in the order the buttons show. */
function actionsFor(container: DockerContainer, permissions: DockerPermissions): Action[] {
  const lifecycle: Action[] =
    container.state === 'running'
      ? ['stop', 'restart', 'pause', 'kill']
      : container.state === 'paused'
        ? ['unpause', 'kill']
        : container.state === 'restarting'
          ? ['stop', 'kill']
          : container.state === 'removing'
            ? []
            : ['start'];
  return [
    ...(container.state === 'running' && permissions.exec ? (['shell'] as const) : []),
    ...(permissions.control ? lifecycle : []),
    ...(permissions.remove && container.state !== 'removing' ? (['remove'] as const) : []),
  ];
}

/** Stop, restart, kill and remove interrupt what runs or delete it: they ask first. */
const CONFIRM: Partial<Record<Action, { title: string; body: string; confirm: string }>> = {
  stop: { title: 'Stop container', body: 'Its processes get SIGTERM, then SIGKILL after the timeout.', confirm: 'Stop' },
  restart: { title: 'Restart container', body: 'Its processes are stopped and started again.', confirm: 'Restart' },
  kill: { title: 'Kill container', body: 'Its processes get SIGKILL at once, with no chance to shut down cleanly.', confirm: 'Kill' },
  remove: { title: 'Remove container', body: 'The container and its writable layer are deleted. This cannot be undone.', confirm: 'Remove' },
};

/**
 * A container's actions, gated by the caller's Docker permissions (the server
 * refuses the same things). `compact` shows icon buttons for table rows; the
 * drawer shows them labelled. "Open shell" starts a shell in the container and
 * opens it in the terminal page.
 */
export default function ContainerActions({
  serverId,
  serverName,
  container,
  permissions,
  compact = false,
  onRemoved,
}: {
  serverId: string;
  serverName: string;
  container: DockerContainer;
  permissions: DockerPermissions;
  compact?: boolean;
  onRemoved?: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState<Action | null>(null);
  const actions = actionsFor(container, permissions);
  if (actions.length === 0) return null;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: dockerKeys.containers(serverId) });
    qc.invalidateQueries({ queryKey: dockerKeys.info(serverId) });
  };

  async function run(action: Action, options: Record<string, boolean> = {}) {
    if (action === 'shell') {
      const session = await openContainerShell(serverId, container.id);
      navigate(`/servers/${serverId}/terminal`, {
        state: {
          sessionId: session.sessionId,
          serverName,
          recording: session.recording,
          container: session.container,
        },
      });
      return;
    }
    if (action === 'remove') {
      await removeContainer(serverId, container.id, { force: !!options.force, volumes: !!options.volumes });
      toast.success(`Removed ${container.name}`);
      onRemoved?.();
    } else {
      const result = await containerAction(serverId, container.id, action);
      if (!result.changed) toast.message(`${container.name} was already ${action === 'start' ? 'running' : 'stopped'}`);
      else toast.success(`${LABEL[action]}: ${container.name}`);
    }
    refresh();
  }

  async function click(action: Action) {
    if (CONFIRM[action]) return setConfirming(action);
    setBusy(action);
    try {
      await run(action);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const dialog = confirming && CONFIRM[confirming];
  return (
    <div className={cn('flex flex-wrap items-center', compact ? 'justify-end gap-0.5' : 'gap-1.5')}>
      {actions.map((action) => {
        const Icon = busy === action ? Loader2 : ICON[action];
        const destructive = action === 'remove' || action === 'kill';
        return (
          <button
            key={action}
            onClick={() => void click(action)}
            disabled={busy !== null}
            title={compact ? LABEL[action] : undefined}
            aria-label={`${LABEL[action]} ${container.name}`}
            className={cn(
              'flex items-center gap-1.5 rounded-md text-sm disabled:opacity-50',
              compact ? 'p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground' : 'border border-border px-2.5 py-1 hover:bg-muted',
              destructive && 'hover:text-red-600',
            )}
          >
            <Icon size={14} className={busy === action ? 'animate-spin' : undefined} />
            {!compact && LABEL[action]}
          </button>
        );
      })}
      {confirming && dialog && (
        <ConfirmDialog
          title={dialog.title}
          subject={`${container.name} (${container.id.slice(0, 12)}) · ${container.image}`}
          confirmLabel={dialog.confirm}
          danger={confirming === 'remove' || confirming === 'kill'}
          options={
            confirming === 'remove'
              ? [
                  ...(container.state === 'running' || container.state === 'paused'
                    ? [{ key: 'force', label: 'Force: kill it first', hint: 'It is still running.' }]
                    : []),
                  { key: 'volumes', label: 'Also remove its anonymous volumes', hint: 'Named volumes are kept.' },
                ]
              : []
          }
          onConfirm={(options) => run(confirming, options)}
          onClose={() => setConfirming(null)}
        >
          <p className="text-muted-foreground">{dialog.body}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
