import { describe, it, expect } from 'vitest';
import type { DnsResolverAnswer } from '@smt/shared';
import { compareAnswers, signature } from './propagation.js';

const answer = (over: Partial<DnsResolverAnswer>): DnsResolverAnswer => ({
  name: 'Cloudflare',
  address: '1.1.1.1',
  authoritative: false,
  addresses: ['1.2.3.4'],
  agrees: true,
  ...over,
});

describe('signature', () => {
  it('ignores ordering, so the same set from two resolvers matches', () => {
    expect(signature(['1.2.3.4', '5.6.7.8'])).toBe(signature(['5.6.7.8', '1.2.3.4']));
  });
});

describe('compareAnswers', () => {
  it('calls it consistent when everyone returns the same set', () => {
    const result = compareAnswers([
      answer({}),
      answer({ name: 'Google', address: '8.8.8.8' }),
      answer({ name: 'ns1.example.com', authoritative: true, addresses: ['1.2.3.4'] }),
    ]);
    expect(result.consistent).toBe(true);
    expect(result.answers.every((a) => a.agrees)).toBe(true);
  });

  it('flags the minority when a change has not propagated', () => {
    const result = compareAnswers([
      answer({ addresses: ['1.2.3.4'] }),
      answer({ name: 'Google', addresses: ['1.2.3.4'] }),
      answer({ name: 'Quad9', addresses: ['9.9.9.9'] }),
    ]);
    expect(result.consistent).toBe(false);
    expect(result.answers.map((a) => a.agrees)).toEqual([true, true, false]);
  });

  it('treats failures and empty answers as neither agreeing nor disagreeing', () => {
    const result = compareAnswers([
      answer({ addresses: ['1.2.3.4'] }),
      answer({ name: 'Google', addresses: [], error: 'The nameserver did not answer in time' }),
      answer({ name: 'Quad9', addresses: [] }),
    ]);
    expect(result.answers.map((a) => a.agrees)).toEqual([true, true, true]);
    expect(result.consistent).toBe(true);
  });

  it('survives every resolver failing', () => {
    const result = compareAnswers([answer({ addresses: [], error: 'SERVFAIL' })]);
    expect(result.consistent).toBe(true);
    expect(result.answers[0]!.agrees).toBe(true);
  });

  it('sides with the majority, not the first answer', () => {
    const result = compareAnswers([
      answer({ addresses: ['9.9.9.9'] }),
      answer({ name: 'Google', addresses: ['1.2.3.4'] }),
      answer({ name: 'Quad9', addresses: ['1.2.3.4'] }),
    ]);
    expect(result.answers.map((a) => a.agrees)).toEqual([false, true, true]);
  });
});
