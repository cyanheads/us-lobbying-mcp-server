/** @fileoverview LDA definition input normalization and source-window adapters. @module mcp-server/tools/definitions/lda/shared */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { ProvenanceSchema } from '@/domain/contracts.js';
import {
  CEILINGS,
  type Ceilings,
  type DeliveryLimits,
  deliveryDisclosure,
  normalizeDelivery,
  recordClamps,
} from '@/domain/delivery-limits.js';
import { type JsonValue, JsonValueSchema } from '@/domain/json.js';
import { LDA_ATTRIBUTION, MoneySchema } from '@/domain/lda.js';
import { resolveCheckpoint } from '@/services/acquisition/acquisition-service.js';
import type { DeliveryWindow } from '@/services/acquisition/types.js';
import { getLdaService, type LdaConstantTopic, type LdaNoun } from '@/services/lda/lda-service.js';
import { moneyToCents } from '@/services/lobbying/analysis.js';

/** Every upstream LDA request asks for LDA's maximum page; `page_size` inputs set the delivery count only. */
export const LDA_PAGE_SIZE = 25;
export const year = z.number().int().min(1999).max(new Date().getUTCFullYear());
/** Trim optional text before validating its concrete grammar; blank form fields are omitted. */
export function optionalFilter<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() || undefined : value),
    schema.optional(),
  );
}
export const amountFilter = optionalFilter(MoneySchema.unwrap());
export const id = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .describe('Digit-string source relationship identifier.');
/**
 * Positive whole count with no schema maximum, so an over-cap value such as 1e20 reaches the clamp.
 * `multipleOf(1)` also admits float noise such as 20.000000000000004, which `scope()` rounds.
 */
const count = z.number().multipleOf(1).min(1);
export const commonInput = {
  cursor: z
    .string()
    .optional()
    .describe(
      'Continue the original scope; omit the other fields or repeat them unchanged, since a changed value (page_size included) fails cursor_invalid. Only max_pages may change per call.',
    ),
  page_size: count
    .optional()
    .describe(
      'Whole records or rows delivered per call, not the upstream page size; a page is short only at the end of the result or while acquisition is still collecting. Values above the served ceiling clamp to it and are disclosed in delivery_limits.',
    ),
  max_pages: count
    .optional()
    .describe(
      `Most upstream pages fetched per call, at most ${CEILINGS.source.max_pages}; larger values clamp and are disclosed in delivery_limits. Discovery fetches only while fewer than page_size matches are pending. Default one for discovery, five for analysis.`,
    ),
};
/** Every include value; the complete-record default for `uslobbying_search_filings` with `filing_uuid`. */
export const INCLUDE_ALL = ['activity_descriptions', 'activity_lobbyists'] as const;
/** The lobbying-activity field each include value restores. */
const INCLUDE_FIELDS: Record<(typeof INCLUDE_ALL)[number], string> = {
  activity_descriptions: 'description',
  activity_lobbyists: 'lobbyists',
};
/** Optional unique activity-field selector; each tool states its own default and modes. */
export const includeInput = z
  .array(z.enum(INCLUDE_ALL))
  .refine((values) => new Set(values).size === values.length, 'include must contain unique values.')
  .optional();
/** `[value, field]` pairs an include selection leaves out; an absent selection leaves out both. */
function omittedFields(include: JsonValue | undefined): [string, string][] {
  const kept = new Set(Array.isArray(include) ? include : []);
  return Object.entries(INCLUDE_FIELDS).filter(([value]) => !kept.has(value));
}
/** Remove the lobbying-activity fields `include` leaves out; every other field survives untouched. */
export function projectActivity(activity: JsonValue, include: JsonValue | undefined): JsonValue {
  if (activity === null || typeof activity !== 'object' || Array.isArray(activity)) return activity;
  const omitted = new Set(omittedFields(include).map(([, field]) => field));
  return Object.fromEntries(Object.entries(activity).filter(([key]) => !omitted.has(key)));
}
/** Project every lobbying activity of one filing; the filing's own fields are untouched. */
export function projectFiling(filing: JsonValue, include: JsonValue | undefined): JsonValue {
  if (filing === null || typeof filing !== 'object' || Array.isArray(filing)) return filing;
  const activities = filing.lobbying_activities;
  if (!Array.isArray(activities)) return filing;
  return {
    ...filing,
    lobbying_activities: activities.map((activity) => projectActivity(activity, include)),
  };
}
/** The notice naming what an `include` selection left out, absent when it left nothing out. */
function includeNotice(include: JsonValue | undefined): string[] {
  const omitted = omittedFields(include);
  if (!omitted.length) return [];
  const fields = omitted.map(([, field]) => field).join(' and ');
  const values = omitted.map(([value]) => value).join(' and ');
  return [
    `Lobbying activities omit ${fields}; a new call without cursor that adds ${values} to include returns those fields.`,
  ];
}
export const deliveryShape = {
  ...ProvenanceSchema.shape,
  next_cursor: z.string().optional().describe('Next acquisition or output window cursor.'),
  records_returned: z
    .number()
    .int()
    .nonnegative()
    .describe('Whole records delivered in this window.'),
  offset: z.number().int().nonnegative().describe('Records delivered before this window.'),
  total_records: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Exact final record count when known.'),
  output_complete: z.boolean().describe('Whether all result rows have been delivered.'),
  truncated: z
    .boolean()
    .describe('More data is available through next_cursor; no source data was discarded.'),
};
export function invalid(message: string): never {
  throw validationError(message, { reason: 'invalid_filter' });
}
/** Per-call controls; every other supplied input is normalized scope identity. */
const CONTROL_KEYS = new Set(['cursor', 'max_pages']);
const UPPERCASE_KEYS = new Set([
  'issue_code',
  'filing_type',
  'client_state',
  'client_country',
  'foreign_entity_country',
]);
const LOWERCASE_KEYS = new Set(['mode', 'contribution_type']);
export function normalize(input: object): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = Object.create(null);
  for (const [key, raw] of Object.entries(input)) {
    if (CONTROL_KEYS.has(key) || raw === undefined) continue;
    let value: unknown = typeof raw === 'string' ? raw.trim() : raw;
    if (value === '') continue;
    if (UPPERCASE_KEYS.has(key) && typeof value === 'string') value = value.toUpperCase();
    if (LOWERCASE_KEYS.has(key) && typeof value === 'string') value = value.toLowerCase();
    if (
      key.endsWith('_id') &&
      key !== 'canvas_id' &&
      typeof value === 'string' &&
      !/^\d+$/.test(value)
    )
      invalid(`${key} must be a digit string.`);
    if (Array.isArray(value))
      value = [
        ...new Set(
          value.map((item) =>
            key === 'client_ids' && typeof item === 'string' ? item.trim() : item,
          ),
        ),
      ].sort((a, b) =>
        typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)),
      );
    result[key] = JsonValueSchema.parse(value);
  }
  return result;
}
/** Count and pagination controls every LDA tool accepts beside its scope filters. */
export interface DeliveryControls {
  cursor?: string | undefined;
  max_pages?: number | undefined;
  page_size?: number | undefined;
}
/** Resolved scope plus the clamped controls one call delivers with. */
export interface Scope {
  /** Clamped controls above their ceiling, as `{ requested, effective }`; pass to `provenance` and `envelope`. */
  delivery_limits: DeliveryLimits;
  /** Stored filters on a continuation, else the supplied normalized filters; `page_size` is part of them. */
  filters: Record<string, JsonValue>;
  /** Clamped upstream pages for this call; absent when the caller sent none. */
  max_pages: number | undefined;
  /** Clamped delivery count from the scope; absent when the first call omitted it, so apply the tool default. */
  page_size: number | undefined;
}
/**
 * Clamp count controls to their ceilings, then resolve the stored or supplied normalized scope.
 * `ceilings` may read the stored or supplied filters, so a mode-dependent tool picks its ceiling after a
 * cursor resolves. Clamps are logged and counted on a first call only, never on a continuation or replay.
 * @throws `invalid_filter` for an over-cap control when `USLOBBYING_CLAMP_LIMITS=false`, or a malformed id.
 * @throws `cursor_invalid` for an unavailable cursor or a supplied filter that differs from the stored scope.
 */
export async function scope<T extends DeliveryControls>(
  input: T,
  ctx: Context,
  tool: string,
  ceilings: Ceilings | ((filters: Record<string, JsonValue>) => Ceilings),
): Promise<Scope> {
  const requested = normalize(input);
  const stored = input.cursor
    ? await resolveCheckpoint(ctx, { tool, cursor: input.cursor })
    : undefined;
  const limits = typeof ceilings === 'function' ? ceilings(stored?.filters ?? requested) : ceilings;
  // `multipleOf(1)` admits float noise such as 20.000000000000004; its one reading is the nearest integer.
  const whole = {
    ...input,
    ...(input.page_size === undefined ? {} : { page_size: Math.round(input.page_size) }),
    ...(input.max_pages === undefined ? {} : { max_pages: Math.round(input.max_pages) }),
  };
  const { delivery_limits } = deliveryDisclosure(whole, limits);
  const controls = normalizeDelivery(whole, limits);
  const supplied = normalize(controls);
  for (const [key, value] of Object.entries(supplied))
    if (stored && JSON.stringify(value) !== JSON.stringify(stored.filters[key]))
      throw validationError('Continuation filters must match the original scope.', {
        reason: 'cursor_invalid',
      });
  if (!input.cursor) recordClamps(ctx, tool, delivery_limits);
  const filters = stored?.filters ?? supplied;
  return {
    filters,
    delivery_limits,
    max_pages: controls.max_pages,
    page_size: typeof filters.page_size === 'number' ? filters.page_size : undefined,
  };
}
/** Root output objects advertise every mode field while handlers validate exact response branches. */
export function outputObject(schemas: readonly z.ZodObject[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const schema of schemas)
    for (const [key, value] of Object.entries(schema.shape)) shape[key] = value.optional();
  return z.object({ ...shape, ...ProvenanceSchema.shape });
}
/** Reject inverted exact decimal bounds before acquisition. */
export function validateAmountRange(filters: Record<string, JsonValue>) {
  if (
    typeof filters.amount_min === 'string' &&
    typeof filters.amount_max === 'string' &&
    moneyToCents(filters.amount_min) > moneyToCents(filters.amount_max)
  )
    invalid('Amount range is inverted.');
}
/** First-call provenance stored with the scan; `delivery_limits` is this call's `Scope.delivery_limits`. */
export function provenance(
  filters: Record<string, JsonValue>,
  delivery_limits: DeliveryLimits = {},
) {
  return {
    delivery_limits,
    source: 'lda' as const,
    retrieved_at: new Date().toISOString(),
    effective_filters: filters,
    notices: ['Live API pagination is not an immutable historical snapshot.'],
    attribution: LDA_ATTRIBUTION,
  };
}
/**
 * Caller envelope for one delivery window; the empty-scope `notice` appears only on a complete empty
 * result, and a scope carrying `include` names the activity fields it leaves out.
 */
export function envelope(
  window: DeliveryWindow,
  filters: Record<string, JsonValue>,
  notice: string,
  stored?: Record<string, JsonValue>,
  delivery_limits: DeliveryLimits = {},
) {
  const { records: _records, ...delivery } = window;
  return {
    ...(stored ?? provenance(filters)),
    delivery_limits,
    ...delivery,
    notices: [
      ...provenance(filters).notices,
      ...(Object.hasOwn(filters, 'include') ? includeNotice(filters.include) : []),
      ...(!window.coverage.complete
        ? ['Acquisition is incomplete; follow next_cursor before interpreting scope.']
        : window.offset === 0 && window.records.length === 0
          ? [notice]
          : []),
    ],
  };
}
/**
 * Check a normalized code against the LDA constants for `topic` (24-hour service cache) before any
 * source request. A constants failure propagates as the upstream's own error, never `invalid_filter`.
 * @throws `invalid_filter` naming `field` and the `uslobbying_list_reference` topic for an unknown code.
 */
export async function verifyCode(
  topic: LdaConstantTopic,
  value: JsonValue | undefined,
  ctx: Context,
  field: string,
) {
  if (typeof value !== 'string') return;
  const { entries } = await getLdaService().constants(topic, { signal: ctx.signal });
  if (!entries.some((entry) => String(entry.value).toLowerCase() === value.toLowerCase()))
    throw validationError(
      `Unknown ${field} value; call uslobbying_list_reference with topic ${topic}.`,
      {
        reason: 'invalid_filter',
        recovery: {
          hint: `Call uslobbying_list_reference with topic ${topic} and retry ${field} with the value of an entry whose source is lda.`,
        },
      },
    );
}
/** One upstream partition: LDA's maximum page plus every string or numeric filter named in keys. */
export function nativeFilters(
  f: Record<string, JsonValue>,
  keys: readonly string[],
): Record<string, string | number | boolean> {
  const native: Record<string, string | number | boolean> = { page_size: LDA_PAGE_SIZE };
  for (const key of keys) {
    const value = f[key];
    if (typeof value === 'string' || typeof value === 'number') native[key] = value;
  }
  return native;
}
const RowIdentitySchema = z.object({
  filing_uuid: z.string().optional(),
  id: z.string().optional(),
});
const PositionSchema = z.object({ partition: z.number().int(), page: z.number().int() });
export function source(noun: LdaNoun, partitions: Record<string, string | number | boolean>[]) {
  const service = getLdaService();
  return {
    identify: (row: JsonValue) => {
      const data = RowIdentitySchema.parse(row);
      return data.filing_uuid ?? data.id ?? invalid('Source record has no identity.');
    },
    async fetchPage(position: JsonValue | null, signal: AbortSignal, deadlineMs: number) {
      const cursor = position === null ? { partition: 0, page: 1 } : PositionSchema.parse(position);
      const partition = partitions[cursor.partition];
      if (!partition) invalid('No source partition was supplied.');
      const filters = { ...partition, page: cursor.page };
      const options = { signal, deadlineMs };
      const page =
        noun === 'filings'
          ? await service.listFilings(filters, options)
          : noun === 'clients'
            ? await service.listClients(filters, options)
            : noun === 'lobbyists'
              ? await service.listLobbyists(filters, options)
              : await service.listContributions(filters, options);
      const next = service.validateNext(noun, page.next, filters, cursor.page);
      return {
        records: z.array(JsonValueSchema).parse(page.results),
        upstreamCount: page.count,
        partition: {
          index: cursor.partition,
          total: partitions.length,
          firstPage: cursor.page === 1,
        },
        next:
          next !== null
            ? { partition: cursor.partition, page: next }
            : cursor.partition + 1 < partitions.length
              ? { partition: cursor.partition + 1, page: 1 }
              : null,
      };
    },
  };
}
