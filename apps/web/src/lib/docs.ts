import { DOC_SECTIONS, docSection } from '@/docs/sections.js';

/**
 * The in-app docs: markdown files at `src/docs/<section>/<slug>.md`, bundled
 * at build time, with a small frontmatter block:
 *
 * ```
 * ---
 * title: Deploy a static Next.js site
 * section: deployments
 * order: 20
 * summary: One sentence shown in lists and search.
 * keywords: [static, export, out, next.js]
 * ---
 * ```
 *
 * Nothing here is fetched or depends on the signed-in member: the docs are
 * the same for everyone and reveal nothing about an organization.
 */

export interface DocFrontmatter {
  title: string;
  section: string;
  order: number;
  summary: string;
  keywords: string[];
}

export interface DocHeading {
  depth: number;
  text: string;
  id: string;
}

export interface DocPage extends DocFrontmatter {
  slug: string;
  /** `/docs/<section>/<slug>` */
  href: string;
  /** The markdown after the frontmatter. */
  body: string;
  /** Every heading, with the id it renders with. */
  headings: DocHeading[];
  /** The body as plain text, for search. */
  text: string;
}

export interface DocLoadError {
  file: string;
  message: string;
}

// ── Frontmatter ───────────────────────────────────────────────────────────────

type FrontValue = string | number | string[];

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

function scalar(raw: string): FrontValue {
  const v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map(unquote).filter(Boolean);
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return unquote(v);
}

/**
 * Split `---`-fenced frontmatter from the body. Only `key: value` lines,
 * where a value is text (optionally quoted), a number, or `[a, b]`.
 */
export function parseFrontmatter(raw: string): { data: Record<string, FrontValue>; body: string; errors: string[] } {
  const text = raw.replace(/\r\n?/g, '\n');
  const data: Record<string, FrontValue> = {};
  const errors: string[] = [];
  if (!text.startsWith('---\n')) return { data, body: text, errors: ['No frontmatter (the file must start with ---)'] };
  const end = text.indexOf('\n---', 3);
  if (end === -1 || (text[end + 4] !== undefined && text[end + 4] !== '\n')) return { data, body: text, errors: ['The frontmatter has no closing ---'] };
  const lines = text.slice(4, end).split('\n');
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      errors.push(`Cannot read frontmatter line: ${line}`);
      continue;
    }
    if (m[1]! in data) errors.push(`${m[1]} is set twice`);
    data[m[1]!] = scalar(m[2]!);
  }
  return { data, body: text.slice(end + 4).replace(/^\n/, ''), errors };
}

// ── Headings and anchors ──────────────────────────────────────────────────────

/** Inline markdown to the text it shows: `code`, **bold**, [link](url) → their words. */
export function inlineText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .trim();
}

/** A heading's anchor, as GitHub makes them: lower case, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Anchors in document order, a repeated one numbered (`setup`, `setup-1`). */
export class Slugger {
  private seen = new Map<string, number>();
  slug(text: string): string {
    const base = slugify(text);
    let id = base;
    let n = this.seen.get(base) ?? 0;
    while (this.seen.has(id)) id = `${base}-${++n}`;
    this.seen.set(base, n);
    this.seen.set(id, 0);
    return id;
  }
}

/** ATX headings (`## Title`) outside fenced code, with their anchors. */
export function extractHeadings(body: string): DocHeading[] {
  const slugger = new Slugger();
  const out: DocHeading[] = [];
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^#{1,6}(?=\s)/.exec(line);
    if (!m) continue;
    const text = inlineText(line.slice(m[0].length).replace(/\s+#+\s*$/, ''));
    out.push({ depth: m[0].length, text, id: slugger.slug(text) });
  }
  return out;
}

/** Markdown as plain words, for search: no fences, markers or link targets. */
export function plainText(body: string): string {
  return inlineText(
    body
      .replace(/^\s*(```|~~~).*$/gm, ' ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, ' ')
      .replace(/\|/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n');
}

// ── Loading ───────────────────────────────────────────────────────────────────

const REQUIRED = ['title', 'section', 'order', 'summary'] as const;

/** One markdown file (`…/docs/<section>/<slug>.md`) as a page, or why it cannot be one. */
export function parseDoc(file: string, raw: string): { doc: DocPage | null; errors: string[] } {
  const m = /(?:^|\/)docs\/([^/]+)\/([^/]+)\.md$/.exec(file);
  if (!m) return { doc: null, errors: ['Docs live at docs/<section>/<slug>.md'] };
  const [, folder, slug] = m as unknown as [string, string, string];
  const { data, body, errors } = parseFrontmatter(raw);
  for (const key of REQUIRED) if (data[key] === undefined || data[key] === '') errors.push(`Missing ${key}`);
  if (data.title !== undefined && typeof data.title !== 'string') errors.push('title must be text');
  if (data.summary !== undefined && typeof data.summary !== 'string') errors.push('summary must be text');
  if (data.order !== undefined && typeof data.order !== 'number') errors.push('order must be a number');
  if (data.keywords !== undefined && !Array.isArray(data.keywords)) errors.push('keywords must be a list like [a, b]');
  if (typeof data.section === 'string' && data.section !== folder) errors.push(`section is ${data.section} but the file is in docs/${folder}/`);
  if (!docSection(folder)) errors.push(`Unknown section ${folder} (add it to docs/sections.ts)`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) errors.push(`The file name ${slug}.md must be lower case words joined by -`);
  for (const key of Object.keys(data)) if (![...REQUIRED, 'keywords'].includes(key)) errors.push(`Unknown frontmatter key ${key}`);
  if (errors.length > 0) return { doc: null, errors };
  return {
    doc: {
      title: data.title as string,
      section: folder,
      order: data.order as number,
      summary: data.summary as string,
      keywords: (data.keywords as string[] | undefined) ?? [],
      slug,
      href: `/docs/${folder}/${slug}`,
      body,
      headings: extractHeadings(body),
      text: plainText(body),
    },
    errors: [],
  };
}

/** Pages from `{ path: markdown }`, sorted by section, then order, then title. */
export function loadDocs(files: Record<string, string>): { docs: DocPage[]; errors: DocLoadError[] } {
  const docs: DocPage[] = [];
  const errors: DocLoadError[] = [];
  for (const [file, raw] of Object.entries(files)) {
    const parsed = parseDoc(file, raw);
    if (parsed.doc) docs.push(parsed.doc);
    else errors.push(...parsed.errors.map((message) => ({ file, message })));
  }
  const sectionOrder = (id: string) => docSection(id)?.order ?? Number.MAX_SAFE_INTEGER;
  docs.sort((a, b) => sectionOrder(a.section) - sectionOrder(b.section) || a.order - b.order || a.title.localeCompare(b.title));
  return { docs, errors };
}

const loaded = loadDocs(import.meta.glob<string>('../docs/**/*.md', { query: '?raw', import: 'default', eager: true }));

/** Every page, in navigation order. Files that cannot be read are left out (the docs tests fail on them). */
export const DOCS: readonly DocPage[] = loaded.docs;
export const DOC_ERRORS: readonly DocLoadError[] = loaded.errors;

if (DOC_ERRORS.length > 0 && import.meta.env.DEV) console.warn('Docs left out:', DOC_ERRORS);

/** Sections that have pages, each with its pages in order. */
export function docTree(docs: readonly DocPage[] = DOCS) {
  return DOC_SECTIONS.map((section) => ({ section, pages: docs.filter((d) => d.section === section.id) })).filter((s) => s.pages.length > 0);
}

export function findDoc(section: string, slug: string, docs: readonly DocPage[] = DOCS): DocPage | undefined {
  return docs.find((d) => d.section === section && d.slug === slug);
}

/** The page before and after `doc` in navigation order. */
export function neighbours(doc: DocPage, docs: readonly DocPage[] = DOCS): { prev: DocPage | null; next: DocPage | null } {
  const i = docs.indexOf(doc);
  return { prev: i > 0 ? docs[i - 1]! : null, next: i >= 0 && i < docs.length - 1 ? docs[i + 1]! : null };
}

// ── Links ─────────────────────────────────────────────────────────────────────

export type DocLinkTarget =
  | { kind: 'external'; href: string }
  /** Another page of the docs (or this one), with an optional anchor. */
  | { kind: 'doc'; section: string; slug: string; hash: string; href: string }
  | { kind: 'anchor'; hash: string; href: string }
  /** A page of the app outside the docs. */
  | { kind: 'app'; href: string };

/**
 * Where a link in a page goes. Pages link to each other as `/docs/<section>/<slug>#anchor`,
 * or by file: `other.md`, `./other.md#anchor`, `../servers/add-a-server.md`.
 */
export function resolveDocLink(href: string, from: { section: string }): DocLinkTarget {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return { kind: 'external', href };
  const hashAt = href.indexOf('#');
  const path = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : href.slice(hashAt + 1);
  if (path === '') return { kind: 'anchor', hash, href };
  const withHash = (p: string) => (hash ? `${p}#${hash}` : p);
  const docPath = /^\/docs\/([^/]+)\/([^/]+?)\/?$/.exec(path);
  if (docPath) return { kind: 'doc', section: docPath[1]!, slug: docPath[2]!, hash, href: withHash(`/docs/${docPath[1]}/${docPath[2]}`) };
  if (path.endsWith('.md') && !path.startsWith('/')) {
    const segments = [from.section];
    for (const seg of path.slice(0, -3).split('/')) {
      if (seg === '..') segments.pop();
      else if (seg !== '.' && seg !== '') segments.push(seg);
    }
    if (segments.length === 2) {
      const [section, slug] = segments as [string, string];
      return { kind: 'doc', section, slug, hash, href: withHash(`/docs/${section}/${slug}`) };
    }
  }
  return { kind: 'app', href };
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface DocSearchResult {
  doc: DocPage;
  score: number;
  /** A stretch of the page around the first match. */
  snippet: string;
  /** The first heading that matches, to land on. */
  heading: DocHeading | null;
}

export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

function snippetAround(text: string, terms: string[], width = 160): string {
  const lower = text.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return text.slice(0, width).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

const occurrences = (haystack: string, needle: string, cap: number) => {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1 && n < cap; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
};

/**
 * Pages matching every word of `query` (in the title, summary, keywords,
 * headings or text), best first: a word in the title counts most, then the
 * keywords, the summary, the headings, and how often it is in the text.
 */
export function searchDocs(query: string, docs: readonly DocPage[] = DOCS, limit = 20): DocSearchResult[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const results: DocSearchResult[] = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    const summary = doc.summary.toLowerCase();
    const keywords = doc.keywords.map((k) => k.toLowerCase());
    const headings = doc.headings.map((h) => h.text.toLowerCase());
    const text = doc.text.toLowerCase();
    let score = 0;
    let all = true;
    for (const term of terms) {
      let s = 0;
      if (title.includes(term)) s += title.split(/\W+/).includes(term) ? 12 : 8;
      if (keywords.some((k) => k === term)) s += 8;
      else if (keywords.some((k) => k.includes(term))) s += 5;
      if (summary.includes(term)) s += 4;
      if (headings.some((h) => h.includes(term))) s += 3;
      s += occurrences(text, term, 5);
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all) continue;
    const heading = doc.headings.find((h) => h.depth >= 2 && terms.some((t) => h.text.toLowerCase().includes(t))) ?? null;
    results.push({ doc, score, snippet: snippetAround(doc.text, terms), heading });
  }
  return results.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title)).slice(0, limit);
}

/** `text` split into runs, `match` where one of `terms` is (case-insensitive), for highlighting. */
export function highlightRuns(text: string, terms: string[]): { text: string; match: boolean }[] {
  const words = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return [{ text, match: false }];
  const re = new RegExp(`(${words.sort((a, b) => b.length - a.length).join('|')})`, 'gi');
  // With one capturing group, split puts the matches at the odd indexes
  return text
    .split(re)
    .map((part, i) => ({ text: part, match: i % 2 === 1 }))
    .filter((run) => run.text !== '');
}
