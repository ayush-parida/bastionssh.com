import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeployBuildType, DeployNginxApplyResult, DeployValidationIssue } from '@smt/shared';
import { parseDocument } from 'yaml';
import { Loader2, RotateCcw, Save, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { appPath, deployKeys, issuesAt, nginxSyncMessage, validationIssues } from '@/lib/deploy.js';
import { cn } from '@/lib/utils.js';
import BuildGuide from './BuildGuide.js';

type Path = (string | number)[];
type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The YAML as data, or the syntax problems that stop the form from showing it. */
function parse(text: string): { data: Raw | null; errors: string[] } {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return { data: null, errors: doc.errors.map((e) => e.message.split('\n')[0]!) };
  const data = doc.toJS() as unknown;
  return { data: isObject(data) ? data : data == null ? {} : null, errors: isObject(data) || data == null ? [] : ['The config must be a mapping (key: value)'] };
}

/**
 * Change one value in the YAML text, keeping everything else — comments,
 * order, flow style — as written. `undefined` removes the key (bastionctl's
 * default applies).
 */
export function setYaml(text: string, path: Path, value: unknown): string {
  const doc = parseDocument(text);
  if (value === undefined) {
    doc.deleteIn(path);
  } else {
    doc.setIn(path, value);
  }
  return doc.toString();
}

function get(data: Raw | null, path: Path): unknown {
  let v: unknown = data;
  for (const key of path) v = isObject(v) || Array.isArray(v) ? (v as Record<string | number, unknown>)[key] : undefined;
  return v;
}

/** A number when the input is one, else the text as typed (bastionctl then says what is wrong). */
function numberOrText(value: string): unknown {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(value.trim()) ? n : value;
}

const lines = (value: string) =>
  value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function Issues({ issues }: { issues: DeployValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {issues.map((i, n) => (
        <li key={n} className="text-xs text-red-600">
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function Field({ label, hint, issues, children }: { label: string; hint?: string; issues: DeployValidationIssue[]; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className={cn('mt-1', issues.length > 0 && '[&_input]:border-red-500 [&_select]:border-red-500 [&_textarea]:border-red-500')}>{children}</div>
      {hint && issues.length === 0 && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
      <Issues issues={issues} />
    </label>
  );
}

const input = 'w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';

/**
 * `bastion.yml` (spec §4) as a form and as YAML. The YAML text is the one
 * source of truth: the form edits it in place, so comments and keys it does
 * not show survive. Saving sends the text; bastionctl validates it on the
 * server and every problem it finds shows next to its field (or, in the YAML
 * view, as a list with each key path).
 */
export default function ConfigEditor({
  serverId,
  app,
  canManage,
  initialText,
  creating,
  onSaved,
}: {
  serverId: string;
  app: string;
  canManage: boolean;
  /** For a new app: the template to start from instead of the server's file. */
  initialText?: string;
  creating?: boolean;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const remote = useQuery<{ text: string }>({
    queryKey: deployKeys.config(serverId, app),
    queryFn: () => api.get(appPath(serverId, app, '/config')),
    enabled: !initialText,
    retry: false,
  });
  const loaded = initialText ?? remote.data?.text;
  const [text, setText] = useState<string | null>(null);
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [issues, setIssues] = useState<DeployValidationIssue[] | null>(null);
  // What the number and list inputs show while typed, keyed by path
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (loaded !== undefined && text === null) setText(loaded);
  }, [loaded, text]);

  const current = text ?? loaded ?? '';
  const parsed = useMemo(() => parse(current), [current]);
  const dirty = loaded !== undefined && current !== loaded;

  const save = useMutation({
    mutationFn: () => api.put<{ app: string; created: boolean; proxy?: DeployNginxApplyResult }>(appPath(serverId, app, '/config'), { text: current }),
    onSuccess: (res) => {
      setIssues(null);
      toast.success(res.created ? `${app} created` : 'bastion.yml saved');
      const nginx = nginxSyncMessage(res.proxy);
      if (nginx) toast.warning(nginx);
      qc.setQueryData(deployKeys.config(serverId, app), { text: current });
      qc.invalidateQueries({ queryKey: deployKeys.all(serverId) });
      onSaved?.();
    },
    onError: (err) => {
      const found = validationIssues(err);
      setIssues(found);
      if (!found) toast.error((err as Error).message);
    },
  });

  if (!initialText && remote.isLoading) return <p className="text-sm text-muted-foreground">Loading bastion.yml…</p>;
  if (!initialText && remote.error) return <p className="text-sm text-red-600">{(remote.error as Error).message}</p>;

  const readOnly = !canManage;
  const data = parsed.data;
  const update = (path: Path, value: unknown) => {
    setText(setYaml(current, path, value));
  };
  const draftFor = (path: Path, derived: string) => drafts[path.join('.')] ?? derived;
  const setDraft = (path: Path, value: string) => setDrafts((d) => ({ ...d, [path.join('.')]: value }));
  const str = (path: Path) => {
    const v = get(data, path);
    return v === undefined || v === null ? '' : String(v);
  };
  const at = (path: string) => issuesAt(issues, path);

  const textField = (path: Path, placeholder?: string) => (
    <input
      className={input}
      disabled={readOnly}
      value={str(path)}
      placeholder={placeholder}
      onChange={(e) => update(path, e.target.value === '' ? undefined : e.target.value)}
    />
  );
  const numberField = (path: Path, placeholder?: string) => (
    <input
      className={input}
      disabled={readOnly}
      inputMode="decimal"
      value={draftFor(path, str(path))}
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(path, e.target.value);
        update(path, numberOrText(e.target.value));
      }}
    />
  );
  const listField = (path: Path, placeholder: string) => (
    <textarea
      className={cn(input, 'font-mono')}
      rows={3}
      disabled={readOnly}
      value={draftFor(path, ((get(data, path) as unknown[] | undefined) ?? []).map(String).join('\n'))}
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(path, e.target.value);
        const list = lines(e.target.value);
        update(path, list.length ? list : undefined);
      }}
    />
  );

  const tls = get(data, ['tls']);
  const tlsMode = isObject(tls) ? 'files' : typeof tls === 'string' && tls.startsWith('dns:') ? 'dns' : typeof tls === 'string' ? tls : 'auto';
  const buildType = str(['build', 'type']) || 'nextjs';
  // Issues the form has no field for (syntax, unknown keys) are listed above it
  const shown = [
    'name',
    'domains',
    'redirect_www',
    'tls',
    'build.type',
    'build.node',
    'build.dir',
    'build.output',
    'build.image',
    'build.where',
    'build.args',
    'run.port',
    'run.env_file',
    'run.memory',
    'run.cpus',
    'run.strategy',
    'run.publish',
    'healthcheck.path',
    'healthcheck.timeout',
    'keep_releases',
    'proxy',
    'permissions',
  ];
  // The long volume form ({ name, path, exclusive }) and command health checks are edited as YAML
  const volumes = get(data, ['run', 'volumes']);
  const simpleVolumes = volumes === undefined || (Array.isArray(volumes) && volumes.every((v) => typeof v === 'string'));
  if (simpleVolumes) shown.push('run.volumes');
  const unplaced = (issues ?? []).filter((i) => mode === 'yaml' || !shown.some((p) => i.path === p || i.path.startsWith(`${p}.`)));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Editor" className="flex rounded-md border border-border p-0.5 text-sm">
          {(['form', 'yaml'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn('rounded px-3 py-1', mode === m ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}
            >
              {m === 'form' ? 'Form' : 'YAML'}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          <span className="font-mono">bastion.yml</span> on the server{creating ? ' — saved when the app is created' : ''}
        </span>
        {canManage && (
          <div className="ml-auto flex items-center gap-2">
            {dirty && !creating && (
              <button
                onClick={() => {
                  setText(loaded ?? '');
                  setDrafts({});
                  setIssues(null);
                }}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted"
              >
                <RotateCcw size={13} /> Discard
              </button>
            )}
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending || (!dirty && !creating)}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {save.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {creating ? 'Create app' : 'Validate and save'}
            </button>
          </div>
        )}
      </div>

      {issues && (
        <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-red-600">
            <TriangleAlert size={14} /> bastionctl refused this config ({issues.length} problem{issues.length === 1 ? '' : 's'}). Nothing was saved.
          </p>
          {unplaced.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs">
              {unplaced.map((i, n) => (
                <li key={n}>
                  {i.path && <span className="font-mono text-red-700 dark:text-red-400">{i.path}: </span>}
                  <span className="text-red-600">{i.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {data && (['nextjs', 'dockerfile', 'static'] as string[]).includes(buildType) && <BuildGuide key={buildType} type={buildType as DeployBuildType} open={creating} />}

      {mode === 'yaml' ? (
        <textarea
          aria-label="bastion.yml"
          spellCheck={false}
          readOnly={readOnly}
          value={current}
          onChange={(e) => {
            setText(e.target.value);
            setDrafts({});
          }}
          rows={Math.max(14, current.split('\n').length + 2)}
          className={cn(input, 'font-mono text-xs leading-5')}
        />
      ) : !data ? (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          The YAML cannot be read ({parsed.errors[0]}). Fix it in the YAML view.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" issues={at('name')} hint="The app's name; fixed once created">
            <input className={input} disabled value={str(['name']) || app} readOnly />
          </Field>
          <Field label="Domains" issues={at('domains')} hint="One per line, like example.com">
            {listField(['domains'], 'example.com\nwww.example.com')}
          </Field>
          <Field label="Redirect www" issues={at('redirect_www')}>
            <select className={input} disabled={readOnly} value={str(['redirect_www']) || 'none'} onChange={(e) => update(['redirect_www'], e.target.value)}>
              <option value="none">none — serve both as listed</option>
              <option value="apex">apex — www.example.com → example.com</option>
              <option value="www">www — example.com → www.example.com</option>
            </select>
          </Field>
          <Field label="TLS" issues={at('tls')}>
            <select
              className={input}
              disabled={readOnly}
              value={tlsMode}
              onChange={(e) => {
                const v = e.target.value;
                update(['tls'], v === 'dns' ? 'dns:cloudflare' : v === 'files' ? { cert: 'certs/cert.pem', key: 'certs/key.pem' } : v);
              }}
            >
              <option value="auto">auto — Let’s Encrypt</option>
              <option value="staging">staging — Let’s Encrypt test certificates</option>
              <option value="internal">internal — Caddy’s own CA (private names)</option>
              <option value="dns">dns — DNS challenge (wildcards)</option>
              <option value="files">certificate files in the app folder</option>
            </select>
            {tlsMode === 'dns' && (
              <input
                className={cn(input, 'mt-2')}
                disabled={readOnly}
                aria-label="DNS provider"
                value={String(tls).slice(4)}
                onChange={(e) => update(['tls'], `dns:${e.target.value}`)}
              />
            )}
            {tlsMode === 'files' && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input className={input} disabled={readOnly} aria-label="Certificate file" value={str(['tls', 'cert'])} onChange={(e) => update(['tls', 'cert'], e.target.value)} />
                <input className={input} disabled={readOnly} aria-label="Key file" value={str(['tls', 'key'])} onChange={(e) => update(['tls', 'key'], e.target.value)} />
              </div>
            )}
          </Field>
          <Field label="Build type" issues={at('build.type')}>
            <select className={input} disabled={readOnly} value={buildType} onChange={(e) => update(['build', 'type'], e.target.value)}>
              <option value="nextjs">nextjs — Next.js with output: standalone</option>
              <option value="dockerfile">dockerfile — the project’s own Dockerfile</option>
              <option value="static">static — build, then serve a folder</option>
              <option value="image">image — pull a ready-made image (a database, a cache)</option>
            </select>
          </Field>
          {buildType === 'image' && (
            <Field label="Image" issues={at('build.image')} hint="A registry reference with a tag, ideally pinned: postgres:16.4@sha256:…">
              {textField(['build', 'image'], 'postgres:16')}
            </Field>
          )}
          {buildType !== 'dockerfile' && buildType !== 'image' && (
            <Field label="Node.js version" issues={at('build.node')} hint="Default: .nvmrc, engines.node, or 20">
              {textField(['build', 'node'], '20')}
            </Field>
          )}
          {buildType !== 'image' && (
            <Field label="Project folder" issues={at('build.dir')} hint="Inside the upload; . is its root">
              {textField(['build', 'dir'], '.')}
            </Field>
          )}
          {buildType !== 'image' && (
            <Field
              label="Build on"
              issues={at('build.where')}
              hint={
                str(['build', 'where']) === 'bastion'
                  ? "BastionSSH's builder makes the image for the server's platform and ships only the image: the server never runs npm or the build"
                  : 'The server installs dependencies and builds (a Next.js build wants 1–2 GB of memory there)'
              }
            >
              <select
                className={input}
                disabled={readOnly}
                aria-label="Build on"
                value={str(['build', 'where']) || 'server'}
                onChange={(e) => update(['build', 'where'], e.target.value === 'server' ? undefined : e.target.value)}
              >
                <option value="server">the server (default)</option>
                <option value="bastion">BastionSSH — only the image goes to the server</option>
              </select>
            </Field>
          )}
          {buildType !== 'image' && (
            <Field label="Build args" issues={at('build.args')} hint="Other .env names the build gets besides every NEXT_PUBLIC_*, one per line; read from the app's .env for the build only">
              {listField(['build', 'args'], 'SENTRY_RELEASE')}
            </Field>
          )}
          {buildType === 'static' && (
            <Field label="Output folder" issues={at('build.output')} hint="What the build writes, served as the site">
              {textField(['build', 'output'], 'out')}
            </Field>
          )}
          {buildType !== 'static' && (
            <Field label="Port" issues={at('run.port')} hint="The port the app listens on inside its container">
              {numberField(['run', 'port'], '3000')}
            </Field>
          )}
          <Field label="Memory limit" issues={at('run.memory')} hint="Like 512m or 1g; empty for none">
            {textField(['run', 'memory'], '512m')}
          </Field>
          <Field label="CPUs" issues={at('run.cpus')} hint="Like 1 or 0.5; empty for no limit">
            {numberField(['run', 'cpus'], '1')}
          </Field>
          {simpleVolumes && (
            <Field label="Volumes" issues={at('run.volumes')} hint="Named volumes, one per line: uploads:/app/public/uploads">
              {listField(['run', 'volumes'], 'uploads:/app/public/uploads')}
            </Field>
          )}
          <Field label="Strategy" issues={at('run.strategy')} hint="recreate stops the old container first (needed with an exclusive volume or run.publish)">
            <select className={input} disabled={readOnly} value={str(['run', 'strategy']) || 'rolling'} onChange={(e) => update(['run', 'strategy'], e.target.value === 'rolling' ? undefined : e.target.value)}>
              <option value="rolling">rolling — no downtime (default)</option>
              <option value="recreate">recreate — old container stops first</option>
            </select>
          </Field>
          <Field label="Publish on the host" issues={at('run.publish')} hint="none, localhost:15432 (for SSH tunnels) or public:9000 (firewall it)">
            {textField(['run', 'publish'], 'none')}
          </Field>
          <Field label="Health check path" issues={at('healthcheck.path')}>
            {textField(['healthcheck', 'path'], '/')}
          </Field>
          <Field label="Health check timeout" issues={at('healthcheck.timeout')}>
            {textField(['healthcheck', 'timeout'], '30s')}
          </Field>
          <Field label="Releases kept" issues={at('keep_releases')} hint="For rollback; 2 to 50">
            {numberField(['keep_releases'], '5')}
          </Field>
          <Field label="Proxy" issues={at('proxy')}>
            <select className={input} disabled={readOnly} value={str(['proxy']) || 'caddy'} onChange={(e) => update(['proxy'], e.target.value)}>
              <option value="caddy">caddy</option>
              <option value="nginx">nginx</option>
            </select>
          </Field>
          <Field label="Who may deploy" issues={at('permissions')} hint="Deploy and roll back; a deploy runs the app's code with its secrets">
            <select
              className={input}
              disabled={readOnly}
              value={str(['permissions', 'deploy']) || 'operate'}
              onChange={(e) => update(['permissions'], e.target.value === 'manage' ? { deploy: 'manage' } : undefined)}
            >
              <option value="operate">operate (default)</option>
              <option value="manage">manage</option>
            </select>
          </Field>
        </div>
      )}
      {readOnly && <p className="text-xs text-muted-foreground">Editing the config needs manage access to Deployments on this server.</p>}
    </div>
  );
}
