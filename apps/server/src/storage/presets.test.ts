import { describe, it, expect } from 'vitest';
import { STORAGE_PROVIDER_PRESETS, endpointNeedsInput, exampleEndpoint } from '@smt/shared';
import { assertSafeEndpoint } from './keys.js';

describe('storage provider presets', () => {
  for (const preset of STORAGE_PROVIDER_PRESETS) {
    it(`${preset.provider} example endpoint is accepted by assertSafeEndpoint`, () => {
      const example = exampleEndpoint(preset);
      if (example === null) {
        // Only AWS (regional endpoint) and "other" (user-supplied) have no template
        expect(['s3', 'other']).toContain(preset.provider);
        return;
      }
      expect(assertSafeEndpoint(example)).toBe(example);
      expect(endpointNeedsInput(example)).toBe(false);
    });
  }

  it('has unique providers and non-empty labels and hints', () => {
    const ids = STORAGE_PROVIDER_PRESETS.map((p) => p.provider);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of STORAGE_PROVIDER_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.hint.length).toBeGreaterThan(0);
    }
  });

  it('knows which templates still need the user to fill something in', () => {
    expect(endpointNeedsInput('https://{account-id}.r2.cloudflarestorage.com')).toBe(true);
    expect(endpointNeedsInput('https://storage.googleapis.com')).toBe(false);
    expect(endpointNeedsInput(null)).toBe(false);
  });
});
