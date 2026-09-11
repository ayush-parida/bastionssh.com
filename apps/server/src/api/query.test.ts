import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { boolQuery } from './query.js';

const schema = z.object({ flag: boolQuery });

describe('boolQuery', () => {
  it('is false when the parameter is omitted', () => {
    expect(schema.parse({}).flag).toBe(false);
  });

  it('reads "true" and "1" as true', () => {
    expect(schema.parse({ flag: 'true' }).flag).toBe(true);
    expect(schema.parse({ flag: '1' }).flag).toBe(true);
  });

  it('reads "false" and "0" as false — the whole point, since coerce.boolean() would not', () => {
    expect(schema.parse({ flag: 'false' }).flag).toBe(false);
    expect(schema.parse({ flag: '0' }).flag).toBe(false);
  });

  it('accepts a real boolean too, for callers that already parsed', () => {
    expect(schema.parse({ flag: true }).flag).toBe(true);
    expect(schema.parse({ flag: false }).flag).toBe(false);
  });

  it('rejects anything else rather than guessing', () => {
    expect(() => schema.parse({ flag: 'yes' })).toThrow();
    expect(() => schema.parse({ flag: '' })).toThrow();
  });
});
