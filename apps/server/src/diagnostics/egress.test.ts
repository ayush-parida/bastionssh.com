import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getEgressIp, lookupEgressIp, resetEgressIpCache } from './egress.js';

const SERVICES = ['https://api.ipify.org/', 'https://ifconfig.me/ip'];

function fakeFetch(answers: Record<string, string | Error | number>) {
  return vi.fn(async (input: string | URL | Request) => {
    const answer = answers[String(input)];
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'number') return new Response('nope', { status: answer });
    return new Response(answer ?? '', { status: 200 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('lookupEgressIp', () => {
  it('uses the first service that answers with an address', async () => {
    const fetchImpl = fakeFetch({ [SERVICES[0]!]: '49.43.168.212\n' });
    const info = await lookupEgressIp(SERVICES, fetchImpl);
    expect(info).toMatchObject({ ip: '49.43.168.212', source: 'lookup', service: SERVICES[0] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls through failing or nonsense answers to the next service', async () => {
    const fetchImpl = fakeFetch({ [SERVICES[0]!]: '<html>blocked</html>', [SERVICES[1]!]: '2001:db8::7' });
    const info = await lookupEgressIp(SERVICES, fetchImpl);
    expect(info).toMatchObject({ ip: '2001:db8::7', service: SERVICES[1] });
  });

  it('reports every failure when nothing answers', async () => {
    const fetchImpl = fakeFetch({ [SERVICES[0]!]: 503, [SERVICES[1]!]: new Error('fetch failed') });
    const info = await lookupEgressIp(SERVICES, fetchImpl);
    expect(info.ip).toBeNull();
    expect(info.source).toBe('unavailable');
    expect(info.error).toContain('api.ipify.org: HTTP 503');
    expect(info.error).toContain('ifconfig.me: fetch failed');
  });
});

describe('getEgressIp', () => {
  beforeEach(() => resetEgressIpCache());

  it('returns a configured address without looking anything up', async () => {
    const fetchImpl = fakeFetch({});
    const info = await getEgressIp({ settings: { mode: 'fixed', ip: '198.51.100.4' }, fetchImpl });
    expect(info).toEqual({ ip: '198.51.100.4', source: 'configured', checkedAt: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never looks up when disabled', async () => {
    const fetchImpl = fakeFetch({});
    const info = await getEgressIp({ settings: { mode: 'disabled' }, fetchImpl });
    expect(info.source).toBe('disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches a lookup, shares one in flight, and refreshes on request', async () => {
    const fetchImpl = fakeFetch({ [SERVICES[0]!]: '49.43.168.212' });
    const settings = { mode: 'lookup' as const, services: SERVICES };
    const [a, b] = await Promise.all([getEgressIp({ settings, fetchImpl }), getEgressIp({ settings, fetchImpl })]);
    expect(a.ip).toBe('49.43.168.212');
    expect(b).toBe(a);
    await getEgressIp({ settings, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await getEgressIp({ settings, fetchImpl, refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
