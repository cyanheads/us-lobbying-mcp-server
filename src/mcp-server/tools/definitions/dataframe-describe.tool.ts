/** @fileoverview Inspect staged disclosure schema and provenance. @module mcp-server/tools/definitions/dataframe-describe.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { CanvasPointersShape, DatasetTableSchema, ProvenanceSchema } from '@/domain/contracts.js';
import { formatResult } from '@/domain/format.js';
import { describeCanvas } from '@/services/canvas/canvas-service.js';

/** Inspect a supplied canvas token without enumerating other canvases. */
export const dataframeDescribeTool = tool('uslobbying_dataframe_describe', {
  title: 'Describe disclosure tables',
  description:
    'Inspect exact staged table schemas, row counts, lifecycle, acquisition coverage and provenance before SQL.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.strictObject({
    canvas_id: CanvasIdSchema.describe('Canvas token returned by an analytical disclosure tool.'),
    table_name: z
      .preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().trim().min(1).optional(),
      )
      .describe('Existing table to inspect; omit for every table in this canvas.'),
  }),
  output: z.object({
    ...CanvasPointersShape,
    tables: z
      .array(
        DatasetTableSchema.extend({
          source_tool: z.string().describe('Tool that created this table.'),
          provenance: ProvenanceSchema.optional().describe(
            'Original disclosure acquisition provenance.',
          ),
          sql: z.string().optional().describe('SQL that materialized a derived table.'),
        }).describe('Table schema, lifecycle, source provenance and materializing SQL.'),
      )
      .describe('Complete table metadata, or an empty array for an empty canvas.'),
  }),
  errors: [
    {
      reason: 'query_row_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Complete table metadata exceeds the result byte budget.',
      recovery:
        'Inspect a single table with table_name, or use uslobbying_dataframe_query to materialize a narrower SELECT with shorter SQL.',
    },
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'Canvas is not configured.',
      recovery:
        'Use uslobbying_get_client_profile or uslobbying_get_issue_spending for inline results; SQL requires an npm or Docker installation with CANVAS_PROVIDER_TYPE=duckdb, and is unavailable in the MCPB bundle.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'Canvas token is unknown or expired.',
      recovery:
        'Re-run uslobbying_get_client_profile or uslobbying_get_issue_spending to stage data, then pass its returned canvas_id to uslobbying_dataframe_describe.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'Named table is absent or expired.',
      recovery:
        'Call uslobbying_dataframe_describe with this canvas_id to inspect available tables, or re-run the tool that produced the expired table.',
    },
  ],
  handler: (input, ctx) =>
    describeCanvas(
      {
        canvas_id: input.canvas_id,
        ...(input.table_name === undefined ? {} : { table_name: input.table_name }),
      },
      withToolDeadline(ctx),
    ),
  format: formatResult,
});
