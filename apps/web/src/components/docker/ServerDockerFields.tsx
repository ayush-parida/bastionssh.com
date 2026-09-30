import type { DockerMode, Server } from '@smt/shared';
import { DEFAULT_DOCKER_SOCKET } from '@smt/shared';
import { DetectDockerButton } from './DetectDocker.js';

/** Docker part of the server form (admins only — the form is admin-only anyway). */
export default function ServerDockerFields({
  mode,
  socketPath,
  onChange,
  editing,
}: {
  mode: DockerMode;
  socketPath: string;
  onChange: (patch: { dockerMode?: DockerMode; dockerSocketPath?: string }) => void;
  /** The saved server, when editing: offers detection and shows what was found. */
  editing?: Server;
}) {
  const detected = editing?.docker;
  return (
    <div className="col-span-2">
      <label className="mb-1 block text-sm font-medium">Docker</label>
      <div className="grid grid-cols-[10rem_1fr] gap-2">
        <select
          value={mode}
          onChange={(e) => onChange({ dockerMode: e.target.value as DockerMode })}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="auto">Detect on use</option>
          <option value="off">Off</option>
        </select>
        <input
          type="text"
          placeholder={`Socket path (blank: detect ${DEFAULT_DOCKER_SOCKET}, rootless, Podman)`}
          spellCheck={false}
          value={socketPath}
          disabled={mode === 'off'}
          onChange={(e) => onChange({ dockerSocketPath: e.target.value })}
          className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Reached over this server's SSH connection — the socket is never exposed on a port. Set a path for rootless Docker
        (<code className="font-mono">/run/user/&lt;uid&gt;/docker.sock</code>) or Podman (
        <code className="font-mono">/run/podman/podman.sock</code>); changing it forgets what was detected.
      </p>
      {editing && mode === 'auto' && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <DetectDockerButton serverId={editing.id} />
          <span className="text-xs text-muted-foreground">
            {detected?.detectedAt
              ? `Found Docker ${detected.version} via ${detected.transport} at ${detected.detectedSocketPath}.`
              : 'Not detected yet.'}
          </span>
        </div>
      )}
    </div>
  );
}
