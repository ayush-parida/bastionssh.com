import { memo, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Info, Lightbulb, Link as LinkIcon, TriangleAlert } from 'lucide-react';
import { resolveDocLink, Slugger } from '@/lib/docs.js';
import { cn } from '@/lib/utils.js';

/**
 * One docs page's markdown (GFM): headings with anchors (the same ids
 * lib/docs.ts lists for the table of contents), code blocks with a copy
 * button, `> **Note:**` / `> **Warning:**` / `> **Tip:**` callouts, and links
 * between pages resolved to `/docs/<section>/<slug>`.
 */

interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

const mdText = (node: MdNode): string =>
  node.type === 'text' || node.type === 'inlineCode'
    ? (node.value ?? '')
    : (node.children ?? []).map(mdText).join('');

const CALLOUT = /^(note|warning|tip|important):?$/i;

/** Ids on headings, and a `data-callout` on blockquotes that start with a bold Note:/Warning:/Tip:. */
function remarkDocs() {
  return (tree: MdNode) => {
    const slugger = new Slugger();
    const walk = (node: MdNode) => {
      if (node.type === 'heading') {
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, id: slugger.slug(mdText(node).trim()) },
        };
      } else if (node.type === 'blockquote') {
        const first = node.children?.[0];
        const strong = first?.type === 'paragraph' ? first.children?.[0] : undefined;
        const label = strong?.type === 'strong' ? mdText(strong).trim() : '';
        const m = CALLOUT.exec(label);
        if (m) {
          const kind = m[1]!.toLowerCase() === 'important' ? 'warning' : m[1]!.toLowerCase();
          node.data = {
            ...node.data,
            hProperties: { ...node.data?.hProperties, 'data-callout': kind },
          };
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
}

const hastText = (node: HastNode | undefined): string =>
  !node
    ? ''
    : node.type === 'text'
      ? (node.value ?? '')
      : (node.children ?? []).map(hastText).join('');

function CodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy code'}
        title="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(code.replace(/\n$/, '')).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute right-2 top-2 rounded-md border border-zinc-700 bg-zinc-800/90 p-1.5 text-zinc-300 opacity-80 transition hover:text-white group-hover:opacity-100"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <pre className="!my-0 overflow-x-auto rounded-md !bg-zinc-950 p-4 pr-12 text-[13px] leading-relaxed text-zinc-100">
        {children}
      </pre>
    </div>
  );
}

const CALLOUT_STYLE: Record<string, { box: string; icon: React.ElementType }> = {
  note: {
    box: 'border-sky-500/40 bg-sky-500/5 [&_strong:first-child]:text-sky-700 dark:[&_strong:first-child]:text-sky-300',
    icon: Info,
  },
  tip: {
    box: 'border-emerald-500/40 bg-emerald-500/5 [&_strong:first-child]:text-emerald-700 dark:[&_strong:first-child]:text-emerald-300',
    icon: Lightbulb,
  },
  warning: {
    box: 'border-amber-500/50 bg-amber-500/5 [&_strong:first-child]:text-amber-700 dark:[&_strong:first-child]:text-amber-300',
    icon: TriangleAlert,
  },
};

function heading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function Heading({ id, children }: { id?: string; children?: ReactNode }) {
    return (
      <Tag id={id} className="group scroll-mt-4">
        {children}
        {id && (
          <a
            href={`#${id}`}
            aria-label="Link to this section"
            className="text-muted-foreground ml-2 inline-block align-middle no-underline opacity-0 transition group-hover:opacity-100"
          >
            <LinkIcon size={14} />
          </a>
        )}
      </Tag>
    );
  };
}

const HEADINGS = { h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4) };

function DocMarkdown({ markdown, section }: { markdown: string; section: string }) {
  // Stable per section: a new component type on every render would remount the page (and a code block's "Copied")
  const components = useMemo<Components>(
    () => ({
      ...HEADINGS,
      pre: ({ node, children }) => (
        <CodeBlock code={hastText(node as HastNode | undefined)}>{children}</CodeBlock>
      ),
      a: ({ href = '', children }) => {
        const target = resolveDocLink(href, { section });
        if (target.kind === 'external') {
          return (
            <a href={target.href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        }
        if (target.kind === 'anchor') return <a href={target.href}>{children}</a>;
        return <Link to={target.href}>{children}</Link>;
      },
      blockquote: ({ children, ...props }) => {
        const kind = (props as Record<string, unknown>)['data-callout'] as string | undefined;
        const style = kind ? CALLOUT_STYLE[kind] : undefined;
        if (!style) return <blockquote>{children}</blockquote>;
        const Icon = style.icon;
        return (
          <div
            role="note"
            data-callout={kind}
            className={cn(
              'my-5 flex gap-3 rounded-md border-l-4 px-4 py-1 text-sm not-italic [&_p]:my-2',
              style.box,
            )}
          >
            <Icon size={16} className="mt-2.5 shrink-0 opacity-70" />
            <div className="min-w-0">{children}</div>
          </div>
        );
      },
      table: ({ children }) => (
        <div className="my-5 overflow-x-auto">
          <table className="!my-0">{children}</table>
        </div>
      ),
    }),
    [section],
  );
  return (
    <div className="prose prose-sm dark:prose-invert sm:prose-base prose-headings:font-semibold prose-a:text-primary prose-code:before:content-none prose-code:after:content-none prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-pre:bg-transparent prose-pre:p-0 max-w-none [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkDocs]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

export default memo(DocMarkdown);
