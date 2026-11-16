/** @fileoverview Public dataframe contracts over real DuckDB. @module tests/tools/dataframe */

import type { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { QueryWindowSchema } from '../../src/domain/contracts.js';
import { dataframeDescribeTool } from '../../src/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '../../src/mcp-server/tools/definitions/dataframe-query.tool.js';
import {
  dropCanvasTable,
  queryCanvas,
  setCanvas,
} from '../../src/services/canvas/canvas-service.js';
import { filing, fixture, stage } from '../services/canvas/fixture.js';

describe('dataframe contracts', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await f.close();
  });
  async function query(input: z.input<typeof dataframeQueryTool.input>) {
    const handler: typeof dataframeQueryTool.handler = (args, ctx) =>
      dataframeQueryTool.handler(args, { ...ctx, state: f.ctx.state });
    return await runToolContract(
      {
        ...dataframeQueryTool,
        handler,
      },
      input,
    );
  }
  /** Run one query call, returning its result and every clamp the call logged. */
  async function logged(input: z.input<typeof dataframeQueryTool.input>) {
    let info: MockInstance | undefined;
    const handler: typeof dataframeQueryTool.handler = (args, ctx) => {
      info = vi.spyOn(ctx.log, 'info');
      return dataframeQueryTool.handler(args, { ...ctx, state: f.ctx.state });
    };
    const result = await runToolContract({ ...dataframeQueryTool, handler }, input);
    const clamps = (info?.mock.calls ?? []).filter(
      ([message]) => message === 'Clamped a count control to its served ceiling.',
    );
    return { result, clamps: clamps.map((call) => call[1]) };
  }
  function exact(result: Awaited<ReturnType<typeof query>>) {
    expect(result.isError).not.toBe(true);
    const text = result.content.find((c) => c.type === 'text');
    if (text?.type !== 'text') throw new Error('Missing text');
    const json = text.text.slice(text.text.indexOf('\n') + 1, text.text.lastIndexOf('\n```'));
    expect(JSON.parse(json)).toEqual(result.structuredContent);
    return QueryWindowSchema.parse(result.structuredContent);
  }

  it('materializes once and pages duplicates without losing multiplicity', async () => {
    const data = await stage(f);
    const executed = vi.spyOn(f.canvas.getProvider(), 'query');
    const first = exact(
      await query({
        canvas_id: data.canvas_id,
        sql: 'SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 1 ORDER BY n DESC',
        register_as: 'stable',
        row_limit: 1,
      }),
    );
    expect(first.rows).toEqual([{ n: 2 }]);
    expect(first.row_count).toBe(3);
    expect(first.next_offset).toBe(1);
    expect(first.row_order).toBe('sql_result');
    const second = exact(
      await query({ canvas_id: data.canvas_id, result_table: 'stable', offset: 1, row_limit: 1 }),
    );
    const third = exact(
      await query({ canvas_id: data.canvas_id, result_table: 'stable', offset: 2, row_limit: 100 }),
    );
    expect([...first.rows, ...second.rows, ...third.rows]).toEqual([{ n: 2 }, { n: 1 }, { n: 1 }]);
    expect(third.output_complete).toBe(true);
    const end = exact(
      await query({ canvas_id: data.canvas_id, result_table: 'stable', offset: 3 }),
    );
    expect(end.rows).toEqual([]);
    expect(end).toMatchObject({ rows_returned: 0, output_complete: true, truncated: false });
    expect(end.next_offset).toBeUndefined();
    expect(executed.mock.calls.filter((call) => call[3]?.registerAs === 'stable')).toHaveLength(1);
    const beyond = await query({ canvas_id: data.canvas_id, result_table: 'stable', offset: 4 });
    expect(beyond).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'invalid_filter' } } },
    });
    expect(JSON.stringify(beyond.content)).toContain('offset at most its row_count');
  });

  it.each([
    { sql: 'SELECT 1', result_table: 'x' },
    { sql: 'SELECT 1', offset: 0 },
    { result_table: 'x', register_as: 'y' },
    {},
  ])('routes mutually exclusive selectors %j', async (selectors) => {
    const result = await query({ canvas_id: f.instance.canvasId, ...selectors });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'invalid_filter' } } },
    });
    expect(JSON.stringify(result.content)).toContain('result_table');
  });

  it('preserves missing-table and binder reasons and advertised recovery', async () => {
    const missing = await query({ canvas_id: f.instance.canvasId, result_table: 'gone' });
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'missing_table' } } },
    });
    expect(JSON.stringify(missing.content)).toContain('uslobbying_dataframe_describe');
    const invalid = await query({ canvas_id: f.instance.canvasId, sql: 'SELECT missing_column' });
    expect(invalid).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'invalid_sql' } } },
    });
    expect(JSON.stringify(invalid.content)).toContain('TRY_CAST');
    exact(
      await query({ canvas_id: f.instance.canvasId, sql: 'SELECT 1 AS n', register_as: 'clash' }),
    );
    const clash = await query({
      canvas_id: f.instance.canvasId,
      sql: 'SELECT 2 AS n',
      register_as: 'clash',
    });
    expect(clash).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'register_as_clash' } } },
    });
    expect(JSON.stringify(clash.content)).toContain('register_as');
    expect(
      exact(await query({ canvas_id: f.instance.canvasId, result_table: 'clash' })).rows,
    ).toEqual([{ n: 1 }]);
  });

  it('delivers rows far wider than 24,000 bytes whole at the requested count on both surfaces', async () => {
    const page = exact(
      await query({
        canvas_id: f.instance.canvasId,
        sql: "SELECT i, repeat('é', 15000) AS text FROM (VALUES (0), (1), (2), (3), (4)) t(i) ORDER BY i",
        register_as: 'wide',
        row_limit: 4,
      }),
    );
    expect(page).toMatchObject({ rows_returned: 4, row_count: 5, next_offset: 4 });
    expect(page.rows.map((row) => row.i)).toEqual([0, 1, 2, 3]);
    expect(page.rows.every((row) => row.text === 'é'.repeat(15000))).toBe(true);
    const single = exact(
      await query({ canvas_id: f.instance.canvasId, sql: "SELECT repeat('x', 30000) AS text" }),
    );
    expect(Buffer.byteLength(JSON.stringify(single.rows[0]), 'utf8')).toBeGreaterThan(24_000);
    expect(single).toMatchObject({ rows: [{ text: 'x'.repeat(30000) }], output_complete: true });
  });

  it('returns SELECT * over staged raw filings as whole rows', async () => {
    const description = 'd'.repeat(30000);
    const data = await stage(f, [
      filing(1),
      filing(2, { lobbying_activities: [{ general_issue_code: 'TEC', description }] }),
      filing(3),
    ]);
    const page = exact(
      await query({
        canvas_id: data.canvas_id,
        sql: `SELECT * FROM ${data.tables[0]!.table_name} ORDER BY filing_uuid`,
      }),
    );
    expect(page).toMatchObject({ rows_returned: 3, row_count: 3, output_complete: true });
    expect(page.rows.map((row) => row.filing_uuid)).toEqual(
      [1, 2, 3].map((n) => filing(n).filing_uuid),
    );
    expect(JSON.parse(String(page.rows[1]!.lobbying_activities))).toEqual([
      expect.objectContaining({ general_issue_code: 'TEC', description }),
    ]);
  });

  it('returns exactly the requested 100-row boundary while staging the complete result', async () => {
    const sql = `SELECT * FROM (VALUES ${Array.from({ length: 101 }, (_, i) => `(${i})`).join(',')}) t(n)`;
    const page = exact(await query({ canvas_id: f.instance.canvasId, sql, row_limit: 100 }));
    expect(page.rows).toHaveLength(100);
    expect(page.row_count).toBe(101);
    expect(page.next_offset).toBe(100);
    const last = exact(
      await query({
        canvas_id: f.instance.canvasId,
        result_table: page.result_table,
        offset: 100,
        row_limit: 100,
      }),
    );
    expect(last.rows).toEqual([{ n: 100 }]);
  });

  it('delivers results and describes tables whose metadata passes 24,000 bytes', async () => {
    const column = `column_${'x'.repeat(13000)}`;
    const page = exact(
      await query({
        canvas_id: f.instance.canvasId,
        sql: `SELECT 1 AS "${column}"`,
        register_as: 'huge_metadata',
      }),
    );
    expect(page.rows).toEqual([{ [column]: 1 }]);
    expect(page.columns).toEqual([{ name: column, type: 'INTEGER', nullable: true }]);
    const describe: typeof dataframeDescribeTool.handler = (args, ctx) =>
      dataframeDescribeTool.handler(args, { ...ctx, state: f.ctx.state });
    const described = await runToolContract(
      { ...dataframeDescribeTool, handler: describe },
      { canvas_id: f.instance.canvasId },
    );
    expect(described.isError).not.toBe(true);
    expect(described.structuredContent).toMatchObject({
      tables: [
        {
          table_name: 'huge_metadata',
          columns: [{ name: column }],
          sql: `SELECT 1 AS "${column}"`,
        },
      ],
    });
    expect(JSON.stringify(described.content)).toContain(column);
  });

  it('returns 25 rows by default and exactly the rest at the end', async () => {
    const { result, clamps } = await logged({
      canvas_id: f.instance.canvasId,
      sql: 'SELECT CAST(i AS INTEGER) AS i FROM range(130) t(i) ORDER BY i',
      register_as: 'counted',
    });
    const first = exact(result);
    expect(first.rows).toEqual(Array.from({ length: 25 }, (_, i) => ({ i })));
    expect(first).toMatchObject({ row_count: 130, next_offset: 25, delivery_limits: {} });
    expect(result.structuredContent).not.toHaveProperty('effective_row_limit');
    expect(clamps).toEqual([]);
    const full = exact(
      await query({ canvas_id: f.instance.canvasId, result_table: 'counted', row_limit: 100 }),
    );
    expect(full).toMatchObject({ rows_returned: 100, next_offset: 100, truncated: true });
    const rest = exact(
      await query({
        canvas_id: f.instance.canvasId,
        result_table: 'counted',
        offset: 100,
        row_limit: 100,
      }),
    );
    expect(rest.rows).toEqual(Array.from({ length: 30 }, (_, i) => ({ i: i + 100 })));
    expect(rest).toMatchObject({ output_complete: true, truncated: false });
    expect(rest.next_offset).toBeUndefined();
  });

  it('reads a float-noise row_limit as its integer, as the other count controls do', async () => {
    const page = exact(
      await query({
        canvas_id: f.instance.canvasId,
        sql: 'SELECT CAST(i AS INTEGER) AS i FROM range(30) t(i) ORDER BY i',
        row_limit: 20.000000000000004,
      }),
    );
    expect(page.rows).toEqual(Array.from({ length: 20 }, (_, i) => ({ i })));
    expect(page).toMatchObject({ rows_returned: 20, next_offset: 20, delivery_limits: {} });
  });

  it('rejects row_limit 101 with invalid_filter when USLOBBYING_CLAMP_LIMITS=false', async () => {
    vi.stubEnv('USLOBBYING_CLAMP_LIMITS', 'false');
    vi.resetModules();
    const service = await import('../../src/services/canvas/canvas-service.js');
    const { dataframeQueryTool: strict } = await import(
      '../../src/mcp-server/tools/definitions/dataframe-query.tool.js'
    );
    service.setCanvas(f.canvas, 100);
    try {
      const handler: typeof strict.handler = (args, ctx) =>
        strict.handler(args, { ...ctx, state: f.ctx.state });
      const run = (row_limit: number) =>
        runToolContract(
          { ...strict, handler },
          { canvas_id: f.instance.canvasId, sql: 'SELECT 1 AS n', row_limit },
        );
      const rejected = await run(101);
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: {
          error: { data: { reason: 'invalid_filter', field: 'row_limit', maximum: 100 } },
        },
      });
      expect(JSON.stringify(rejected.content)).toContain('row_limit cannot exceed 100.');
      expect(await f.instance.describe()).toEqual([]);
      const accepted = await run(100);
      expect(accepted.isError).not.toBe(true);
      expect(accepted.structuredContent).toMatchObject({ rows: [{ n: 1 }], delivery_limits: {} });
    } finally {
      service.setCanvas(undefined);
    }
  });

  it('routes expired canvas recovery on both response surfaces', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const result = await query({ canvas_id: f.instance.canvasId, sql: 'SELECT 1' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'canvas_not_found' } } },
    });
    expect(JSON.stringify(result.content)).toContain('uslobbying_get_client_profile');
  });

  it.each([false, true])('registers drop only when explicitly enabled: %s', async (enabled) => {
    vi.stubEnv('USLOBBYING_DATAFRAME_DROP_ENABLED', String(enabled));
    vi.resetModules();
    const { createDataframeDropTool } = await import(
      '../../src/mcp-server/tools/definitions/dataframe-drop.tool.js'
    );
    const definition = createDataframeDropTool();
    expect(Reflect.has(definition, '__mcpDisabled')).toBe(!enabled);
    if (!enabled)
      expect(Reflect.get(definition, '__mcpDisabled')).toMatchObject({
        hint: 'Set USLOBBYING_DATAFRAME_DROP_ENABLED=true to enable.',
      });
  });

  it.each([
    'DROP TABLE anything',
    "ATTACH ':memory:' AS other",
    "COPY (SELECT 1) TO '/tmp/forbidden.csv'",
    "SELECT * FROM read_csv('/tmp/absent.csv')",
    'SELECT * FROM information_schema.tables',
    'SELECT * FROM duckdb_tables()',
  ])('denies unsafe SQL: %s', async (sql) => {
    const result = await query({ canvas_id: f.instance.canvasId, sql });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('uslobbying_dataframe');
    expect(await f.instance.describe()).toEqual([]);
  });

  it('clamps requested SQL rows with provider disclosure on both surfaces', async () => {
    const { result, clamps } = await logged({
      canvas_id: f.instance.canvasId,
      sql: `SELECT * FROM (VALUES ${Array.from({ length: 102 }, (_, n) => `(${n})`).join(',')}) t(i)`,
      row_limit: 101,
    });
    const page = exact(result);
    expect(page.rows).toHaveLength(100);
    expect(page.delivery_limits).toEqual({ row_limit: { requested: 101, effective: 100 } });
    const clamp = { tool: 'uslobbying_dataframe_query', control: 'row_limit' };
    expect(clamps).toEqual([{ ...clamp, requested: 101, effective: 100 }]);
    setCanvas(f.canvas, 2);
    const limitedCall = await logged({
      canvas_id: f.instance.canvasId,
      result_table: page.result_table,
      offset: 100,
      row_limit: 200,
    });
    const limitedResult = limitedCall.result;
    const limited = exact(limitedResult);
    expect(limited.rows).toEqual([{ i: 100 }, { i: 101 }]);
    expect(limited.delivery_limits).toEqual({ row_limit: { requested: 200, effective: 2 } });
    expect(limitedResult.structuredContent).toMatchObject({ effective_row_limit: 2 });
    expect(limitedCall.clamps).toEqual([{ ...clamp, requested: 200, effective: 2 }]);
    const below = exact(
      await query({
        canvas_id: f.instance.canvasId,
        result_table: page.result_table,
        row_limit: 50,
      }),
    );
    expect(below.rows).toEqual([{ i: 0 }, { i: 1 }]);
    expect(below.delivery_limits).toEqual({ row_limit: { requested: 50, effective: 2 } });
    const empty = exact(
      await query({
        canvas_id: f.instance.canvasId,
        sql: 'SELECT 1 AS i WHERE false',
        row_limit: 200,
      }),
    );
    expect(empty.rows).toEqual([]);
    expect(empty.delivery_limits).toEqual({ row_limit: { requested: 200, effective: 2 } });
  });

  it.each([{ row_limit: 0 }, { offset: -1 }, { canvas_id: 'bad' }])(
    'rejects invalid schema arguments %j',
    async (invalid) => {
      const result = await query({ canvas_id: f.instance.canvasId, sql: 'SELECT 1', ...invalid });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: -32602 } },
      });
    },
  );

  it('describes empty canvas with routing and drops idempotently', async () => {
    const result = await runToolContract(dataframeDescribeTool, { canvas_id: f.instance.canvasId });
    expect(result).toMatchObject({
      structuredContent: {
        tables: [],
        describe_tool: 'uslobbying_dataframe_describe',
        query_tool: 'uslobbying_dataframe_query',
      },
    });
    await queryCanvas(
      { canvas_id: f.instance.canvasId, sql: 'SELECT 1 AS n', register_as: 'drop_me' },
      f.ctx,
    );
    expect(
      await dropCanvasTable({ canvas_id: f.instance.canvasId, table_name: 'drop_me' }, f.ctx),
    ).toMatchObject({ dropped: true, query_tool: 'uslobbying_dataframe_query' });
    expect(
      await dropCanvasTable({ canvas_id: f.instance.canvasId, table_name: 'drop_me' }, f.ctx),
    ).toMatchObject({ dropped: false });
  });
});
