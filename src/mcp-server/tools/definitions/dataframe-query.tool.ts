/** @fileoverview Materialize safe SQL and retrieve stable complete-row windows. @module mcp-server/tools/definitions/dataframe-query.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { QueryWindowSchema } from '@/domain/contracts.js';
import { formatResult } from '@/domain/format.js';
import { queryCanvas } from '@/services/canvas/canvas-service.js';

/** A new SQL materialization and a stored-result continuation are exclusive. */
export const dataframeQueryTool = tool('uslobbying_dataframe_query', {
  title: 'Query disclosure tables',
  description:
    'Run one read-only SELECT over staged disclosure tables, materialize the complete result, then retrieve whole rows by result_table and next_offset without rerunning SQL. Each call returns row_limit rows, or the rest of the result when fewer remain. Rows follow the materialized SQL result order set by a top-level ORDER BY; an ORDER BY only inside a CTE or subquery does not guarantee it, and without one the order is fixed once materialized. Inspect columns with uslobbying_dataframe_describe first.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    canvas_id: CanvasIdSchema.describe('Canvas token returned by a disclosure analytical tool.'),
    sql: z
      .preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().trim().min(1).optional(),
      )
      .describe('One read-only SELECT; exclusive with result_table and offset.'),
    register_as: z
      .preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().trim().min(1).optional(),
      )
      .describe('Fresh result table name for a new SQL call; omit for a generated name.'),
    result_table: z
      .preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().trim().min(1).optional(),
      )
      .describe('Previously materialized result table; exclusive with sql and register_as.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Row offset into result_table, default zero, in the materialized SQL result order set by a top-level ORDER BY; an ORDER BY only inside a CTE or subquery does not guarantee it. An offset equal to row_count returns no rows.',
      ),
    row_limit: z
      .number()
      .multipleOf(1)
      .min(1)
      .default(25)
      .describe(
        'Whole rows to return, default 25, at most 100 per call; larger values clamp to 100, then to any lower provider ceiling, and the clamp is disclosed in delivery_limits.',
      ),
  }),
  output: QueryWindowSchema.extend({
    effective_row_limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Effective row limit when a delivery or provider ceiling lowers the requested limit.',
      ),
  }),
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'New SQL and result-table selectors are missing or combined, offset passes the result row_count, or row_limit exceeds 100 while the server rejects over-cap values.',
      recovery:
        'Provide sql with optional register_as, or result_table with an offset at most its row_count, plus canvas_id.',
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
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'SQL binding fails.',
      recovery:
        'Call uslobbying_dataframe_describe with this canvas_id to verify columns and types, then retry uslobbying_dataframe_query; use TRY_CAST for values that cannot be converted.',
    },
    {
      reason: 'sql_parse_error',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'SQL parsing fails.',
      recovery:
        'Call uslobbying_dataframe_describe with this canvas_id to verify columns and types, then retry uslobbying_dataframe_query; use TRY_CAST for values that cannot be converted.',
    },
    {
      reason: 'sql_execution_error',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'SQL execution or conversion fails.',
      recovery:
        'Call uslobbying_dataframe_describe with this canvas_id to verify columns and types, then retry uslobbying_dataframe_query; use TRY_CAST for values that cannot be converted.',
    },
    {
      reason: 'non_select_statement',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'SQL is not SELECT.',
      recovery:
        'Call uslobbying_dataframe_describe with this canvas_id, then send one read-only SELECT over its staged tables to uslobbying_dataframe_query.',
    },
    {
      reason: 'multi_statement',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'SQL contains multiple statements.',
      recovery:
        'Call uslobbying_dataframe_describe with this canvas_id, then send one read-only SELECT over its staged tables to uslobbying_dataframe_query.',
    },
    {
      reason: 'denied_function',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'SQL uses a prohibited function.',
      recovery:
        'Call uslobbying_dataframe_describe with this canvas_id, then send one read-only SELECT over its staged tables to uslobbying_dataframe_query.',
    },
    {
      reason: 'sql_read_only',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'SQL violates read-only execution.',
      recovery:
        'Call uslobbying_dataframe_describe with this canvas_id, then send one read-only SELECT over its staged tables to uslobbying_dataframe_query.',
    },
    {
      reason: 'plan_operator_not_allowed',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'SQL plan contains a prohibited operator.',
      recovery:
        'Call uslobbying_dataframe_describe with this canvas_id, then send one read-only SELECT over its staged tables to uslobbying_dataframe_query.',
    },
    {
      reason: 'register_as_clash',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Requested result name already exists.',
      recovery:
        'Call uslobbying_dataframe_describe with this canvas_id, then retry uslobbying_dataframe_query with a new register_as name or omit register_as.',
    },
  ],
  async handler(input, ctx) {
    ctx = withToolDeadline(ctx);
    if (input.sql !== undefined) {
      if (input.result_table !== undefined || input.offset !== undefined)
        throw ctx.fail('invalid_filter', 'sql cannot be combined with result_table or offset.');
      return await queryCanvas(
        {
          canvas_id: input.canvas_id,
          sql: input.sql,
          row_limit: input.row_limit,
          ...(input.register_as && { register_as: input.register_as }),
        },
        ctx,
      );
    }
    if (input.result_table === undefined || input.register_as !== undefined)
      throw ctx.fail(
        'invalid_filter',
        'Supply result_table for a stored result, or sql for a new query.',
      );
    return await queryCanvas(
      {
        canvas_id: input.canvas_id,
        result_table: input.result_table,
        row_limit: input.row_limit,
        ...(input.offset !== undefined && { offset: input.offset }),
      },
      ctx,
    );
  },
  format: formatResult,
});
