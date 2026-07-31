import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireRole, ROLES, type Role } from './middleware.js';

/** Minimal reply double capturing the status/payload the guard sends. */
function mockReply() {
  const reply = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(payload: unknown) {
      reply.payload = payload;
      return reply;
    },
  };
  return reply;
}

function run(role: Role | undefined, minimum: Role) {
  const reply = mockReply();
  const req = { role } as FastifyRequest;
  return requireRole(minimum)(req, reply as unknown as FastifyReply).then(() => reply);
}

describe('requireRole', () => {
  it('allows a role that exactly matches the minimum', async () => {
    const reply = await run('operator', 'operator');
    expect(reply.statusCode).toBe(0);
  });

  it('allows a role above the minimum', async () => {
    for (const role of ['admin', 'owner'] as const) {
      const reply = await run(role, 'operator');
      expect(reply.statusCode).toBe(0);
    }
  });

  it('rejects a role below the minimum with 403', async () => {
    const reply = await run('viewer', 'operator');
    expect(reply.statusCode).toBe(403);
  });

  it('rejects viewers from admin routes', async () => {
    for (const role of ['viewer', 'operator'] as const) {
      const reply = await run(role, 'admin');
      expect(reply.statusCode).toBe(403);
    }
  });

  it('returns 401 when no role was resolved', async () => {
    const reply = await run(undefined, 'viewer');
    expect(reply.statusCode).toBe(401);
  });

  it('treats an unrecognized role as least privileged', async () => {
    const reply = await run('superuser' as Role, 'operator');
    expect(reply.statusCode).toBe(403);
  });

  it('orders roles least- to most-privileged', () => {
    expect(ROLES).toEqual(['viewer', 'operator', 'admin', 'owner']);
  });

  it('lets every role through a viewer-level gate', async () => {
    for (const role of ROLES) {
      const reply = await run(role, 'viewer');
      expect(reply.statusCode).toBe(0);
    }
  });
});
