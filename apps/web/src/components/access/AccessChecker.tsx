import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AccessExplanation, OrgMember, ResourceType } from '@smt/shared';
import { SearchCheck } from 'lucide-react';
import { api } from '@/lib/api.js';
import { RESOURCE_SECTIONS, RESOURCE_TYPE_LABELS } from '@/lib/access.js';
import { LevelBadge, reasonText } from './AccessBadges.js';
import { useAccessResources } from './GrantsEditor.js';

const selectClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

/** Pick a member and a resource: their level, and every reason behind it (custom roles spec §7). */
export default function AccessChecker() {
  const [userId, setUserId] = useState('');
  const [type, setType] = useState<ResourceType>('server');
  const [resourceId, setResourceId] = useState('');
  const [namespace, setNamespace] = useState('');
  const { data: members } = useQuery<OrgMember[]>({ queryKey: ['team-members'], queryFn: () => api.get('/team/members') });
  const { data: resources } = useAccessResources();

  const ns = type === 'cluster' && namespace.trim() ? `&namespace=${encodeURIComponent(namespace.trim())}` : '';
  const { data: answer, error, isFetching } = useQuery<AccessExplanation>({
    queryKey: ['access-explain', userId, type, resourceId, ns],
    queryFn: () => api.get(`/team/access/explain?userId=${userId}&type=${type}&id=${resourceId}${ns}`),
    enabled: !!userId && !!resourceId,
  });

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">Access checker</h2>
      <p className="text-sm text-muted-foreground mb-4">Why can (or can&rsquo;t) someone reach a resource?</p>
      <div className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="checker-member" className="block text-sm font-medium mb-1">Member</label>
            <select id="checker-member" value={userId} onChange={(e) => setUserId(e.target.value)} className={selectClass}>
              <option value="">Pick a member…</option>
              {(members ?? []).map((m) => <option key={m.userId} value={m.userId}>{m.displayName} ({m.email})</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="checker-type" className="block text-sm font-medium mb-1">Type</label>
            <select id="checker-type" value={type} onChange={(e) => { setType(e.target.value as ResourceType); setResourceId(''); }} className={selectClass}>
              {RESOURCE_SECTIONS.map((s) => <option key={s.type} value={s.type}>{s.title}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="checker-resource" className="block text-sm font-medium mb-1">Resource</label>
            <select id="checker-resource" value={resourceId} onChange={(e) => setResourceId(e.target.value)} className={selectClass}>
              <option value="">Pick a {RESOURCE_TYPE_LABELS[type].one}…</option>
              {(resources?.[type] ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          {type === 'cluster' && (
            <div className="sm:col-span-3">
              <label htmlFor="checker-namespace" className="block text-sm font-medium mb-1">Namespace (optional)</label>
              <input id="checker-namespace" value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="the cluster as a whole" className={selectClass} />
            </div>
          )}
        </div>

        {userId && resourceId && (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm" data-testid="access-check-result">
            {isFetching && !answer ? (
              <p className="text-muted-foreground">Checking…</p>
            ) : error ? (
              <p className="text-red-500">{(error as Error).message}</p>
            ) : answer ? (
              <div className="space-y-2">
                <p className="flex flex-wrap items-center gap-2">
                  <SearchCheck size={15} className="text-primary" />
                  <span className="font-medium">{answer.user.displayName}</span>
                  <span className="text-muted-foreground">on {answer.resource.name}:</span>
                  <LevelBadge level={answer.level} />
                  <span className="text-xs text-muted-foreground">
                    scope: {answer.user.scope === 'roles' ? 'only resources from roles' : 'all resources'}
                  </span>
                </p>
                {answer.via.length === 0 ? (
                  <p className="text-muted-foreground">
                    {answer.user.scope === 'roles'
                      ? 'No role or personal grant covers it, and their scope is only resources from roles.'
                      : 'Nothing gives them access.'}
                  </p>
                ) : (
                  <ul className="list-disc space-y-0.5 pl-5">
                    {answer.via.map((v, i) => (
                      <li key={i}>
                        <span className="font-medium capitalize">{v.level}</span> — {reasonText(v)}
                      </li>
                    ))}
                  </ul>
                )}
                {answer.namespaces && answer.namespaces.length > 0 && (
                  <p className="text-xs text-muted-foreground">Namespaces: {answer.namespaces.join(', ')}</p>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
