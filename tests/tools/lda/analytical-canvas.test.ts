/** @fileoverview Analytical delivery retains complete SQL staging and stable routing. @module tests/tools/lda/analytical-canvas */
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, it, vi } from 'vitest';
import { getClientProfile } from '../../../src/mcp-server/tools/definitions/lda/get-client-profile.tool.js';
import { describeCanvas, queryCanvas } from '../../../src/services/canvas/canvas-service.js';
import { getLdaService, initLdaService } from '../../../src/services/lda/lda-service.js';
import { filing, fixture } from '../../services/canvas/fixture.js';

it('delivers dataset metadata once, replays it exactly and stages omitted sets completely', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const rows = Array.from({ length: 25 }, (_, n) =>
    filing(n + 1, {
      lobbying_activities: [{ general_issue_code: 'TEC', description: 'é🌲'.repeat(100) }],
    }),
  );
  let requests = 0;
  initLdaService({
    fetch: async () => {
      requests++;
      return Response.json({ count: 25, next: null, results: rows });
    },
  });
  const state = createMockContext().state;
  const definition = {
    ...getClientProfile,
    handler: (
      args: Parameters<typeof getClientProfile.handler>[0],
      ctx: Parameters<typeof getClientProfile.handler>[1],
    ) => getClientProfile.handler(args, { ...ctx, state }),
  };
  const invoke = async (input: Record<string, unknown>) => {
    const pending = runToolContract(definition, input);
    await vi.advanceTimersByTimeAsync(4100);
    const result = await pending;
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const data = z.record(z.string(), z.unknown()).parse(result.structuredContent);
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const fence = text.slice(0, text.indexOf('json\n'));
    expect(
      JSON.parse(text.slice(fence.length + 5, text.indexOf(`\n${fence}`, fence.length + 5))),
    ).toEqual(data);
    return data;
  };
  try {
    const first = await invoke({
      mode: 'profile',
      client_ids: ['1', '2'],
      years: [2024],
      max_pages: 1,
      page_size: 10,
      row_sets: ['activities'],
    });
    expect(first.status).toBe('collecting');
    expect(first).not.toHaveProperty('dataset');
    const firstCursor = first.next_cursor;
    let output = await invoke({ cursor: firstCursor });
    expect(output).toHaveProperty('dataset');
    expect(await invoke({ cursor: firstCursor })).toEqual(output);
    const dataset = z
      .object({
        canvas_id: z.string(),
        tables: z.array(z.object({ table_name: z.string(), row_count: z.number() })),
      })
      .parse(output.dataset);
    expect(dataset.tables.map((table) => table.row_count)).toEqual([25, 25, 25]);
    const described = await describeCanvas({ canvas_id: dataset.canvas_id }, { ...f.ctx, state });
    expect(described.tables).toHaveLength(3);
    const query = await queryCanvas(
      {
        canvas_id: dataset.canvas_id,
        sql: `SELECT COUNT(*) AS n FROM ${dataset.tables[0]!.table_name}`,
      },
      { ...f.ctx, state },
    );
    expect(query.rows).toEqual([{ n: '25' }]);
    let delivered = z.number().parse(output.records_returned);
    let windows = 1;
    while (!output.output_complete && windows < 100) {
      output = await invoke({ cursor: output.next_cursor });
      expect(output).not.toHaveProperty('dataset');
      expect(output).toMatchObject({
        canvas_id: dataset.canvas_id,
        describe_tool: 'uslobbying_dataframe_describe',
        query_tool: 'uslobbying_dataframe_query',
        guidance: expect.stringContaining(dataset.tables[0]!.table_name),
      });
      expect(output).not.toHaveProperty('raw_filings');
      expect(output.row_set_totals).toMatchObject({
        raw_filings: 25,
        selected_filings: 25,
        activities: 25,
      });
      delivered += z.number().parse(output.records_returned);
      windows++;
    }
    expect(output.output_complete).toBe(true);
    expect(delivered).toBe(25);
    expect(windows).toBe(3);
    expect(requests).toBe(2);
  } finally {
    getLdaService().dispose();
    await f.close();
    vi.useRealTimers();
  }
});

it('stages identical tables and totals whether or not include strips delivered activity fields', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const description = 'Spectrum auction oversight é🌲';
  const rows = Array.from({ length: 3 }, (_, n) =>
    filing(n + 1, {
      lobbying_activities: [
        {
          general_issue_code: 'TEC',
          description,
          lobbyists: [{ lobbyist: { id: '7' }, covered_position: 'Former aide', new: false }],
        },
      ],
    }),
  );
  initLdaService({
    fetch: async () => Response.json({ count: rows.length, next: null, results: rows }),
  });
  const state = createMockContext().state;
  const handler: typeof getClientProfile.handler = (args, ctx) =>
    getClientProfile.handler(args, { ...ctx, state });
  async function run(include: Parameters<typeof handler>[0]['include']) {
    const pending = runToolContract(
      { ...getClientProfile, handler },
      { mode: 'profile', client_ids: ['1'], years: [2024], ...(include ? { include } : {}) },
    );
    await vi.advanceTimersByTimeAsync(4100);
    const result = await pending;
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const output = z.record(z.string(), z.unknown()).parse(result.structuredContent);
    expect(output.output_complete).toBe(true);
    const dataset = z
      .object({
        canvas_id: z.string(),
        tables: z.array(
          z.object({ table_name: z.string(), row_count: z.number(), grain: z.string() }),
        ),
      })
      .parse(output.dataset);
    const tables = [];
    for (const table of dataset.tables) {
      const query = await queryCanvas(
        { canvas_id: dataset.canvas_id, sql: `SELECT * FROM ${table.table_name}` },
        { ...f.ctx, state },
      );
      tables.push({
        grain: table.grain,
        row_count: table.row_count,
        rows: query.rows.map((row) => JSON.stringify(row)).sort(),
      });
    }
    return { output, tables };
  }
  try {
    const narrow = await run(undefined);
    const wide = await run(['activity_descriptions', 'activity_lobbyists']);
    expect(narrow.tables).toEqual(wide.tables);
    expect(narrow.tables.flatMap((table) => table.rows).join('\n')).toContain(description);
    expect(narrow.output.row_set_totals).toEqual(wide.output.row_set_totals);
    const delivered = (output: Record<string, unknown>) => JSON.stringify(output.raw_filings);
    expect(delivered(narrow.output)).not.toContain(description);
    expect(delivered(narrow.output)).not.toContain('Former aide');
    expect(delivered(wide.output)).toContain(description);
    expect(delivered(wide.output)).toContain('Former aide');
  } finally {
    getLdaService().dispose();
    await f.close();
    vi.useRealTimers();
  }
});
