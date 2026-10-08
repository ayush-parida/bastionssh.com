import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEPLOY_DOCS, DEPLOY_TROUBLESHOOTING_ANCHORS, SERVICE_CATALOG } from '@smt/shared';
import { SERVICE_DOCS, serviceDocs } from './services.js';
import { DOCKER_DOCS } from './docker-upload.js';
import DocMarkdown from '@/components/docs/DocMarkdown.js';
import { DOC_SECTIONS } from '@/docs/sections.js';
import {
  DOC_ERRORS,
  DOCS,
  extractHeadings,
  findDoc,
  highlightRuns,
  inlineText,
  loadDocs,
  neighbours,
  parseDoc,
  parseFrontmatter,
  resolveDocLink,
  searchDocs,
  slugify,
  type DocPage,
} from './docs.js';
import { DEPLOY_LOG_HINTS, deployFailureHint, deployLogHint } from './deploy-help.js';

// React Router's Link uses useLayoutEffect, which React warns about when rendering to a string
beforeAll(() => {
  const error = console.error.bind(console);
  vi.spyOn(console, 'error').mockImplementation((message: unknown, ...rest: unknown[]) => {
    if (!String(message).includes('useLayoutEffect does nothing on the server')) error(message, ...rest);
  });
});

const page = (front: string, body = '# Hi\n') => `---\n${front}\n---\n${body}`;
const FRONT = 'title: A page\nsection: deployments\norder: 20\nsummary: One line.\nkeywords: [static, "next.js", out]';

/** What a page renders to (inside a router, as on the Docs page). */
function render(doc: DocPage): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <DocMarkdown markdown={doc.body} section={doc.section} />
    </MemoryRouter>,
  );
}

const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));

describe('frontmatter', () => {
  it('reads text, numbers, quoted text and lists', () => {
    const { data, body, errors } = parseFrontmatter(page(FRONT, 'Body\n'));
    expect(errors).toEqual([]);
    expect(data).toEqual({ title: 'A page', section: 'deployments', order: 20, summary: 'One line.', keywords: ['static', 'next.js', 'out'] });
    expect(body).toBe('Body\n');
  });

  it('keeps colons in values, and reads CRLF files', () => {
    const { data } = parseFrontmatter(page('title: Domains: and HTTPS\nsummary: "a: b"').replace(/\n/g, '\r\n'));
    expect(data.title).toBe('Domains: and HTTPS');
    expect(data.summary).toBe('a: b');
  });

  it('reports a missing or unclosed block and lines it cannot read', () => {
    expect(parseFrontmatter('# No frontmatter').errors).toEqual(['No frontmatter (the file must start with ---)']);
    expect(parseFrontmatter('---\ntitle: x\n').errors).toEqual(['The frontmatter has no closing ---']);
    expect(parseFrontmatter(page('title: x\n- y\ntitle: z')).errors).toEqual(['Cannot read frontmatter line: - y', 'title is set twice']);
  });

  it('turns a file into a page, or says what is wrong with it', () => {
    const { doc } = parseDoc('../docs/deployments/static-site.md', page(FRONT));
    expect(doc).toMatchObject({ slug: 'static-site', section: 'deployments', href: '/docs/deployments/static-site', keywords: ['static', 'next.js', 'out'] });
    expect(parseDoc('../docs/servers/x.md', page(FRONT)).errors).toContain('section is deployments but the file is in docs/servers/');
    expect(parseDoc('../docs/nowhere/x.md', page(FRONT.replace('deployments', 'nowhere'))).errors).toContain('Unknown section nowhere (add it to docs/sections.ts)');
    expect(parseDoc('../docs/deployments/Bad_Name.md', page(FRONT)).errors).toContain('The file name Bad_Name.md must be lower case words joined by -');
    expect(parseDoc('../docs/deployments/x.md', page('title: x\nsection: deployments\norder: first\nextra: 1')).errors).toEqual([
      'Missing summary',
      'order must be a number',
      'Unknown frontmatter key extra',
    ]);
  });

  it('sorts pages by section, then order, then title', () => {
    const { docs } = loadDocs({
      '../docs/deployments/b.md': page(FRONT.replace('order: 20', 'order: 5')),
      '../docs/deployments/a.md': page(FRONT),
      '../docs/getting-started/c.md': page(FRONT.replace('deployments', 'getting-started')),
    });
    expect(docs.map((d) => d.href)).toEqual(['/docs/getting-started/c', '/docs/deployments/b', '/docs/deployments/a']);
  });
});

describe('headings and anchors', () => {
  it('makes GitHub-style anchors, numbering repeats, and skips fenced code', () => {
    expect(slugify('Integrity check failed: Reinstall')).toBe('integrity-check-failed-reinstall');
    expect(inlineText('The `.next` folder is **not** the [site](x.md)')).toBe('The .next folder is not the site');
    const body = '## Setup\n\n```sh\n## not a heading\n```\n\n### `build.type`\n\n## Setup\n';
    expect(extractHeadings(body)).toEqual([
      { depth: 2, text: 'Setup', id: 'setup' },
      { depth: 3, text: 'build.type', id: 'buildtype' },
      { depth: 2, text: 'Setup', id: 'setup-1' },
    ]);
  });
});

describe('the docs', () => {
  it('every file has the required fields and is in a known section', () => {
    expect(DOC_ERRORS).toEqual([]);
    for (const doc of DOCS) {
      expect(doc.title, doc.href).not.toBe('');
      expect(doc.summary, doc.href).not.toBe('');
      expect(Number.isFinite(doc.order), doc.href).toBe(true);
      expect(DOC_SECTIONS.map((s) => s.id), doc.href).toContain(doc.section);
    }
  });

  it('slugs and titles are unique', () => {
    const hrefs = DOCS.map((d) => d.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const section of DOC_SECTIONS) {
      const titles = DOCS.filter((d) => d.section === section.id).map((d) => d.title);
      expect(new Set(titles).size, section.id).toBe(titles.length);
    }
  });

  it('section ids are unique', () => {
    expect(new Set(DOC_SECTIONS.map((s) => s.id)).size).toBe(DOC_SECTIONS.length);
  });

  it('renders every heading with the anchor its table of contents lists', () => {
    for (const doc of DOCS) {
      expect(ids(render(doc)), doc.href).toEqual(doc.headings.map((h) => h.id));
    }
  });

  it('has no broken links between pages, or to anchors in them', () => {
    const broken: string[] = [];
    for (const doc of DOCS) {
      for (const href of hrefs(render(doc))) {
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [path, hash] = href.split('#') as [string, string | undefined];
        const target = path === '' ? doc : path.startsWith('/docs/') ? findDoc(path.split('/')[2]!, path.split('/')[3]!) : undefined;
        if (path !== '' && !path.startsWith('/docs/')) continue; // a page of the app
        if (!target) broken.push(`${doc.href}: ${href} (no such page)`);
        else if (hash && !target.headings.some((h) => h.id === hash)) broken.push(`${doc.href}: ${href} (no such heading)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('the links the app makes into the deployment docs resolve', () => {
    for (const href of Object.values(DEPLOY_DOCS)) expect(findDoc('deployments', href.split('/')[3]!), href).toBeTruthy();
    const trouble = findDoc('deployments', 'troubleshooting')!;
    for (const anchor of Object.values(DEPLOY_TROUBLESHOOTING_ANCHORS)) {
      expect(trouble.headings.map((h) => h.id), anchor).toContain(anchor);
    }
  });

  it('every quick-service template has its docs page with an Upgrading section, and the service pages’ links resolve', () => {
    const hrefs = [...Object.values(SERVICE_DOCS), ...SERVICE_CATALOG.flatMap((t) => [serviceDocs(t.docs), serviceDocs(t.docs, 'upgrading'), ...(t.backup ? [] : [serviceDocs(t.docs, 'backups')])]), SERVICE_DOCS.rollbackLines];
    for (const href of hrefs) {
      const [path, hash] = href.split('#') as [string, string | undefined];
      const doc = findDoc(path.split('/')[2]!, path.split('/')[3]!);
      expect(doc, href).toBeTruthy();
      if (hash) expect(doc!.headings.map((h) => h.id), href).toContain(hash);
    }
    // The catalog page names every template
    const overview = findDoc('deployments', 'services-overview')!;
    for (const t of SERVICE_CATALOG) expect(overview.text, t.name).toContain(t.name);
  });

  it('the links the app makes into the Docker docs resolve, anchors included', () => {
    for (const href of Object.values(DOCKER_DOCS)) {
      const [path, hash] = href.split('#') as [string, string | undefined];
      const doc = findDoc(path.split('/')[2]!, path.split('/')[3]!);
      expect(doc, href).toBeTruthy();
      if (hash) expect(doc!.headings.map((h) => h.id), href).toContain(hash);
    }
  });

  it('renders callouts, copyable code blocks and links between pages', () => {
    const doc = findDoc('deployments', 'static-site')!;
    const html = render(doc);
    expect(html).toMatch(/<div role="note" data-callout="tip"/);
    expect(html).toMatch(/data-callout="warning"/);
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('href="/docs/deployments/nextjs-dynamic"');
  });

  it('every page has a next or previous page', () => {
    for (const doc of DOCS) {
      const { prev, next } = neighbours(doc);
      expect(prev ?? next, doc.href).toBeTruthy();
    }
  });
});

describe('links', () => {
  it('resolves page paths, files relative to the page, anchors and outside links', () => {
    const from = { section: 'deployments' };
    expect(resolveDocLink('static-site.md#which-folder-to-upload', from)).toEqual({
      kind: 'doc',
      section: 'deployments',
      slug: 'static-site',
      hash: 'which-folder-to-upload',
      href: '/docs/deployments/static-site#which-folder-to-upload',
    });
    expect(resolveDocLink('../servers/add-a-server.md', from)).toMatchObject({ kind: 'doc', href: '/docs/servers/add-a-server' });
    expect(resolveDocLink('/docs/docker/compose', from)).toMatchObject({ kind: 'doc', section: 'docker', slug: 'compose' });
    expect(resolveDocLink('#setup', from)).toEqual({ kind: 'anchor', hash: 'setup', href: '#setup' });
    expect(resolveDocLink('https://letsencrypt.org', from).kind).toBe('external');
    expect(resolveDocLink('/servers', from)).toEqual({ kind: 'app', href: '/servers' });
  });
});

describe('search', () => {
  it('finds pages by title, keywords, summary and text, every word required', () => {
    const results = searchDocs('static');
    expect(results[0]!.doc.href).toBe('/docs/deployments/static-site');
    expect(searchDocs('standalone dockerfile').map((r) => r.doc.slug)).toContain('nextjs-dynamic');
    expect(searchDocs('static zzzznotaword')).toEqual([]);
    expect(searchDocs('   ')).toEqual([]);
  });

  it('gives a snippet around the match and the heading to land on', () => {
    const [first] = searchDocs('missing script');
    expect(first!.doc.slug).toBe('troubleshooting');
    expect(first!.heading?.id).toBe('missing-script-build');
    expect(first!.snippet.toLowerCase()).toContain('missing');
  });

  it('marks every term in a text, ignoring case', () => {
    expect(highlightRuns('Deploy a Static site', ['static', 'site'])).toEqual([
      { text: 'Deploy a ', match: false },
      { text: 'Static', match: true },
      { text: ' ', match: false },
      { text: 'site', match: true },
    ]);
    expect(highlightRuns('a.b', ['.'])).toEqual([
      { text: 'a', match: false },
      { text: '.', match: true },
      { text: 'b', match: false },
    ]);
  });
});

describe('deploy log hints', () => {
  it('links known failures to their troubleshooting section', () => {
    expect(deployLogHint('npm error Missing script: "build"')?.href).toBe(`${DEPLOY_DOCS.troubleshooting}#missing-script-build`);
    expect(deployLogHint("Next.js apps are deployed from Next's standalone output. Add output: 'standalone'")?.href).toContain('#standalone-output-required');
    expect(deployLogHint('Health check failed after 30s: no answer')?.href).toContain('#health-check-failed');
    expect(deployLogHint('Ports 80/443 are taken by something else on this server')?.href).toContain('#ports-80-or-443-already-in-use');
    expect(deployLogHint('The bastionctl on this server is not the version this BastionSSH ships')?.href).toContain('#integrity-check-failed-reinstall');
    expect(deployLogHint('ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 137')?.href).toContain('#build-ran-out-of-memory');
    expect(deployLogHint("This is Next's .next build folder, not a static export.")?.href).toContain('#uploaded-a-nextjs-build-folder');
    expect(deployLogHint('Step 3/9 : RUN npm ci')).toBeNull();
    // MongoDB 8 on a 6.19+ kernel: bastionctl's refusal, and mongod's own message when it got to start (ahead of the health check it fails)
    const kernel = `${DEPLOY_DOCS.troubleshooting}#${DEPLOY_TROUBLESHOOTING_ANCHORS.mongodbKernel}`;
    expect(deployLogHint("MongoDB 8.0 will not start on this server's Linux kernel 7.0.0-1012-aws: MongoDB 8 refuses …")?.href).toBe(kernel);
    const mongod = '{"t":{"$date":"2026-10-08T12:00:00Z"},"s":"F","msg":"MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility with this version of MongoDB"}';
    expect(deployLogHint(mongod)?.href).toBe(kernel);
    expect(deployFailureHint(`The new container stopped (exit code 14). Its last lines:\n${mongod}`, [])?.href).toBe(kernel);
    expect(deployFailureHint(null, [{ text: mongod }, { text: 'Deploy failed' }])?.href).toBe(kernel);
    for (const hint of DEPLOY_LOG_HINTS) expect(findDoc('deployments', 'troubleshooting')!.headings.map((h) => `#${h.id}`)).toContain(hint.href.slice(hint.href.indexOf('#')));
  });
});
