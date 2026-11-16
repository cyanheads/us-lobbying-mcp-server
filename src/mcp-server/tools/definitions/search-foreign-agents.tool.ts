/** @fileoverview FARA snapshot search and live registration detail in count-bounded pinned windows. @module mcp-server/tools/definitions/search-foreign-agents.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { ProvenanceSchema } from '@/domain/contracts.js';
import {
  CEILINGS,
  deliveryDisclosure,
  normalizeDelivery,
  recordClamps,
} from '@/domain/delivery-limits.js';
import { FaraRecordSchema } from '@/domain/fara.js';
import { formatResult } from '@/domain/format.js';
import { JsonValueSchema, optionalText } from '@/domain/json.js';
import { resolveCheckpoint, serveResults } from '@/services/acquisition/acquisition-service.js';
import { getFaraService } from '@/services/fara/fara-service.js';

const NAME = 'uslobbying_search_foreign_agents';
/** Applied in code, never as a schema default, so a continuation that omits page_size keeps its scope. */
const DEFAULT_PAGE_SIZE = 25;
const Mode = z.enum(['search', 'detail']);
const Entity = z.enum(['registrants', 'foreign_principals', 'short_forms']);
const Detail = z.enum(['foreign_principals', 'short_forms', 'documents']);
const Status = z.enum(['active', 'terminated', 'all']);
const blankUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);
const optionalMode = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? optionalText(value)?.toLowerCase() : value),
    schema,
  );
const scopeSchema = z.strictObject({
  mode: optionalMode(Mode.optional()).describe(
    'Search daily snapshots or fetch one registration detail collection; defaults to search.',
  ),
  entity: optionalMode(Entity.optional()).describe(
    'Search entity, default registrants; short_forms finds the individuals filed under a registration by first and last name. Unavailable in detail mode.',
  ),
  name_contains: z
    .string()
    .optional()
    .describe(
      'Search-only literal case-insensitive token-AND match over entity names; a short-form name is its first and last name joined. Short-form hits are name matches only, with no identity across registrations or with LDA lobbyists.',
    ),
  country: z
    .string()
    .optional()
    .describe('Exact represented country/location label, foreign-principal search only.'),
  status: optionalMode(Status.optional()).describe(
    'Status of the selected record itself, default active; documents require all.',
  ),
  registration_number: blankUnset(z.string().trim().regex(/^\d+$/).optional()).describe(
    'Lossless digit-string registration number, required for detail mode.',
  ),
  detail: optionalMode(Detail.optional()).describe(
    'Detail collection, default foreign_principals; unavailable in search mode.',
  ),
  page_size: z
    .number()
    .multipleOf(1)
    .min(1)
    .optional()
    .describe(
      'Whole records per window, default 25, at most 1,000; larger values clamp to 1,000 and are disclosed in delivery_limits. Part of the scope: omit it or repeat it unchanged on continuations.',
    ),
});
const output = ProvenanceSchema.extend({
  truncated: z
    .boolean()
    .describe('More records remain through next_cursor; no source data was discarded.'),
  mode: Mode.describe('Original acquisition mode.'),
  entity: Entity.optional().describe('Selected search entity.'),
  detail: Detail.optional().describe('Selected detail collection.'),
  status: Status.describe('Effective selected entity status.'),
  source_urls: z.array(z.string()).describe('Official source URLs actually acquired.'),
  records: z.array(FaraRecordSchema).describe('Whole normalized records delivered in this window.'),
  total_matches: z
    .number()
    .int()
    .nonnegative()
    .describe('Exact matched records in the pinned acquisition.'),
  records_returned: z
    .number()
    .int()
    .nonnegative()
    .describe('Whole records delivered in this window.'),
  offset: z.number().int().nonnegative().describe('Records delivered before this window.'),
  output_complete: z.boolean().describe('Whether every matched record has been delivered.'),
  next_cursor: z.string().optional().describe('Opaque continuation to the next window.'),
});

/** Filter complete daily snapshots once; continuation never re-fetches source data. */
export const searchForeignAgentsTool = tool(NAME, {
  title: 'Search foreign agents',
  description:
    "Search official FARA daily snapshots of registrants, foreign principals or short-form registrants, or fetch one registration's live foreign-principal, short-form or document collection. Short forms are the individuals working under a registration, searched by first and last name; a hit is a name match only and establishes no identity across registrations or with LDA lobbyists. Each call returns page_size whole records; follow next_cursor through the pinned result. Principal and short-form status differ from registrant status (registrant_status). Disclosure records do not establish wrongdoing or influence.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: scopeSchema.extend({
    cursor: blankUnset(z.string().min(1).optional()).describe(
      'Opaque continuation; original filters may be omitted or repeated unchanged.',
    ),
  }),
  output,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Required detail identifier is absent, selectors conflict, country/status is invalid, or page_size exceeds 1,000 where clamping is disabled.',
      recovery:
        'Call uslobbying_list_reference with topic identifiers or fara_rules, then retry this tool with the required filters.',
    },
    {
      reason: 'cursor_invalid',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Continuation is unavailable, expired, belongs to another tenant, or arrives with changed filters or page_size.',
      recovery:
        'Restart uslobbying_search_foreign_agents with the original filters and omit cursor.',
    },
    {
      reason: 'acquisition_storage_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'Retained-data capacity prevents a safe checkpoint.',
      recovery:
        'Retry the last cursor after storage is available, or restart uslobbying_search_foreign_agents with name_contains, a foreign-principal country, or mode detail and a known registration_number.',
    },
    {
      reason: 'source_schema_changed',
      code: JsonRpcErrorCode.SerializationError,
      thrownBy: 'service',
      retryable: false,
      when: 'A source response violates the verified schema or uses an unsupported redirect.',
      recovery:
        'Use uslobbying_list_reference topic methodology for source limitations; retry after the upstream response format or redirect route is supported.',
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'Required bulk snapshot cannot be downloaded or decoded.',
      recovery:
        'Retry uslobbying_search_foreign_agents later, or use mode detail with a known registration_number.',
    },
    {
      reason: 'source_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
      when: 'FARA returns HTTP 429 after bounded retries.',
      recovery:
        'Wait for retryAfter when present, then retry uslobbying_search_foreign_agents with the same filters and cursor.',
    },
  ],
  async handler(input, ctx) {
    ctx = withToolDeadline(ctx);
    const { delivery_limits } = deliveryDisclosure(input, CEILINGS.fara);
    input = normalizeDelivery(input, CEILINGS.fara);
    const supplied = scopeSchema.parse(
      Object.fromEntries(
        Object.entries(input).filter(([key]) => Object.hasOwn(scopeSchema.shape, key)),
      ),
    );
    const normalized = Object.fromEntries(
      Object.entries(supplied)
        .map(([key, value]) => [key, typeof value === 'string' ? optionalText(value) : value])
        .filter(([, value]) => value !== undefined),
    );
    const checkpoint = input.cursor
      ? await resolveCheckpoint(ctx, { tool: NAME, cursor: input.cursor })
      : undefined;
    const scope = scopeSchema.parse({ ...checkpoint?.filters, ...normalized });
    const mode = scope.mode ?? 'search';
    const detail = mode === 'detail' ? (scope.detail ?? 'foreign_principals') : undefined;
    const entity = mode === 'search' ? (scope.entity ?? 'registrants') : undefined;
    const status = scope.status ?? (detail === 'documents' ? 'all' : 'active');
    if (mode === 'search' && (scope.registration_number || scope.detail))
      throw ctx.fail('invalid_filter', 'registration_number and detail require mode detail.');
    if (
      mode === 'detail' &&
      (scope.entity || scope.country || scope.name_contains || !scope.registration_number)
    )
      throw ctx.fail(
        'invalid_filter',
        'Detail requires registration_number and excludes entity, country and name_contains.',
      );
    if (scope.country && entity !== 'foreign_principals')
      throw ctx.fail('invalid_filter', 'country requires a foreign_principals search.');
    if (detail === 'documents' && status !== 'all')
      throw ctx.fail('invalid_filter', 'Document collections require status all.');
    // multipleOf(1) admits float noise such as 20.000000000000004; scope and window use the integer it denotes.
    const pageSize = Math.round(scope.page_size ?? DEFAULT_PAGE_SIZE);
    const filters = z.record(z.string(), JsonValueSchema).parse({
      ...normalized,
      mode,
      status,
      page_size: pageSize,
      ...(entity && { entity }),
      ...(detail && { detail }),
      ...(scope.registration_number && { registration_number: scope.registration_number }),
      ...(scope.name_contains && { name_contains: scope.name_contains }),
      ...(scope.country && { country: scope.country }),
    });
    if (!input.cursor) recordClamps(ctx, NAME, delivery_limits);
    const source = checkpoint
      ? undefined
      : mode === 'search'
        ? await getFaraService().search(
            {
              ...(entity && { entity }),
              status,
              ...(scope.country && { country: scope.country }),
              ...(scope.name_contains && { name_contains: scope.name_contains }),
            },
            ctx.signal,
          )
        : await getFaraService().detail(
            {
              registration_number: scope.registration_number ?? '',
              ...(detail && { detail }),
              status,
            },
            ctx.signal,
          );
    const { records: _records, ...sourceMetadata } = source ?? { records: [] };
    const provenance = source
      ? z.record(z.string(), JsonValueSchema).parse({
          source: 'fara',
          effective_filters: filters,
          ...sourceMetadata,
          notices: [
            ...source.notices,
            ...(source.records.length === 0
              ? [
                  'No FARA records matched; use uslobbying_list_reference topic fara_rules or countries, then revise uslobbying_search_foreign_agents.',
                ]
              : []),
          ],
        })
      : (checkpoint?.provenance ?? {});
    const result = await serveResults(ctx, {
      tool: NAME,
      scanKind: 'fara',
      ...(input.cursor && { cursor: input.cursor }),
      filters,
      provenance,
      pageSize,
      ...(source && { records: z.array(JsonValueSchema).parse(source.records) }),
      buildResponse: (window, _metadata, stored) => ({
        ...stored,
        delivery_limits,
        mode,
        ...(entity && { entity }),
        ...(detail && { detail }),
        status,
        ...window,
        total_matches: window.total_records,
      }),
    });
    return output.parse(result.response);
  },
  format: formatResult,
});
