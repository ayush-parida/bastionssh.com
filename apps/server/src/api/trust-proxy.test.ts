import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { untrustedForwardedForHook } from './trust-proxy.js';

async function appWith(trustProxy: boolean | number | string) {
  const app = Fastify({ trustProxy });
  const warn = vi.spyOn(app.log, 'warn');
  // Request loggers are children of app.log; route their warnings to the spy.
  vi.spyOn(app.log, 'child').mockReturnValue(app.log);
  const hook = untrustedForwardedForHook(trustProxy);
  if (hook) app.addHook('onRequest', hook);
  app.get('/', async () => ({ ok: true }));
  await app.ready();
  return { app, warn };
}

describe('untrustedForwardedForHook', () => {
  it('warns once when a forwarded request arrives and no proxy is trusted', async () => {
    const { app, warn } = await appWith(false);
    await app.inject({ url: '/' });
    expect(warn).not.toHaveBeenCalled();
    await app.inject({ url: '/', headers: { 'x-forwarded-for': '203.0.113.7' } });
    await app.inject({ url: '/', headers: { 'x-forwarded-for': '203.0.113.8' } });
    expect(warn).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('stays quiet once a proxy is trusted', async () => {
    const { app, warn } = await appWith(1);
    await app.inject({ url: '/', headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(warn).not.toHaveBeenCalled();
    await app.close();
  });
});
