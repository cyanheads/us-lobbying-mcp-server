/** @fileoverview Per-unit count ceilings, clamping with disclosure, and the clamp off switch. @module domain/delivery-limits */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/** Served count ceilings per delivery unit; 25 is LDA's own page maximum. */
export const CEILINGS = {
  /** `uslobbying_search_filings` filings and `uslobbying_get_contributions` LD-203 reports. */
  source: { page_size: 25, max_pages: 5 },
  /** `uslobbying_search_lobbyists` search mode and `uslobbying_get_client_profile` resolve mode. */
  identities: { page_size: 25, max_pages: 5 },
  /** `uslobbying_search_lobbyists` activity-mode evidence rows. */
  evidence: { page_size: 1000, max_pages: 5 },
  /** `uslobbying_get_client_profile` profile mode and `uslobbying_get_issue_spending` analytical rows. */
  analytical: { page_size: 250, max_pages: 5 },
  /** `uslobbying_search_foreign_agents` FARA records. */
  fara: { page_size: 1000 },
  /** `uslobbying_dataframe_query` SQL rows, before any lower provider ceiling. */
  sql: { row_limit: 100 },
} as const satisfies Record<string, Ceilings>;
/** Count controls a caller may send, mapped to their served ceiling. */
export type Ceilings = Readonly<Record<string, number>>;
/** Requested and effective value of each clamped control. */
export type DeliveryLimits = Record<string, { requested: number; effective: number }>;

const clamped = createCounter(
  'uslobbying.delivery.clamped',
  'Count controls clamped to their served ceiling',
  '{controls}',
);

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
/**
 * Clamp validated controls to `ceilings` without changing defaults, selectors or filter arrays.
 * @throws `ValidationError` (`invalid_filter`) for an over-cap value when `USLOBBYING_CLAMP_LIMITS=false`.
 */
export function normalizeDelivery<T extends object>(input: T, ceilings: Ceilings): T {
  const result = { ...input };
  for (const [key, ceiling] of Object.entries(ceilings)) {
    const value = Reflect.get(input, key);
    if (typeof value !== 'number' || value <= ceiling) continue;
    if (!getServerConfig().clampLimits)
      throw validationError(`${key} cannot exceed ${ceiling}.`, {
        reason: 'invalid_filter',
        field: key,
        maximum: ceiling,
        recovery: { hint: `Lower ${key} to ${ceiling} or less.` },
      });
    Reflect.set(result, key, ceiling);
  }
  return result;
}
/** Disclose every control above its ceiling as `{ requested, effective }`. */
export function deliveryDisclosure(input: object, ceilings: Ceilings) {
  const limits: DeliveryLimits = Object.create(null);
  for (const [key, ceiling] of Object.entries(ceilings)) {
    const requested = Reflect.get(input, key);
    if (typeof requested === 'number' && requested > ceiling)
      limits[key] = { requested, effective: ceiling };
  }
  return { delivery_limits: limits };
}
/** Log and count each clamp once per call; replaying a stored response records nothing. */
export function recordClamps(ctx: Context, tool: string, limits: DeliveryLimits): void {
  for (const [control, { requested, effective }] of Object.entries(limits)) {
    ctx.log.info('Clamped a count control to its served ceiling.', {
      tool,
      control,
      requested,
      effective,
    });
    clamped.add(1, { tool, control });
  }
}
