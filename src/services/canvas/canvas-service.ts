/** @fileoverview Token-scoped complete disclosure staging and stable SQL delivery. @module services/canvas/canvas-service */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import {
  type CanvasInstance,
  type DataCanvas,
  quoteIdentifier,
  type TableInfo,
} from '@cyanheads/mcp-ts-core/canvas';
import { config } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  type Dataset,
  DatasetSchema,
  DatasetTableSchema,
  FULL_RESULT_TARGET_BYTES,
  ProvenanceSchema,
  QueryWindowSchema,
} from '@/domain/contracts.js';
import { fullResultBytes } from '@/domain/format.js';
import { JsonValueSchema } from '@/domain/json.js';
import type { ActivityRow, Filing } from '@/domain/lda.js';
import type { FilingSelection } from '@/services/lobbying/analysis.js';
import {
  activityColumns,
  activityRows,
  type FilingAudit,
  filingColumns,
  filingRows,
  type RowSource,
} from './table-rows.js';

const DESCRIBE = 'uslobbying_dataframe_describe' as const;
const QUERY = 'uslobbying_dataframe_query' as const;
const META_PREFIX = 'canvas/table/';
const MetaSchema = z.object({
  created_at: z.string(),
  grain: z.string(),
  source_tool: z.string(),
  provenance: ProvenanceSchema.optional(),
  sql: z.string().optional(),
  materialized_result: z.boolean(),
});
type Meta = z.infer<typeof MetaSchema>;
let canvas: DataCanvas | undefined;
let configuredRowLimit: number | undefined;
const admitted = new Set<string>();

/** Wire once from setup(core); optionally pass core.config.canvas.defaultRowLimit. */
export function setCanvas(value: DataCanvas | undefined, rowLimit?: number): void {
  canvas = value;
  configuredRowLimit = rowLimit;
}

/** Source tools use this to select complete inline delivery when canvas is disabled. */
export function getCanvas(): DataCanvas | undefined {
  return canvas;
}

function requireCanvas(): DataCanvas {
  if (!canvas)
    throw serviceUnavailable('DataCanvas is not configured on this installation.', {
      reason: 'canvas_unavailable',
      recovery: {
        hint: 'Use uslobbying_get_client_profile or uslobbying_get_issue_spending for inline results; SQL requires an npm or Docker installation with CANVAS_PROVIDER_TYPE=duckdb, and is unavailable in the MCPB bundle.',
      },
    });
  return canvas;
}

function pointers(canvasId: string, names: string[]) {
  return {
    canvas_id: canvasId,
    describe_tool: DESCRIBE,
    query_tool: QUERY,
    guidance: `Inspect ${names.length ? names.join(', ') : 'available tables'} with ${DESCRIBE}, then use ${QUERY} with this canvas_id; result_table windows use canonical value ordering.`,
  };
}

function key(instance: CanvasInstance, name: string): string {
  return `${META_PREFIX}${instance.canvasId}/${name}`;
}

function fresh(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function missing(name: string): McpError {
  return notFound('The requested table is absent or expired.', {
    reason: 'missing_table',
    tableName: name,
    recovery: {
      hint: `Call ${DESCRIBE} with this canvas_id to inspect available tables, or re-run the tool that produced the expired table.`,
    },
  });
}

function route(error: unknown, dropping: boolean): never {
  if (!(error instanceof McpError)) throw error;
  const reason = error.data?.reason;
  if (
    typeof reason === 'string' &&
    [
      'non_select_statement',
      'multi_statement',
      'denied_function',
      'sql_read_only',
      'plan_operator_not_allowed',
    ].includes(reason)
  )
    throw new McpError(
      error.code,
      'Only one read-only SELECT over staged tables is allowed.',
      {
        ...error.data,
        recovery: {
          hint: `Call ${DESCRIBE} with this canvas_id, then send one read-only SELECT over its staged tables to ${QUERY}.`,
        },
      },
      { cause: error },
    );
  if (reason === 'canvas_not_found')
    throw new McpError(
      error.code,
      'This canvas is unknown or expired.',
      {
        ...error.data,
        recovery: {
          hint: dropping
            ? 'No table can be removed from this canvas; use a canvas_id returned by uslobbying_get_client_profile or uslobbying_get_issue_spending for a later drop.'
            : `Re-run uslobbying_get_client_profile or uslobbying_get_issue_spending to stage data, then pass its returned canvas_id to ${DESCRIBE}.`,
        },
      },
      { cause: error },
    );
  /** Engine details can echo arbitrary SQL literals or host paths. Retain diagnostics on cause. */
  const engineReasons = new Set([
    'invalid_sql',
    'sql_execution_error',
    'sql_parse_error',
    'sql_read_only',
    'database_error',
  ]);
  if (
    error.code === JsonRpcErrorCode.DatabaseError ||
    (typeof reason === 'string' && engineReasons.has(reason))
  ) {
    const { binderMessage: _binder, engineMessage: _engine, ...data } = error.data ?? {};
    throw new McpError(
      error.code,
      typeof reason === 'string'
        ? `The canvas rejected the query (${reason}).`
        : 'The canvas engine could not complete the operation.',
      {
        ...data,
        recovery: {
          hint: `Call ${DESCRIBE} with this canvas_id to verify columns and types, then retry ${QUERY}; use TRY_CAST for values that cannot be converted.`,
        },
      },
      { cause: error },
    );
  }
  throw error;
}

async function operate<T>(
  canvasId: string | undefined,
  ctx: Context,
  run: (instance: CanvasInstance) => Promise<T>,
  dropping = false,
): Promise<T> {
  ctx.signal?.throwIfAborted();
  let lock: string | undefined;
  try {
    const instance = await requireCanvas().acquire(canvasId, ctx, {
      ...(ctx.signal && { signal: ctx.signal }),
    });
    lock = JSON.stringify([instance.tenantId, instance.canvasId]);
    if (admitted.has(lock)) {
      lock = undefined;
      throw rateLimited('Another operation is using this canvas; retry when it completes.', {
        reason: 'canvas_busy',
        retryable: true,
      });
    }
    admitted.add(lock);
    return await run(instance);
  } catch (error) {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    return route(error, dropping);
  } finally {
    if (lock !== undefined) admitted.delete(lock);
  }
}

async function tableMetadata(instance: CanvasInstance, table: TableInfo, ctx: Context) {
  const meta = await ctx.state.get(key(instance, table.name), MetaSchema);
  if (!meta) throw missing(table.name);
  return {
    ...DatasetTableSchema.parse({
      table_name: table.name,
      row_count: table.rowCount,
      columns: table.columns.map((column) => ({ ...column, nullable: column.nullable ?? true })),
      grain: meta.grain,
      complete: true,
      created_at: meta.created_at,
      expires_at: table.expiresAt ?? instance.expiresAt,
    }),
    source_tool: meta.source_tool,
    ...(meta.provenance && { provenance: meta.provenance }),
    ...(meta.sql !== undefined && { sql: meta.sql }),
  };
}

async function dataset(instance: CanvasInstance, names: string[], ctx: Context): Promise<Dataset> {
  const tables = await instance.describe();
  const selected = [];
  for (const name of names) {
    const table = tables.find((entry) => entry.name === name);
    if (!table) throw missing(name);
    selected.push(await tableMetadata(instance, table, ctx));
  }
  return DatasetSchema.parse({ ...pointers(instance.canvasId, names), tables: selected });
}

async function cleanup(instance: CanvasInstance, names: string[], ctx: Context): Promise<void> {
  const failures: unknown[] = [];
  for (const name of names) {
    try {
      await instance.drop(name);
      await ctx.state.delete(key(instance, name));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Could not remove incomplete canvas tables.');
}

/** Complete acquired and selected sets are supplied independently so staging never buffers the corpus. */
export interface StageFilingsInput {
  activities: RowSource<ActivityRow>;
  canvas_id?: string;
  provenance: z.infer<typeof ProvenanceSchema>;
  raw_filings: RowSource<Filing>;
  selected_filings: RowSource<Filing>;
  selections: Iterable<FilingSelection>;
  source_tool: string;
}

/** Register every intended row before publishing any dataset; failures roll back all new tables. */
export async function stageFilings(input: StageFilingsInput, ctx: Context): Promise<Dataset> {
  if (!input.provenance.coverage.complete)
    throw validationError('Complete acquisition is required before analytical staging.', {
      reason: 'invalid_filter',
    });
  return await operate(input.canvas_id, ctx, async (instance) => {
    const decisions = new Map<string, FilingAudit>();
    for (const selection of input.selections) {
      const common = {
        selected_filing_uuid: selection.selected_filing_uuid ?? null,
        ambiguous: selection.status === 'ambiguous',
      };
      for (const id of selection.superseded_filing_uuids)
        decisions.set(id, { ...common, selection_status: 'superseded' });
      for (const id of selection.candidate_filing_uuids)
        decisions.set(id, { ...common, selection_status: selection.status });
    }
    const existing = new Set((await instance.describe()).map((table) => table.name));
    const registrations = [
      {
        prefix: 'raw_filings',
        rows: filingRows(input.raw_filings, decisions, ctx.signal),
        schema: filingColumns,
        grain: 'One acquired filing version per filing_uuid; all amendments retained.',
      },
      {
        prefix: 'selected_filings',
        rows: filingRows(input.selected_filings, decisions, ctx.signal),
        schema: filingColumns,
        grain:
          'One unambiguous latest posted quarterly filing per registrant/client/year/period, after local predicates; income and expenses remain separate.',
      },
      {
        prefix: 'activities',
        rows: activityRows(input.activities, ctx.signal),
        schema: activityColumns,
        grain:
          'One complete activity per selected filing_uuid and original activity_index; no filing-level money.',
      },
    ];
    const attempted: string[] = [];
    try {
      for (const registration of registrations) {
        ctx.signal?.throwIfAborted();
        let name = fresh(registration.prefix);
        while (existing.has(name)) name = fresh(registration.prefix);
        existing.add(name);
        attempted.push(name);
        const created_at = new Date().toISOString();
        await instance.registerTable(name, registration.rows, {
          schema: registration.schema,
          ...(ctx.signal && { signal: ctx.signal }),
        });
        await ctx.state.set(
          key(instance, name),
          {
            created_at,
            grain: registration.grain,
            source_tool: input.source_tool,
            provenance: input.provenance,
            materialized_result: false,
          } satisfies Meta,
          { ttl: Math.ceil(config.canvas.absoluteCapMs / 1000) },
        );
      }
      ctx.signal?.throwIfAborted();
      return await dataset(instance, attempted, ctx);
    } catch (error) {
      try {
        await cleanup(instance, attempted, ctx);
      } catch (cleanupError) {
        if (ctx.signal?.aborted) throw ctx.signal.reason;
        throw new AggregateError(
          [error, cleanupError],
          'Canvas staging failed and cleanup was incomplete.',
        );
      }
      throw error;
    }
  });
}

/** Describe only a caller-supplied canvas token; never enumerate tenant canvases. */
export async function describeCanvas(
  input: { canvas_id: string; table_name?: string },
  ctx: Context,
) {
  return await operate(input.canvas_id, ctx, async (instance) => {
    ctx.signal?.throwIfAborted();
    const tables = await instance.describe(
      input.table_name === undefined ? undefined : { tableName: input.table_name },
    );
    if (input.table_name !== undefined && tables.length === 0) throw missing(input.table_name);
    const metadata = [];
    const routing = pointers(
      instance.canvasId,
      tables.map((table) => table.name),
    );
    for (const table of tables) {
      metadata.push(await tableMetadata(instance, table, ctx));
      if (fullResultBytes({ ...routing, tables: metadata }) > FULL_RESULT_TARGET_BYTES)
        throw oversized(instance, table.name);
    }
    ctx.signal?.throwIfAborted();
    return {
      ...routing,
      tables: metadata,
    };
  });
}

/** A new SQL result and a continuation are mutually exclusive; continuation never reruns original SQL. */
export type CanvasQueryInput = { canvas_id: string; row_limit?: number } & (
  | { sql: string; register_as?: string; result_table?: never; offset?: never }
  | { result_table: string; offset?: number; sql?: never; register_as?: never }
);

function oversized(instance: CanvasInstance, name: string): McpError {
  return validationError('A complete query row or its metadata exceeds the response byte budget.', {
    reason: 'query_row_too_large',
    ...pointers(instance.canvasId, [name]),
    result_table: name,
    recovery: {
      hint: `Call ${DESCRIBE} to inspect ${name}, then use ${QUERY} with a fresh SELECT projecting fewer columns or explicit SUBSTR windows of the oversized value. The complete result remains staged as ${name}.`,
    },
  });
}

/** Materialize complete SELECT results, then deliver whole rows within the complete wire budget. */
export async function queryCanvas(input: CanvasQueryInput, ctx: Context) {
  const requested = input.row_limit ?? 25;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 100)
    throw validationError('row_limit must be an integer from 1 through 100.', {
      reason: 'invalid_filter',
    });
  const rowLimit = Math.min(requested, configuredRowLimit ?? config.canvas.defaultRowLimit);
  return await operate(input.canvas_id, ctx, async (instance) => {
    let name: string;
    let offset: number;
    if (input.sql !== undefined) {
      name = input.register_as ?? fresh('result');
      offset = 0;
      await instance.query(input.sql, {
        registerAs: name,
        preview: 0,
        rowLimit,
        ...(ctx.signal && { signal: ctx.signal }),
      });
      try {
        await ctx.state.set(
          key(instance, name),
          {
            created_at: new Date().toISOString(),
            grain: 'One row of the complete materialized SQL result.',
            source_tool: QUERY,
            sql: input.sql,
            materialized_result: true,
          } satisfies Meta,
          { ttl: Math.ceil(config.canvas.absoluteCapMs / 1000) },
        );
      } catch (error) {
        await cleanup(instance, [name], ctx);
        throw error;
      }
    } else {
      name = input.result_table;
      offset = input.offset ?? 0;
      const meta = await ctx.state.get(key(instance, name), MetaSchema);
      if (!meta?.materialized_result) throw missing(name);
    }
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw validationError('offset must be a nonnegative safe integer.', {
        reason: 'invalid_filter',
      });
    try {
      return await queryWindow(instance, name, offset, rowLimit, requested, ctx);
    } catch (error) {
      if (
        input.sql !== undefined &&
        !(error instanceof McpError && error.data?.reason === 'query_row_too_large')
      ) {
        try {
          await cleanup(instance, [name], ctx);
        } catch (cleanupError) {
          if (ctx.signal?.aborted) throw ctx.signal.reason;
          throw new AggregateError(
            [error, cleanupError],
            'Canvas query failed and cleanup was incomplete.',
          );
        }
      }
      throw error;
    }
  });
}

async function queryWindow(
  instance: CanvasInstance,
  name: string,
  offset: number,
  rowLimit: number,
  requested: number,
  ctx: Context,
) {
  const result = await instance.query(
    `SELECT * FROM ${quoteIdentifier(name)} ORDER BY ALL LIMIT ${rowLimit} OFFSET ${offset}`,
    { rowLimit, ...(ctx.signal && { signal: ctx.signal }) },
  );
  const staged = await dataset(instance, [name], ctx);
  const table = staged.tables[0];
  if (!table) throw missing(name);
  if (offset > table.row_count)
    throw validationError('offset exceeds the materialized result row count.', {
      reason: 'invalid_filter',
    });
  const rows = z.array(z.record(z.string(), JsonValueSchema)).parse(result.rows);
  const output = (delivered: typeof rows) => ({
    ...pointers(instance.canvasId, [name]),
    dataset: staged,
    result_table: name,
    columns: table.columns,
    rows: delivered,
    row_count: table.row_count,
    rows_returned: delivered.length,
    offset,
    ...(offset + delivered.length < table.row_count && {
      next_offset: offset + delivered.length,
    }),
    output_complete: offset + delivered.length >= table.row_count,
    truncated: offset + delivered.length < table.row_count,
    row_order: 'canonical_values' as const,
    ...(rowLimit < requested && { effective_row_limit: rowLimit }),
  });
  const delivered: typeof rows = [];
  if (fullResultBytes(output(delivered)) > FULL_RESULT_TARGET_BYTES)
    throw oversized(instance, name);
  for (const row of rows) {
    delivered.push(row);
    if (fullResultBytes(output(delivered)) > FULL_RESULT_TARGET_BYTES) {
      delivered.pop();
      if (delivered.length === 0) throw oversized(instance, name);
      break;
    }
  }
  ctx.signal?.throwIfAborted();
  return {
    ...QueryWindowSchema.parse(output(delivered)),
    ...(rowLimit < requested && { effective_row_limit: rowLimit }),
  };
}

/** Remove one table and its provenance; unknown canvases carry deletion-specific recovery. */
export async function dropCanvasTable(
  input: { canvas_id: string; table_name: string },
  ctx: Context,
) {
  return await operate(
    input.canvas_id,
    ctx,
    async (instance) => {
      ctx.signal?.throwIfAborted();
      const dropped = await instance.drop(input.table_name);
      await ctx.state.delete(key(instance, input.table_name));
      return {
        ...pointers(instance.canvasId, [input.table_name]),
        table_name: input.table_name,
        dropped,
      };
    },
    true,
  );
}
