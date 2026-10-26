/** @fileoverview Shared provenance, delivery windows, datasets and acquisition callbacks. @module domain/contracts */
import { z } from '@cyanheads/mcp-ts-core';
import { DeliveryLimitsSchema } from './delivery-limits.js';
import { type JsonValue, JsonValueSchema } from './json.js';

/** Full serialized MCP result target, including both surfaces and envelope allowance. */
export const FULL_RESULT_TARGET_BYTES = 24_000;
/** Maximum duration of one tool call, including queueing and retries. */
export const TOOL_DEADLINE_MS = 45_000;
/** Maximum single network exchange, bounded further by the remaining tool deadline. */
export const EXCHANGE_DEADLINE_MS = 20_000;
/** Common absolute lifetime of scans, chunks and deferred records. */
export const ACQUISITION_TTL_MS = 86_400_000;
/** Default-provider retained acquisition bytes, including indexes and replay state. */
export const ACQUISITION_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
/** Source snapshot and reference cache lifetime. */
export const SOURCE_CACHE_TTL_MS = 86_400_000;

/** Acquisition completeness is independent from final output-window completeness. */
export const CoverageSchema = z.object({
  complete: z.boolean().describe('Whether every source partition has been exhausted.'),
  pages_fetched: z.number().int().nonnegative().describe('Committed upstream pages fetched.'),
  records_fetched: z.number().int().nonnegative().describe('Rows before UUID deduplication.'),
  unique_records: z.number().int().nonnegative().describe('Unique acquired source records.'),
  upstream_count: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Latest partition counts summed only when all are known; includes duplicates, not an immutable snapshot.',
    ),
  started_at: z.string().describe('Acquisition start ISO timestamp.'),
  finished_at: z.string().optional().describe('Acquisition end ISO timestamp.'),
  next_cursor: z.string().optional().describe('Opaque acquisition or output continuation.'),
});
/** Common fields included by every source response. */
export const ProvenanceSchema = z.object({
  delivery_limits: DeliveryLimitsSchema,
  source: z.enum(['lda', 'fara']).describe('Official source system.'),
  retrieved_at: z.string().describe('Retrieval ISO timestamp.'),
  effective_filters: z.record(z.string(), JsonValueSchema).describe('Normalized effective scope.'),
  notices: z.array(z.string()).describe('Limitations and success notices.'),
  coverage: CoverageSchema.describe('Acquisition progress, independent of delivery.'),
  attribution: z.string().optional().describe('Required verbatim attribution for LDA data.'),
  cursor_expires_at: z.string().optional().describe('Continuation expiry ISO timestamp.'),
  snapshot_retrieved_at: z.string().optional().describe('FARA snapshot retrieval timestamp.'),
  snapshot_source_urls: z.array(z.string()).optional().describe('Official snapshot URLs.'),
  snapshot_last_modified: z.string().optional().describe('Upstream Last-Modified header.'),
});
/** Shared selectors; handlers enforce exclusivity against filters/cursor/canvas. */
export const RecordWindowInputShape = {
  record_handle: z.string().optional().describe('Tenant/tool-bound deferred record handle.'),
  record_path: z
    .string()
    .default('')
    .describe('JSON Pointer to a stored value; empty selects the root.'),
  record_offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Key, item or Unicode-code-point offset.'),
  record_limit: z
    .number()
    .multipleOf(1)
    .min(1)
    .default(25)
    .describe(
      'Maximum object entries or array items, clamped to 25; text fragments use the response byte budget.',
    ),
};
/** A deferred parent is not counted as a delivered full record. */
export const RecordHandleSchema = z
  .object({
    record_handle: z.string().describe('Opaque retained parent handle.'),
    source_id: z.string().describe('Original source identity.'),
    record_bytes: z.number().int().nonnegative().describe('Serialized parent UTF-8 bytes.'),
    expires_at: z.string().describe('Retained parent expiry ISO timestamp.'),
    retrieval_tool: z.string().describe('Source tool for record windows.'),
  })
  .describe('Deferred parent retrieval.');
const windowBase = {
  record_handle: z.string().describe('Stored parent handle.'),
  path: z.string().describe('Selected JSON Pointer.'),
  total: z.number().int().nonnegative().describe('Total keys, items or code points at this path.'),
  offset: z.number().int().nonnegative().describe('Start position.'),
  returned: z.number().int().nonnegative().describe('Delivered entries or code points.'),
  next_offset: z.number().int().nonnegative().optional().describe('Next undelivered position.'),
  complete: z.boolean().describe('This path and included children are fully delivered.'),
};
/** Discriminated windows preserve parent membership and oversized-child descent paths. */
export const RecordWindowSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...windowBase,
      kind: z.literal('object').describe('Object-entry window.'),
      entries: z
        .array(
          z
            .object({
              key: z.string().describe('Original key.'),
              path: z.string().describe('Child JSON Pointer.'),
              value: JsonValueSchema.optional().describe('Whole child value only when it fits.'),
            })
            .describe('Key and pointer; value only when it fits.'),
        )
        .describe('Key-ordered object window.'),
    })
    .describe('Complete or deferred object children.'),
  z
    .object({
      ...windowBase,
      kind: z.literal('array').describe('Array-item window.'),
      items: z
        .array(
          z
            .object({
              index: z.number().int().nonnegative().describe('Original child index.'),
              path: z.string().describe('Child JSON Pointer.'),
              value: JsonValueSchema.optional().describe('Whole child value only when it fits.'),
            })
            .describe('Original index and child pointer.'),
        )
        .describe('Indexed array window.'),
    })
    .describe('Array items preserving original indexes.'),
  z
    .object({
      ...windowBase,
      kind: z.literal('string').describe('Unicode text window.'),
      text: z.string().describe('Complete-code-point text fragment.'),
    })
    .describe('Unicode-code-point text fragment.'),
  z
    .object({
      ...windowBase,
      kind: z.literal('scalar').describe('Complete scalar value.'),
      value: z
        .union([
          z.null().describe('Null value.'),
          z.boolean().describe('Boolean value.'),
          z.number().finite().describe('Finite numeric value.'),
        ])
        .describe('Exact scalar value.'),
    })
    .describe('Unfragmented non-text scalar.'),
]);
/** Every canvas-token response carries these consumer-facing routing pointers. */
export const CanvasPointersShape = {
  canvas_id: z.string().describe('Tenant-scoped canvas access token.'),
  describe_tool: z
    .literal('uslobbying_dataframe_describe')
    .describe('Inspect exact table schemas before SQL.'),
  query_tool: z
    .literal('uslobbying_dataframe_query')
    .describe('Query or retrieve materialized table rows.'),
  guidance: z.string().describe('Table names and dataframe instructions.'),
};
/** Exact table lifecycle and grain accompany staged data. */
export const DatasetTableSchema = z
  .object({
    table_name: z.string().describe('Registered table name.'),
    row_count: z.number().int().nonnegative().describe('Exact registered row count.'),
    columns: z
      .array(
        z
          .object({
            name: z.string().describe('Column name.'),
            type: z.string().describe('Provider column type.'),
            nullable: z.boolean().describe('Whether null values are permitted.'),
          })
          .describe('Provider column.'),
      )
      .describe('Explicit complete schema.'),
    grain: z.string().describe('Meaning of one row; activity rows have no money.'),
    complete: z.boolean().describe('Whether every intended row is registered.'),
    created_at: z.string().describe('Table creation ISO timestamp.'),
    expires_at: z.string().describe('Table expiry ISO timestamp.'),
  })
  .describe('Complete table metadata.');
/** Complete staged datasets always advertise describe/query routing. */
export const DatasetSchema = z.object({
  ...CanvasPointersShape,
  tables: z.array(DatasetTableSchema).describe('Dataset tables.'),
});
/** Stable materialized-query delivery window; offsets count actually delivered rows. */
export const QueryWindowSchema = z.object({
  delivery_limits: DeliveryLimitsSchema,
  ...CanvasPointersShape,
  dataset: DatasetSchema.describe('Materialized dataset and routing.'),
  result_table: z.string().describe('Stable materialized result table.'),
  columns: DatasetTableSchema.shape.columns.describe('Complete result schema.'),
  rows: z.array(z.record(z.string(), JsonValueSchema)).describe('Whole JSON-safe rows.'),
  row_count: z.number().int().nonnegative().describe('Exact materialized result count.'),
  rows_returned: z.number().int().nonnegative().describe('Rows actually delivered.'),
  offset: z.number().int().nonnegative().describe('Canonical-order starting row offset.'),
  next_offset: z.number().int().nonnegative().optional().describe('Next undelivered row offset.'),
  output_complete: z.boolean().describe('Whether this result has no remaining delivery rows.'),
  truncated: z.boolean().describe('More materialized rows remain; continue with next_offset.'),
  row_order: z.literal('canonical_values').describe('Delivery orders by all materialized values.'),
});
/** Validated progress shared by acquisition and source adapters. */
export type Coverage = z.infer<typeof CoverageSchema>;
/** Consumer-facing complete dataset metadata. */
export type Dataset = z.infer<typeof DatasetSchema>;
/** Immutable committed page; next is source-owned validated position, never a caller URL. */
export interface AcquisitionPage<T extends JsonValue> {
  next: JsonValue | null;
  partition?: { index: number; total: number; firstPage?: boolean };
  records: T[];
  upstreamCount?: number;
}
/** Source callback runs inside the caller's remaining deadline and cancellation. */
export interface AcquisitionSource<T extends JsonValue> {
  fetchPage(
    position: JsonValue | null,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<AcquisitionPage<T>>;
  identify(record: T): string;
}
/** Checkpoint metadata references immutable chunks rather than embedding a growing corpus. */
export interface AcquisitionCheckpoint {
  chunkKeys: string[];
  coverage: Coverage;
  cursor: string;
  expiresAt: string;
  filters: Record<string, JsonValue>;
  partitions?: {
    total: number;
    observed: Record<
      string,
      { count?: number | undefined; recordsFetched: number; completeHistory: boolean }
    >;
  };
  position: JsonValue | null;
  provenance: Record<string, JsonValue>;
  revision: number;
  scanKind: string;
  tool: string;
}
