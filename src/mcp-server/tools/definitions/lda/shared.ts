/** @fileoverview LDA definition input normalization and source-window adapters. @module mcp-server/tools/definitions/lda/shared */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  ProvenanceSchema,
  RecordHandleSchema,
  RecordWindowInputShape,
  RecordWindowSchema,
} from '@/domain/contracts.js';
import { type JsonValue, JsonValueSchema } from '@/domain/json.js';
import { LDA_ATTRIBUTION } from '@/domain/lda.js';
import { resolveCheckpoint } from '@/services/acquisition/acquisition-service.js';
import { readRecordWindow } from '@/services/acquisition/record-window.js';
import type { DeliveryWindow } from '@/services/acquisition/types.js';
import { getLdaService, type LdaConstantTopic, type LdaNoun } from '@/services/lda/lda-service.js';

export const year = z.number().int().min(1999).max(new Date().getUTCFullYear());
export const id = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .describe('Digit-string source relationship identifier.');
export const commonInput = {
  ...RecordWindowInputShape,
  cursor: z
    .string()
    .optional()
    .describe('Continue the original scope; other query fields may be omitted.'),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe('Upstream rows per page; default 25.'),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe('Source pages per call; default one for discovery, five for analysis.'),
};
export const deliveryShape = {
  ...ProvenanceSchema.shape,
  next_cursor: z.string().optional().describe('Next acquisition or output window cursor.'),
  records_returned: z
    .number()
    .int()
    .nonnegative()
    .describe('Complete records delivered in this window.'),
  records_deferred: z
    .number()
    .int()
    .nonnegative()
    .describe('Oversized parents available through handles.'),
  record_handles: z.array(RecordHandleSchema).describe('Deferred complete parents.'),
  offset: z.number().int().nonnegative().describe('Final record delivery offset.'),
  total_records: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Exact final record count when known.'),
  output_complete: z.boolean().describe('Whether all result rows have been delivered.'),
  truncated: z
    .boolean()
    .describe(
      'More data is available through next_cursor or record_handles; no source data was discarded.',
    ),
};
export const recordOutput = z.object({
  ...ProvenanceSchema.shape,
  record_window: RecordWindowSchema.describe('Lossless stored parent window.'),
  retrieval_tool: z.string().describe('Tool that retrieves this parent.'),
  truncated: z
    .boolean()
    .describe('More of the parent value remains available through record windows.'),
});
export function invalid(message: string): never {
  throw validationError(message, { reason: 'invalid_filter' });
}
export function normalize(input: object): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = Object.create(null);
  for (const [key, raw] of Object.entries(input)) {
    if (
      [
        'cursor',
        'max_pages',
        'record_handle',
        'record_path',
        'record_offset',
        'record_limit',
      ].includes(key) ||
      raw === undefined
    )
      continue;
    let value: unknown = typeof raw === 'string' ? raw.trim() : raw;
    if (value === '') continue;
    if (['issue_code', 'filing_type'].includes(key) && typeof value === 'string')
      value = value.toUpperCase();
    if (['mode', 'contribution_type'].includes(key) && typeof value === 'string')
      value = value.toLowerCase();
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
export async function scope(
  input: {
    cursor?: string | undefined;
    record_handle?: string | undefined;
    record_path?: string | undefined;
    record_offset?: number | undefined;
    record_limit?: number | undefined;
    max_pages?: number | undefined;
  },
  ctx: Context,
  tool: string,
) {
  const supplied = normalize(input);
  if (input.record_handle) {
    if (input.cursor || input.max_pages !== undefined || Object.keys(supplied).length)
      invalid('Record handles are exclusive with source filters, modes, cursor and canvas inputs.');
    return {
      filters: supplied,
      record: await readRecordWindow(ctx, {
        tool,
        record_handle: input.record_handle,
        ...(input.record_path !== undefined ? { record_path: input.record_path } : {}),
        ...(input.record_offset !== undefined ? { record_offset: input.record_offset } : {}),
        ...(input.record_limit !== undefined ? { record_limit: input.record_limit } : {}),
        buildResponse: (record_window, provenance) => ({
          ...provenance,
          record_window,
          retrieval_tool: tool,
          truncated: !record_window.complete,
        }),
      }),
    };
  }
  if (
    input.record_path ||
    (input.record_offset !== undefined && input.record_offset !== 0) ||
    (input.record_limit !== undefined && input.record_limit !== 25)
  )
    invalid('Record selectors require a record_handle.');
  const stored = input.cursor
    ? await resolveCheckpoint(ctx, { tool, cursor: input.cursor })
    : undefined;
  for (const [key, value] of Object.entries(supplied))
    if (stored && JSON.stringify(value) !== JSON.stringify(stored.filters[key]))
      invalid('Continuation filters must match the original scope.');
  return { filters: stored?.filters ?? supplied, record: undefined };
}
/** Root output objects advertise every mode field while handlers validate exact response branches. */
export function outputObject(schemas: readonly z.ZodObject[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const schema of schemas)
    for (const [key, value] of Object.entries(schema.shape)) shape[key] = value.optional();
  return z.object({ ...shape, ...ProvenanceSchema.shape });
}
export function provenance(filters: Record<string, JsonValue>) {
  return {
    source: 'lda' as const,
    retrieved_at: new Date().toISOString(),
    effective_filters: filters,
    notices: ['Live API pagination is not an immutable historical snapshot.'],
    attribution: LDA_ATTRIBUTION,
  };
}
export function envelope(
  window: DeliveryWindow,
  filters: Record<string, JsonValue>,
  notice: string,
  stored?: Record<string, JsonValue>,
) {
  const { records: _records, ...delivery } = window;
  return {
    ...(stored ?? provenance(filters)),
    ...delivery,
    notices: [
      ...provenance(filters).notices,
      ...(!window.coverage.complete
        ? ['Acquisition is incomplete; follow next_cursor before interpreting scope.']
        : window.offset === 0 && window.records.length === 0 && !window.record_handles.length
          ? [notice]
          : []),
    ],
  };
}
export async function verifyCode(
  topic: LdaConstantTopic,
  value: JsonValue | undefined,
  ctx: Context,
) {
  if (typeof value !== 'string') return;
  const entries = await getLdaService().constants(topic, { signal: ctx.signal });
  if (!entries.some((entry) => String(entry.value).toLowerCase() === value.toLowerCase()))
    invalid(`Unknown ${topic} value; call uslobbying_list_reference with topic ${topic}.`);
}
export function source(noun: LdaNoun, partitions: Record<string, string | number | boolean>[]) {
  const service = getLdaService();
  return {
    identify: (row: JsonValue) => {
      const data = z
        .object({ filing_uuid: z.string().optional(), id: z.string().optional() })
        .parse(row);
      return data.filing_uuid ?? data.id ?? invalid('Source record has no identity.');
    },
    async fetchPage(position: JsonValue | null, signal: AbortSignal, deadlineMs: number) {
      const cursor =
        position === null
          ? { partition: 0, page: 1 }
          : z.object({ partition: z.number().int(), page: z.number().int() }).parse(position);
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
