import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Collapsible JSON tree for inspect payloads. Objects and arrays past the
 * first levels start folded, so a large inspect stays readable.
 */

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className="text-muted-foreground">null</span>;
  if (typeof value === 'string') return <span className="text-emerald-700 dark:text-emerald-400">"{value}"</span>;
  if (typeof value === 'number') return <span className="text-sky-700 dark:text-sky-400">{value}</span>;
  if (typeof value === 'boolean') return <span className="text-amber-700 dark:text-amber-400">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function Node({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const isArray = Array.isArray(value);
  const isObject = typeof value === 'object' && value !== null;
  const entries = isObject ? (isArray ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as object)) : [];
  const [open, setOpen] = useState(depth < 2 && entries.length <= 50);
  const label = name !== null && <span className="text-foreground">{name}: </span>;

  if (!isObject) {
    return (
      <div className="break-all pl-4">
        {label}
        <Scalar value={value} />
      </div>
    );
  }
  const brackets = isArray ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0) {
    return (
      <div className="pl-4">
        {label}
        <span className="text-muted-foreground">{brackets.join('')}</span>
      </div>
    );
  }
  return (
    <div className={depth > 0 ? 'pl-4' : undefined}>
      <button onClick={() => setOpen(!open)} className="-ml-4 inline-flex items-center hover:text-foreground">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
        <span className="text-muted-foreground">
          {brackets[0]}
          {!open && ` ${entries.length} ${isArray ? 'items' : 'keys'} ${brackets[1]}`}
        </span>
      </button>
      {open && (
        <>
          {entries.map(([k, v]) => (
            <Node key={k} name={isArray ? null : k} value={v} depth={depth + 1} />
          ))}
          <div className="text-muted-foreground">{brackets[1]}</div>
        </>
      )}
    </div>
  );
}

export default function JsonViewer({ value }: { value: unknown }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
      toast.success('Copied');
    } catch {
      toast.message('Could not copy');
    }
  }
  return (
    <div className="relative rounded-md border border-border bg-muted/30 p-3 pl-6 font-mono text-xs leading-5">
      <button onClick={copy} title="Copy JSON" className="absolute right-2 top-2 text-muted-foreground hover:text-foreground">
        <Copy size={13} />
      </button>
      <Node name={null} value={value} depth={0} />
    </div>
  );
}
