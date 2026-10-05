import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { BookOpen, ChevronLeft, ChevronRight, Menu, Search, X } from 'lucide-react';
import { docSection } from '@/docs/sections.js';
import { docTree, DOCS, findDoc, highlightRuns, neighbours, searchDocs, searchTerms, type DocPage } from '@/lib/docs.js';
import { cn } from '@/lib/utils.js';
import DocMarkdown from '@/components/docs/DocMarkdown.js';

/**
 * The in-app docs at `/docs` and `/docs/:section/:slug` (lib/docs.ts). Open
 * to every signed-in member whatever their roles: the pages are bundled with
 * the app and show nothing about the organization.
 */

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightRuns(text, terms).map((run, i) =>
        run.match ? (
          <mark key={i} className="rounded-sm bg-amber-200/80 px-0.5 text-inherit dark:bg-amber-500/30">
            {run.text}
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

function SearchBox({ onPick }: { onPick: () => void }) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const results = useMemo(() => searchDocs(query), [query]);
  const terms = searchTerms(query);
  const open = (r: (typeof results)[number]) => {
    navigate(r.heading ? `${r.doc.href}#${r.heading.id}` : r.doc.href);
    setQuery('');
    onPick();
  };
  return (
    <div className="relative">
      <label className="flex items-center gap-2 rounded-md border border-input bg-background px-2.5 py-1.5">
        <Search size={14} className="shrink-0 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results[0]) open(results[0]);
            if (e.key === 'Escape') setQuery('');
          }}
          placeholder="Search the docs"
          aria-label="Search the docs"
          className="w-full min-w-0 bg-transparent text-sm focus:outline-none"
        />
      </label>
      {terms.length > 0 && (
        <div
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 right-0 z-30 mt-1 max-h-[70vh] overflow-y-auto rounded-md border border-border bg-card shadow-lg md:w-[28rem]"
        >
          {results.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">Nothing matches “{query.trim()}”.</p>
          ) : (
            results.map((r) => (
              <button
                key={r.doc.href}
                role="option"
                aria-selected={false}
                onClick={() => open(r)}
                className="block w-full border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted"
              >
                <span className="block text-xs text-muted-foreground">{docSection(r.doc.section)?.title}</span>
                <span className="block text-sm font-medium">
                  <Highlight text={r.doc.title} terms={terms} />
                </span>
                <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                  <Highlight text={r.snippet} terms={terms} />
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function DocsNav({ current, onPick }: { current: DocPage | null; onPick: () => void }) {
  return (
    <nav aria-label="Docs" className="space-y-5">
      {docTree().map(({ section, pages }) => {
        const Icon = section.icon;
        return (
          <div key={section.id}>
            <p className="mb-1.5 flex items-center gap-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Icon size={13} /> {section.title}
            </p>
            <ul className="space-y-0.5">
              {pages.map((page) => (
                <li key={page.href}>
                  <Link
                    to={page.href}
                    onClick={onPick}
                    aria-current={current === page ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-2 py-1 text-sm transition-colors',
                      current === page ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {page.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** "On this page": the page's ## and ### headings, the one being read highlighted. */
function Toc({ doc }: { doc: DocPage }) {
  const items = useMemo(() => doc.headings.filter((h) => h.depth === 2 || h.depth === 3), [doc]);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: '0px 0px -70% 0px' },
    );
    for (const h of items) {
      const el = document.getElementById(h.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);
  if (items.length < 2) return null;
  return (
    <nav aria-label="On this page" className="text-sm">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">On this page</p>
      <ul className="space-y-1 border-l border-border">
        {items.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={cn(
                '-ml-px block border-l py-0.5 transition-colors',
                h.depth === 3 ? 'pl-6' : 'pl-3',
                active === h.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function DocsHome() {
  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <BookOpen size={24} className="text-primary" />
        <h1 className="text-2xl font-bold">Docs</h1>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">How BastionSSH works and how to get things done with it. Search above, or start from a section.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {docTree().map(({ section, pages }) => {
          const Icon = section.icon;
          return (
            <section key={section.id} aria-label={section.title} className="rounded-lg border border-border bg-card p-4">
              <h2 className="flex items-center gap-2 font-semibold">
                <Icon size={16} className="text-primary" /> {section.title}
              </h2>
              <p className="mb-3 mt-1 text-xs text-muted-foreground">{section.description}</p>
              <ul className="space-y-1.5">
                {pages.map((page) => (
                  <li key={page.href}>
                    <Link to={page.href} className="text-sm font-medium text-primary hover:underline">
                      {page.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">{page.summary}</p>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {DOCS.length === 0 && <p className="text-sm text-muted-foreground">No pages yet.</p>}
    </div>
  );
}

function Article({ doc }: { doc: DocPage }) {
  const { prev, next } = neighbours(doc);
  const section = docSection(doc.section);
  return (
    <article>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-primary">{section?.title}</p>
      <h1 className="mb-2 text-3xl font-bold tracking-tight">{doc.title}</h1>
      <p className="mb-6 text-muted-foreground">{doc.summary}</p>
      <DocMarkdown markdown={doc.body} section={doc.section} />
      <nav aria-label="Previous and next" className="mt-10 grid gap-3 border-t border-border pt-6 sm:grid-cols-2">
        {prev ? (
          <Link to={prev.href} rel="prev" className="rounded-lg border border-border p-3 hover:bg-muted/50">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <ChevronLeft size={12} /> Previous
            </span>
            <span className="text-sm font-medium">{prev.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link to={next.href} rel="next" className="rounded-lg border border-border p-3 text-right hover:bg-muted/50">
            <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
              Next <ChevronRight size={12} />
            </span>
            <span className="text-sm font-medium">{next.title}</span>
          </Link>
        )}
      </nav>
    </article>
  );
}

export default function DocsPage() {
  const { section, slug } = useParams<{ section?: string; slug?: string }>();
  const { hash, pathname } = useLocation();
  const [menu, setMenu] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const doc = section && slug ? (findDoc(section, slug) ?? null) : null;
  const missing = !!section && !doc;

  // A new page starts at its top, or at the heading its link names (deep links too)
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    if (target) target.scrollIntoView();
    else top.current?.scrollIntoView();
  }, [pathname, hash]);

  useEffect(() => {
    document.title = doc ? `${doc.title} · Docs` : 'Docs';
  }, [doc]);

  return (
    <div ref={top} className="mx-auto flex max-w-7xl gap-8 p-4 md:p-6">
      <div className={cn('w-full shrink-0 md:block md:w-56', menu ? 'fixed inset-0 z-40 overflow-y-auto bg-background p-4 md:static md:p-0' : 'hidden')}>
        <div className="md:sticky md:top-0 md:max-h-[calc(100vh-3rem)] md:overflow-y-auto md:pb-6">
          <div className="mb-4 flex items-center gap-2">
            <Link to="/docs" onClick={() => setMenu(false)} className="flex items-center gap-2 font-semibold">
              <BookOpen size={16} className="text-primary" /> Docs
            </Link>
            <button onClick={() => setMenu(false)} aria-label="Close menu" className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted md:hidden">
              <X size={16} />
            </button>
          </div>
          <DocsNav current={doc} onPick={() => setMenu(false)} />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-6 flex items-center gap-2">
          <button
            onClick={() => setMenu(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted md:hidden"
          >
            <Menu size={14} /> Menu
          </button>
          <div className="min-w-0 flex-1 md:max-w-md">
            <SearchBox onPick={() => setMenu(false)} />
          </div>
        </div>
        {missing ? (
          <div>
            <h1 className="mb-2 text-2xl font-bold">Page not found</h1>
            <p className="mb-4 text-sm text-muted-foreground">There is no docs page at this address. It may have moved; search for it, or start from the docs home.</p>
            <Link to="/docs" className="text-sm text-primary hover:underline">
              Docs home
            </Link>
          </div>
        ) : doc ? (
          <div className="flex gap-10">
            <div className="min-w-0 max-w-3xl flex-1">
              <Article doc={doc} />
            </div>
            <div className="hidden w-56 shrink-0 xl:block">
              <div className="sticky top-6">
                <Toc doc={doc} />
              </div>
            </div>
          </div>
        ) : (
          <DocsHome />
        )}
      </div>
    </div>
  );
}
