import type { DockerImage, DockerNetwork, DockerVolume } from '@smt/shared';
import { formatBytes, relativeTime } from '@/lib/utils.js';
import { shortId } from '@/lib/docker.js';

/** Images, volumes and networks on one server: read-only tables (actions arrive in a later phase). */

function Table({ head, children, empty }: { head: string[]; children: React.ReactNode; empty: string | null }) {
  if (empty) return <p className="py-12 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

const badge = 'rounded px-1.5 py-0.5 text-xs';

export function ImagesTable({ images, onSelect }: { images: DockerImage[]; onSelect?: (image: DockerImage) => void }) {
  const sorted = [...images].sort((a, b) => (a.repoTags[0] ?? '~').localeCompare(b.repoTags[0] ?? '~'));
  return (
    <Table head={['Tag', 'Id', 'Size', 'Created', '']} empty={images.length === 0 ? 'No images.' : null}>
      {sorted.map((i) => (
        <tr key={i.id} onClick={() => onSelect?.(i)} className={onSelect ? 'cursor-pointer hover:bg-muted/50' : undefined}>
          <td className="px-4 py-2 font-mono text-xs">
            {i.repoTags.length > 0 ? i.repoTags.map((t) => <div key={t}>{t}</div>) : <span className="text-muted-foreground">&lt;none&gt;</span>}
          </td>
          <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{shortId(i.id)}</td>
          <td className="whitespace-nowrap px-4 py-2">{formatBytes(i.size, 1)}</td>
          <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{relativeTime(i.createdAt)}</td>
          <td className="px-4 py-2">
            {i.inUse && <span className={`${badge} bg-emerald-500/10 text-emerald-600 dark:text-emerald-400`}>in use</span>}
            {i.dangling && <span className={`${badge} ml-1 bg-muted text-muted-foreground`}>dangling</span>}
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function VolumesTable({ volumes }: { volumes: DockerVolume[] }) {
  return (
    <Table head={['Name', 'Driver', 'Mountpoint', 'Size', '']} empty={volumes.length === 0 ? 'No volumes.' : null}>
      {[...volumes]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((v) => (
          <tr key={v.name}>
            <td className="max-w-[18rem] truncate px-4 py-2 font-mono text-xs" title={v.name}>
              {v.name}
            </td>
            <td className="px-4 py-2 text-muted-foreground">{v.driver}</td>
            <td className="max-w-[20rem] truncate px-4 py-2 font-mono text-xs text-muted-foreground" title={v.mountpoint}>
              {v.mountpoint}
            </td>
            <td className="whitespace-nowrap px-4 py-2">{v.size != null ? formatBytes(v.size, 1) : '—'}</td>
            <td className="px-4 py-2">
              {v.inUse ? (
                <span className={`${badge} bg-emerald-500/10 text-emerald-600 dark:text-emerald-400`}>in use</span>
              ) : (
                <span className={`${badge} bg-muted text-muted-foreground`}>unused</span>
              )}
            </td>
          </tr>
        ))}
    </Table>
  );
}

export function NetworksTable({ networks }: { networks: DockerNetwork[] }) {
  return (
    <Table head={['Name', 'Driver', 'Scope', 'Subnets', 'Containers']} empty={networks.length === 0 ? 'No networks.' : null}>
      {[...networks]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((n) => (
          <tr key={n.id}>
            <td className="px-4 py-2">
              <p className="font-medium">{n.name}</p>
              <p className="font-mono text-xs text-muted-foreground">
                {shortId(n.id)}
                {n.internal && <span className="ml-2 font-sans">internal</span>}
              </p>
            </td>
            <td className="px-4 py-2 text-muted-foreground">{n.driver}</td>
            <td className="px-4 py-2 text-muted-foreground">{n.scope}</td>
            <td className="px-4 py-2 font-mono text-xs">{n.subnets.join(', ') || '—'}</td>
            <td className="px-4 py-2">{n.containers}</td>
          </tr>
        ))}
    </Table>
  );
}
