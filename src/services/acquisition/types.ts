/** @fileoverview Scan storage schemas and caller-facing window contracts. @module services/acquisition/types */
import { z } from '@cyanheads/mcp-ts-core';
import { CoverageSchema } from '@/domain/contracts.js';
import { type JsonValue, JsonValueSchema } from '@/domain/json.js';

/** One count-bounded window of whole records; callers wrap it in their complete envelope. */
export interface DeliveryWindow {
  coverage: z.infer<typeof CoverageSchema>;
  cursor_expires_at: string;
  next_cursor?: string;
  offset: number;
  output_complete: boolean;
  records: JsonValue[];
  records_returned: number;
  total_records?: number;
  truncated: boolean;
}
/** Callers include their complete provenance and domain metadata in this envelope. */
export type ResponseBuilder = (
  window: DeliveryWindow,
  metadata: Record<string, JsonValue> | undefined,
  provenance: Record<string, JsonValue>,
) => object;
/** Durable JSON-only scan manifest; one previous response is the complete replay slot. */
export const ManifestSchema = z.object({
  id: z.string(),
  tool: z.string(),
  scanKind: z.string(),
  filters: z.record(z.string(), JsonValueSchema),
  provenance: z.record(z.string(), JsonValueSchema),
  revision: z.number().int().nonnegative(),
  cursor: z.string(),
  expires: z.number().int(),
  coverage: CoverageSchema,
  partitions: z
    .object({
      total: z.number().int().positive(),
      observed: z.record(
        z.string(),
        z.object({
          count: z.number().int().nonnegative().optional(),
          recordsFetched: z.number().int().nonnegative(),
          completeHistory: z.boolean(),
        }),
      ),
    })
    .optional(),
  position: JsonValueSchema,
  positions: z.array(z.string()),
  chunks: z.array(z.string()),
  pending: z.array(JsonValueSchema),
  indexes: z.array(z.string().nullable()).length(64),
  retainAll: z.boolean(),
  delivered: z.number().int().nonnegative(),
  finalChunks: z.array(z.string()).optional(),
  finalCount: z.number().int().nonnegative().optional(),
  finalOffset: z.number().int().nonnegative().optional(),
  finalMetadata: z.record(z.string(), JsonValueSchema).optional(),
  replay: z.object({ cursor: z.string(), response: JsonValueSchema }).optional(),
});
/** Parsed storage manifest. */
export type Manifest = z.infer<typeof ManifestSchema>;
