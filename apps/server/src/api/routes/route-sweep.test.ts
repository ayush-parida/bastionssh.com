import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * The route sweep (unified roles spec §8): every route the app registers,
 * read as Fastify registers it (an `onRoute` hook on the root instance, which
 * every plugin inherits), with the preHandlers it runs — the plugin's hooks
 * and its own.
 *
 * - Every route is public (sign-in, invites, health, the agent's own
 *   endpoints), the caller's own account, or gated on a module: no route is
 *   left to a base role (`requireRole` is gone) or to nothing.
 * - A member holding only No access gets 404 on every route that is not
 *   their own account, so a route added later without a module gate fails
 *   here.
 *
 * Nothing reaches the network: the org has no servers, clusters or
 * connections, and every id in a path is a placeholder.
 */
const captured = vi.hoisted(() => ({
  routes: [] as { method: string[]; url: string; preHandler: unknown; onRequest: unknown; instance: object; websocket: boolean }[],
}));

vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fastify')>();
  const factory = ((opts?: object) => {
    const app = actual.default(opts as never);
    app.addHook('onRoute', function (this: object, route) {
      captured.routes.push({
        method: ([] as string[]).concat(route.method),
        url: route.url,
        preHandler: route.preHandler,
        onRequest: route.onRequest,
        instance: this,
        websocket: !!(route as { websocket?: boolean }).websocket,
      });
    });
    return app;
  }) as unknown as typeof actual.default;
  return { ...actual, default: factory };
});

import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { runMigrations } from '../../db/migrate.js';
import { getDb } from '../../db/index.js';
import { roleMembers } from '../../db/schema.js';
import { seedOrg, seedUser } from './test-utils.js';

/** Reachable without signing in: signing in, invites, password resets, health, the agent's own endpoints. */
const PUBLIC = [
  /^\*$/,
  /^\/(healthz|readyz|metrics)$/,
  /^\/api\/auth\/login(\/|$)/,
  /^\/api\/auth\/passkey\/(options|verify)$/,
  /^\/api\/auth\/sso\//,
  /^\/api\/invites\//,
  /^\/api\/password-reset\//,
  // The agent authenticates with its own token; the install script and bundle are public downloads
  /^\/api\/agents\/(connect|install\.sh|bastion-agent\.cjs)$/,
];

/**
 * The caller's own account (spec §2.3: what a No access member keeps):
 * profile, password, sessions, devices, passkeys, backup codes, API tokens,
 * switching org, what they hold (/api/me, their own levels), the org's
 * sign-in policy that applies to them, and asking for access.
 */
const ACCOUNT = [
  /^\/api\/auth\//,
  /^\/api\/me\//,
  /^\/api\/tokens(\/|$)/,
  /^GET \/api\/team\/settings$/,
  /^GET \/api\/team\/access\/mine$/,
  /^(GET|POST) \/api\/access-requests$/,
  /^GET \/api\/access-requests\/(settings|servers|clusters|requestable)$/,
  /^POST \/api\/access-requests\/:id\/cancel$/,
];

/** The preHandlers that gate a route on a module (spec §4.1). */
const MODULE_GUARDS = new Set(['moduleGuard', 'anyModuleGuard', 'dockerModuleGuard', 'requireRoleList']);

interface Route {
  method: string;
  url: string;
  guards: string[];
  websocket: boolean;
}

function names(hooks: unknown): string[] {
  return ([] as unknown[]).concat(hooks ?? []).map((f) => (typeof f === 'function' && f.name) || '<anonymous>');
}

/** The hooks a plugin instance added, read after `ready` so ones added after its routes count too. */
function instanceHooks(instance: object, kind: 'onRequest' | 'preHandler'): string[] {
  const key = Object.getOwnPropertySymbols(instance).find((s) => s.description === 'fastify.hooks');
  const hooks = key ? (instance as Record<symbol, Record<string, unknown>>)[key] : undefined;
  return names(hooks?.[kind]);
}

describe('route sweep', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let routes: Route[];

  let requests = 0;
  const call = (headers: Record<string, string>, method: string, url: string) => {
    requests++;
    return app.inject({
      method: method as 'GET',
      url,
      headers,
      // Each request from its own address, so the sweep stays under the per-IP rate limit
      remoteAddress: `10.${(requests >> 16) & 255}.${(requests >> 8) & 255}.${requests & 255}`,
      ...(method !== 'GET' && method !== 'DELETE' && { payload: {} }),
    });
  };

  const key = (r: Pick<Route, 'method' | 'url'>) => `${r.method} ${r.url}`;
  const isPublic = (r: Route) => PUBLIC.some((p) => p.test(r.url));
  const isAccount = (r: Route) => ACCOUNT.some((p) => p.test(r.url) || p.test(key(r)));

  beforeAll(async () => {
    await runMigrations();
    orgId = seedOrg('org-route-sweep');
    app = await buildApp();
    await app.ready();
    routes = captured.routes.flatMap((r) =>
      r.method
        .filter((m) => m !== 'HEAD' && m !== 'OPTIONS')
        .map((method) => ({
          method,
          url: r.url,
          guards: [
            ...instanceHooks(r.instance, 'onRequest'),
            ...instanceHooks(r.instance, 'preHandler'),
            ...names(r.onRequest),
            ...names(r.preHandler),
          ],
          websocket: r.websocket,
        })),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('finds every route the app registers', () => {
    expect(routes.length).toBeGreaterThan(250);
    for (const prefix of ['/api/servers', '/api/kube', '/api/docker', '/api/team', '/api/audit', '/api/ai', '/api/agents', '/api/admin/backups']) {
      expect(routes.some((r) => r.url.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it('leaves no route to a base role or to nothing: each is public, the caller’s own account, or gated on a module', () => {
    const wrong: string[] = [];
    for (const route of routes) {
      if (route.guards.includes('roleGuard')) wrong.push(`${key(route)}: requireRole`);
      if (isPublic(route)) {
        if (route.guards.includes('requireAuth')) wrong.push(`${key(route)}: listed as public but signs in`);
        continue;
      }
      if (!route.guards.includes('requireAuth')) {
        wrong.push(`${key(route)}: not signed in, and not listed as public`);
        continue;
      }
      if (isAccount(route)) continue;
      if (!route.guards.some((g) => MODULE_GUARDS.has(g))) wrong.push(`${key(route)}: no module gate (${route.guards.join(', ')})`);
    }
    expect(wrong).toEqual([]);
  });

  it('gives a No access member 404 on every route but their own account', async () => {
    const nobody = seedUser(orgId, 'viewer');
    getDb().delete(roleMembers).where(and(eq(roleMembers.userId, nobody.userId), eq(roleMembers.orgId, orgId))).run();
    getDb().insert(roleMembers).values({ roleId: `builtin:${orgId}:none`, userId: nobody.userId, orgId }).run();
    expect((await call(nobody.headers, 'GET', '/api/me/modules')).json()).toEqual({ modules: [] });

    const swept = routes.filter((r) => !isPublic(r) && !isAccount(r));
    expect(swept.length).toBeGreaterThan(200);
    const wrong: string[] = [];
    for (const route of swept) {
      const url = route.url.replace(/:[A-Za-z]+/g, 'x').replace(/\*$/, 'x');
      const res = await call(nobody.headers, route.method, url);
      if (res.statusCode !== 404) wrong.push(`${key(route)} → ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);

    // …while their own account still answers
    for (const url of ['/api/auth/me', '/api/me/access', '/api/tokens', '/api/auth/sessions']) {
      expect((await call(nobody.headers, 'GET', url)).statusCode, url).toBe(200);
    }
  });
});
