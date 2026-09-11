import { z } from 'zod';

/**
 * A boolean that arrives as a query-string parameter.
 *
 * Not `z.coerce.boolean()`: that runs `Boolean("false")`, which is `true`, so
 * `?force=false` would force. Only the literal spellings are accepted, and an
 * absent parameter is false.
 */
export const boolQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')
  .default(false);
