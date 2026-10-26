/** @fileoverview Snapshot FARA discovery and retained live-detail windows. @module mcp-server/tools/definitions/search-foreign-agents.tool */
import { createHash } from 'node:crypto';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import {
  ProvenanceSchema,
  RecordHandleSchema,
  RecordWindowInputShape,
  RecordWindowSchema,
} from '@/domain/contracts.js';
import { deliveryDisclosure, normalizeDelivery } from '@/domain/delivery-limits.js';
import { FaraRecordSchema } from '@/domain/fara.js';
import { formatResult } from '@/domain/format.js';
import { type JsonValue, JsonValueSchema, optionalText } from '@/domain/json.js';
import { resolveCheckpoint, serveResults } from '@/services/acquisition/acquisition-service.js';
import { readRecordWindow } from '@/services/acquisition/record-window.js';
import { getFaraService } from '@/services/fara/fara-service.js';

const NAME = 'uslobbying_search_foreign_agents';
const blankUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);
const optionalMode = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? optionalText(value)?.toLowerCase() : value),
    schema,
  );
const scopeSchema = z.strictObject({
  mode: optionalMode(z.enum(['search', 'detail']).optional()).describe(
    'Search daily snapshots or fetch one registration detail collection; defaults to search.',
  ),
  entity: optionalMode(z.enum(['registrants', 'foreign_principals']).optional()).describe(
    'Search entity, default registrants; unavailable in detail mode.',
  ),
  name_contains: z
    .string()
    .optional()
    .describe('Search-only literal case-insensitive token-AND match over entity names.'),
  country: z
    .string()
    .optional()
    .describe('Exact represented country/location label, foreign-principal search only.'),
  status: optionalMode(z.enum(['active', 'terminated', 'all']).optional()).describe(
    'Selected entity status, default active; documents require all.',
  ),
  registration_number: blankUnset(z.string().trim().regex(/^\d+$/).optional()).describe(
    'Lossless digit-string registration number, required for detail mode.',
  ),
  detail: optionalMode(
    z.enum(['foreign_principals', 'short_forms', 'documents']).optional(),
  ).describe('Detail collection, default foreign_principals; unavailable in search mode.'),
  page_size: z
    .number()
    .multipleOf(1)
    .min(1)
    .optional()
    .describe(
      'Maximum records in one local output window; positive integers clamp to 25, default 25.',
    ),
});
const output = ProvenanceSchema.extend({
  truncated: z
    .boolean()
    .describe(
      'More data is available through next_cursor, record_handles or record windows; no source data was discarded.',
    ),
  mode: z.enum(['search', 'detail']).optional().describe('Original acquisition mode.'),
  entity: z
    .enum(['registrants', 'foreign_principals'])
    .optional()
    .describe('Selected search entity.'),
  detail: z
    .enum(['foreign_principals', 'short_forms', 'documents'])
    .optional()
    .describe('Selected detail collection.'),
  status: z
    .enum(['active', 'terminated', 'all'])
    .optional()
    .describe('Effective selected entity status.'),
  source_urls: z.array(z.string()).optional().describe('Official source URLs actually acquired.'),
  records: z
    .array(FaraRecordSchema)
    .optional()
    .describe('Complete normalized parent records delivered in this window.'),
  total_matches: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Exact matched records in the pinned acquisition.'),
  record_handles: z
    .array(RecordHandleSchema)
    .optional()
    .describe('Retained oversized parents, excluded from full records delivered.'),
  records_returned: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Full records delivered in this window.'),
  records_deferred: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Oversized parents represented by handles.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Start position in the pinned result set.'),
  output_complete: z
    .boolean()
    .optional()
    .describe('Whether every matched parent has been delivered or deferred.'),
  next_cursor: z.string().optional().describe('Opaque next local result window.'),
  record_window: RecordWindowSchema.optional().describe(
    'Exact recursive window of a retained parent.',
  ),
});

/** Filter complete daily snapshots once; continuation never re-fetches source data. */
export const searchForeignAgentsTool = tool(NAME, {
  title: 'Search foreign agents',
  description:
    'Search official FARA daily registrant or foreign-principal snapshots, or retrieve one registration principal, short-form or document collection. Follow cursors to pinned local windows; principal status differs from registrant status. Disclosure records do not establish wrongdoing or influence.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: scopeSchema.extend({
    cursor: blankUnset(z.string().min(1).optional()).describe(
      'Opaque continuation; original filters may be omitted or repeated unchanged.',
    ),
    ...RecordWindowInputShape,
    record_handle: blankUnset(z.string().trim().min(1).optional()).describe(
      'Opaque tenant/tool-bound deferred record handle; exclusive with source selectors and cursor.',
    ),
  }),
  output,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Required detail identifier is absent, selectors conflict, or country/status is invalid.',
      recovery:
        'Call uslobbying_list_reference with topic identifiers or methodology, then retry this tool with the required filters.',
    },
    {
      reason: 'cursor_invalid',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Continuation or record handle is unavailable, expired or belongs to another scope.',
      recovery: 'Restart the same tool with the original filters and omit cursor.',
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
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Complete result metadata exceeds the response window.',
      recovery: 'Narrow the source filters or select a deeper record_path, then retry this tool.',
    },
  ],
  async handler(input, ctx) {
    ctx = withToolDeadline(ctx);
    const disclosure = deliveryDisclosure(input);
    input = normalizeDelivery(input);
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
    if (input.record_handle) {
      if (Object.keys(normalized).length || input.cursor)
        throw ctx.fail(
          'invalid_filter',
          'record_handle is exclusive with source selectors and cursor.',
        );
      return output.parse(
        await readRecordWindow(ctx, {
          ...input,
          tool: NAME,
          record_handle: input.record_handle,
          buildResponse: (record_window, provenance) => ({
            ...provenance,
            ...disclosure,
            record_window,
            truncated: !record_window.complete,
          }),
        }),
      );
    }
    if (input.record_path !== '' || input.record_offset !== 0 || input.record_limit !== 25)
      throw ctx.fail(
        'invalid_filter',
        'record_path, record_offset and record_limit require record_handle.',
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
    const filters = z.record(z.string(), JsonValueSchema).parse({
      ...normalized,
      mode,
      status,
      page_size: scope.page_size ?? 25,
      ...(entity && { entity }),
      ...(detail && { detail }),
      ...(scope.registration_number && { registration_number: scope.registration_number }),
      ...(scope.name_contains && { name_contains: scope.name_contains }),
      ...(scope.country && { country: scope.country }),
    });
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
          ...disclosure,
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
      maxRecords: scope.page_size ?? 25,
      ...(source && { records: z.array(JsonValueSchema).parse(source.records) }),
      identify: (record: JsonValue) =>
        createHash('sha256').update(JSON.stringify(record)).digest('hex'),
      buildResponse: (window, _metadata, stored) => ({
        ...stored,
        ...disclosure,
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
