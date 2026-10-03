import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KubeObjectRef, KubeObjectYaml } from '@smt/shared';
import { Copy, Download, Loader2, Lock, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { podKeys, yamlPath } from '@/lib/kube-pods.js';

/** A line of YAML with its key, value and comment told apart (no parser; display only). */
function YamlLine({ line, query }: { line: string; query: string }) {
  const match = /^(\s*(?:- )?)([^\s:#][^:#]*?)(:)(\s.*|$)/.exec(line);
  const mark = (text: string): React.ReactNode => {
    if (!query) return text;
    const at = text.toLowerCase().indexOf(query);
    if (at === -1) return text;
    return (
      <>
        {text.slice(0, at)}
        <mark className="rounded-sm bg-amber-300 text-zinc-950">{text.slice(at, at + query.length)}</mark>
        {mark(text.slice(at + query.length))}
      </>
    );
  };
  if (line.trimStart().startsWith('#')) return <span className="text-zinc-500">{mark(line)}</span>;
  if (!match) return <span className="text-emerald-300">{mark(line)}</span>;
  const [, indent, key, colon, rest] = match;
  return (
    <>
      {indent}
      <span className="text-sky-300">{mark(key!)}</span>
      <span className="text-zinc-500">{colon}</span>
      <span className="text-emerald-300">{mark(rest!)}</span>
    </>
  );
}

/**
 * An object's YAML, read-only (operators and up, spec §7): fetched when the
 * tab opens, with line numbers, search, copy and download. The server
 * removes Secret values and shows env values from Secrets as references only
 * (`secretKeyRef`), so what is here is safe to copy.
 */
export default function YamlView({
  clusterId,
  objectRef,
}: {
  clusterId: string;
  objectRef: Pick<KubeObjectRef, 'resource' | 'namespace' | 'name'>;
}) {
  const path = yamlPath(clusterId, objectRef);
  const yaml = useQuery<KubeObjectYaml>({
    queryKey: podKeys.yaml(clusterId, path),
    queryFn: () => api.get(path),
    retry: false,
  });
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const lines = useMemo(() => (yaml.data?.yaml ?? '').replace(/\n$/, '').split('\n'), [yaml.data]);
  const hits = useMemo(() => (q ? lines.filter((l) => l.toLowerCase().includes(q)).length : 0), [lines, q]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(yaml.data!.yaml);
      toast.success('YAML copied');
    } catch {
      toast.message('Select the text to copy it');
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([yaml.data!.yaml], { type: 'application/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${objectRef.name}.yaml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (yaml.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </p>
    );
  }
  if (yaml.error) return <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{(yaml.error as Error).message}</p>;
  if (!yaml.data) return null;

  return (
    <div className="space-y-2" data-testid="yaml-view">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Lock size={12} /> Read-only.{' '}
          {yaml.data.redacted ? 'Values are removed from this view.' : 'Secret values and env values taken from Secrets are never shown.'}
        </span>
        <div className="relative ml-auto">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find"
            aria-label="Find in YAML"
            className="w-32 rounded-md border border-input bg-background py-0.5 pl-6 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        {q && <span className="tabular-nums">{hits} line{hits === 1 ? '' : 's'}</span>}
        <button onClick={copy} className="flex items-center gap-1 hover:text-foreground">
          <Copy size={12} /> Copy
        </button>
        <button onClick={download} className="flex items-center gap-1 hover:text-foreground">
          <Download size={12} /> Download
        </button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-zinc-950 py-2 font-mono text-xs leading-5 text-zinc-100">
        {lines.map((line, i) => (
          <div key={i} className={cn('flex pr-3', q && line.toLowerCase().includes(q) && 'bg-amber-400/10')}>
            <span className="mr-3 w-10 shrink-0 select-none pr-2 text-right text-zinc-600">{i + 1}</span>
            <span className="whitespace-pre">
              <YamlLine line={line} query={q} />
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}
