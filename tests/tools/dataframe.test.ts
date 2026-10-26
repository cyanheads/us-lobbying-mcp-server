/** @fileoverview Public dataframe contracts over real DuckDB. @module tests/tools/dataframe */

import type { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FULL_RESULT_TARGET_BYTES, QueryWindowSchema } from '../../src/domain/contracts.js';
import { fullResultBytes } from '../../src/domain/format.js';
import { dataframeDescribeTool } from '../../src/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '../../src/mcp-server/tools/definitions/dataframe-query.tool.js';
import {
  dropCanvasTable,
  queryCanvas,
  setCanvas,
} from '../../src/services/canvas/canvas-service.js';
import { fixture, stage } from '../services/canvas/fixture.js';

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
        sql: 'SELECT 2 AS n UNION ALL SELECT 1 UNION ALL SELECT 1',
        register_as: 'stable',
        row_limit: 1,
      }),
    );
    expect(first.rows).toEqual([{ n: 1 }]);
    expect(first.row_count).toBe(3);
    expect(first.next_offset).toBe(1);
    const second = exact(
      await query({ canvas_id: data.canvas_id, result_table: 'stable', offset: 1, row_limit: 1 }),
    );
    const third = exact(
      await query({ canvas_id: data.canvas_id, result_table: 'stable', offset: 2, row_limit: 100 }),
    );
    expect([...first.rows, ...second.rows, ...third.rows]).toEqual([{ n: 1 }, { n: 1 }, { n: 2 }]);
    expect(third.output_complete).toBe(true);
    const end = exact(
      await query({ canvas_id: data.canvas_id, result_table: 'stable', offset: 3 }),
    );
    expect(end.rows).toEqual([]);
    expect(end.output_complete).toBe(true);
    expect(executed.mock.calls.filter((call) => call[3]?.registerAs === 'stable')).toHaveLength(1);
    const beyond = await query({ canvas_id: data.canvas_id, result_table: 'stable', offset: 4 });
    expect(beyond).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'invalid_filter' } } },
    });
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

  it('advances byte windows by actual whole rows and preserves both surfaces', async () => {
    const id = f.instance.canvasId;
    const first = exact(
      await query({
        canvas_id: id,
        sql: "SELECT i, repeat('é', 2000) AS text FROM (VALUES (0), (1), (2), (3), (4)) t(i)",
        register_as: 'wide',
        row_limit: 100,
      }),
    );
    expect(first.rows_returned).toBeGreaterThan(0);
    expect(first.rows_returned).toBeLessThan(5);
    let page = first;
    const rows = [...first.rows];
    while (!page.output_complete) {
      expect(fullResultBytes(page)).toBeLessThanOrEqual(FULL_RESULT_TARGET_BYTES);
      expect(page.next_offset).toBe(page.offset + page.rows_returned);
      page = exact(
        await query({
          canvas_id: id,
          result_table: 'wide',
          offset: page.next_offset!,
          row_limit: 100,
        }),
      );
      rows.push(...page.rows);
    }
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.i)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.every((row) => row.text === 'é'.repeat(2000))).toBe(true);
  });

  it('retains oversized results for narrower SQL recovery', async () => {
    const result = await query({
      canvas_id: f.instance.canvasId,
      sql: "SELECT repeat('x', 30000) AS text",
      register_as: 'oversize',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          data: {
            reason: 'query_row_too_large',
            canvas_id: f.instance.canvasId,
            result_table: 'oversize',
            describe_tool: 'uslobbying_dataframe_describe',
            query_tool: 'uslobbying_dataframe_query',
          },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('SUBSTR');
    const narrow = exact(
      await query({
        canvas_id: f.instance.canvasId,
        sql: 'SELECT SUBSTR(text, 1, 5) AS fragment FROM oversize',
      }),
    );
    expect(narrow.rows).toEqual([{ fragment: 'xxxxx' }]);
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

  it('rejects oversized schema metadata and retains a recoverable materialization', async () => {
    const column = `column_${'x'.repeat(13000)}`;
    const result = await query({
      canvas_id: f.instance.canvasId,
      sql: `SELECT 1 AS "${column}"`,
      register_as: 'huge_metadata',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { data: { reason: 'query_row_too_large', result_table: 'huge_metadata' } },
      },
    });
    expect(
      exact(
        await query({
          canvas_id: f.instance.canvasId,
          sql: `SELECT "${column}" AS small FROM huge_metadata`,
        }),
      ).rows,
    ).toEqual([{ small: 1 }]);
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
    const result = await query({
      canvas_id: f.instance.canvasId,
      sql: `SELECT * FROM (VALUES ${Array.from({ length: 102 }, (_, n) => `(${n})`).join(',')}) t(i)`,
      row_limit: 101,
    });
    const page = exact(result);
    expect(page.rows).toHaveLength(100);
    expect(page.delivery_limits).toEqual({ row_limit: { requested: 101, effective: 100 } });
    setCanvas(f.canvas, 2);
    const limitedResult = await query({
      canvas_id: f.instance.canvasId,
      result_table: page.result_table,
      offset: 100,
      row_limit: 200,
    });
    const limited = exact(limitedResult);
    expect(limited.rows).toEqual([{ i: 100 }, { i: 101 }]);
    expect(limited.delivery_limits).toEqual({ row_limit: { requested: 200, effective: 2 } });
    expect(limitedResult.structuredContent).toMatchObject({ effective_row_limit: 2 });
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
