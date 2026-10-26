/** @fileoverview Normalize delivery controls before scope identity and disclose clamping. @module domain/delivery-limits */
import { z } from '@cyanheads/mcp-ts-core';

const CEILINGS = { page_size: 25, max_pages: 5, record_limit: 25, row_limit: 100 } as const;
/** Requested/effective controls lowered by a ceiling; replay retains the original response. */
export const DeliveryLimitsSchema = z
  .record(
    z.string(),
    z
      .object({
        requested: z
          .number()
          .multipleOf(1)
          .positive()
          .describe('Caller-requested positive integer.'),
        effective: z.number().int().positive().describe('Applied delivery ceiling.'),
      })
      .describe('Requested and effective delivery control.'),
  )
  .optional()
  .describe(
    'Clamped controls for this call; an empty map means no clamp. Immediate cursor replay retains its original values.',
  );
/** Clamp validated controls without changing defaults, selectors or filter arrays. */
export function normalizeDelivery<T extends object>(input: T): T {
  const result = { ...input };
  for (const [key, ceiling] of Object.entries(CEILINGS)) {
    const value = Reflect.get(input, key);
    if (typeof value === 'number') Reflect.set(result, key, Math.min(value, ceiling));
  }
  return result;
}
/** Include metadata inside byte-budgeted response builders. */
export function deliveryDisclosure(input: object) {
  const limits: Record<string, { requested: number; effective: number }> = Object.create(null);
  for (const [key, ceiling] of Object.entries(CEILINGS)) {
    const requested = Reflect.get(input, key);
    if (typeof requested === 'number' && requested > ceiling)
      limits[key] = { requested, effective: ceiling };
  }
  return { delivery_limits: limits };
}
