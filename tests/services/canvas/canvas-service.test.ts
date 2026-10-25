/** @fileoverview Real DuckDB staging, rollback and lifecycle behavior. @module tests/services/canvas/canvas-service */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeCanvas,
  queryCanvas,
  stageFilings,
} from '../../../src/services/canvas/canvas-service.js';
import { analyzeFilings } from '../../../src/services/lobbying/analysis.js';
import { filing, fixture, provenance, stage } from './fixture.js';

describe('complete streamed disclosure staging', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.close();
  });

  it('stages every row with null-leading explicit schema, exact money and complete nested source text', async () => {
    const data = await stage(f);
    expect(data.tables.map((t) => t.row_count)).toEqual([3, 3, 1]);
    expect(data.describe_tool).toBe('uslobbying_dataframe_describe');
    expect(data.query_tool).toBe('uslobbying_dataframe_query');
    for (const table of data.tables) expect(data.guidance).toContain(table.table_name);
    const raw = data.tables[0]!;
    expect(raw.columns.find((c) => c.name === 'income_usd')).toEqual({
      name: 'income_usd',
      type: 'VARCHAR',
      nullable: true,
    });
    expect(data.tables[2]!.columns.map((c) => c.name)).not.toContain('income_usd');
    const described = await describeCanvas({ canvas_id: data.canvas_id }, f.ctx);
    for (const table of described.tables)
      expect(table).toMatchObject({ source_tool: 'uslobbying_get_client_profile', provenance });
    const result = await queryCanvas(
      {
        canvas_id: data.canvas_id,
        sql: `SELECT income_usd AS income, expenses_usd AS expenses, source_fields FROM ${raw.table_name}`,
        row_limit: 100,
      },
      f.ctx,
    );
    expect(result.rows).toContainEqual({
      income: '9007199254740993.01',
      expenses: '0.09',
      source_fields: JSON.stringify({
        future: { nested: ['a', null] },
        source_fields: { literal: true },
      }),
    });
    const sum = await queryCanvas(
      {
        canvas_id: data.canvas_id,
        sql: `SELECT SUM(CAST(income_usd AS DECIMAL(38,2))) AS total FROM ${raw.table_name}`,
      },
      f.ctx,
    );
    expect(sum.rows).toEqual([{ total: '9007199254740993.10' }]);
    const activity = await queryCanvas(
      {
        canvas_id: data.canvas_id,
        sql: `SELECT description, source_fields FROM ${data.tables[2]!.table_name}`,
      },
      f.ctx,
    );
    expect(activity.rows).toEqual([
      { description: 'Source ``` text é', source_fields: JSON.stringify({ future: [1, 2] }) },
    ]);
  });

  it('rolls back all tables if a later stream fails', async () => {
    async function* broken() {
      yield filing(1);
      throw new Error('controlled source failure');
    }
    await expect(
      stageFilings(
        {
          canvas_id: f.instance.canvasId,
          raw_filings: [filing(1)],
          ...{ selections: (await analyzeFilings([filing(1)])).selections },
          selected_filings: broken(),
          activities: [],
          provenance,
          source_tool: 'uslobbying_get_client_profile',
        },
        f.ctx,
      ),
    ).rejects.toThrow('controlled source failure');
    expect(await f.instance.describe()).toEqual([]);
  });

  it('stages rows beyond the provider preview without an acquisition cap', async () => {
    const rows = Array.from({ length: 151 }, (_, index) => filing(index + 1));
    const data = await stage(f, rows);
    expect(data.tables.map((table) => table.row_count)).toEqual([151, 151, 0]);
    const last = await queryCanvas(
      {
        canvas_id: data.canvas_id,
        sql: `SELECT filing_uuid FROM ${data.tables[0]!.table_name} ORDER BY filing_uuid DESC LIMIT 1`,
      },
      f.ctx,
    );
    expect(last.rows).toEqual([{ filing_uuid: '00000000-0000-4000-8000-000000000151' }]);
  });

  it('rolls back after cancellation during streaming without advertising partial tables', async () => {
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal });
    async function* interrupted() {
      yield filing(1);
      controller.abort(new DOMException('Cancelled fixture', 'AbortError'));
      yield filing(2);
    }
    await expect(
      stageFilings(
        {
          canvas_id: f.instance.canvasId,
          raw_filings: interrupted(),
          ...{ selections: (await analyzeFilings([filing(1), filing(2)])).selections },
          selected_filings: [],
          activities: [],
          provenance,
          source_tool: 'uslobbying_get_client_profile',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await f.instance.describe()).toEqual([]);
  });

  it('rejects missing table and unknown canvas with actionable recovery', async () => {
    await expect(
      describeCanvas({ canvas_id: f.instance.canvasId, table_name: 'absent' }, f.ctx),
    ).rejects.toMatchObject({
      data: {
        reason: 'missing_table',
        recovery: { hint: expect.stringContaining('uslobbying_dataframe_describe') },
      },
    });
    await expect(describeCanvas({ canvas_id: 'abcdefghij' }, f.ctx)).rejects.toMatchObject({
      data: {
        reason: 'canvas_not_found',
        recovery: { hint: expect.stringContaining('uslobbying_get_client_profile') },
      },
    });
  });

  it('rejects describe metadata when stored SQL exceeds the complete wire budget', async () => {
    await queryCanvas(
      {
        canvas_id: f.instance.canvasId,
        sql: `SELECT 1 AS n /* ${'long stored SQL '.repeat(2000)} */`,
        register_as: 'long_sql',
      },
      f.ctx,
    );
    await expect(
      describeCanvas({ canvas_id: f.instance.canvasId, table_name: 'long_sql' }, f.ctx),
    ).rejects.toMatchObject({
      data: {
        reason: 'query_row_too_large',
        canvas_id: f.instance.canvasId,
        result_table: 'long_sql',
        describe_tool: 'uslobbying_dataframe_describe',
        query_tool: 'uslobbying_dataframe_query',
        recovery: { hint: expect.stringContaining('SELECT') },
      },
    });
  });

  it('keeps amendment, ambiguous and excluded decisions queryable without double counting money', async () => {
    const original = filing(101, { income: '999.00', client: { id: '101', name: 'Amended' } });
    const amendment = filing(102, {
      income: '12.34',
      expenses: '0.09',
      client: original.client,
      dt_posted: '2024-04-02T00:00:00Z',
      filing_type: '1AY',
      lobbying_activities: [
        { general_issue_code: 'TEC' },
        { general_issue_code: 'TEC' },
        { general_issue_code: 'SCI' },
      ],
      selection_status: 'source supplied value',
    });
    const candidateA = filing(103, { income: '1000.00', client: { id: '103', name: 'Ambiguous' } });
    const candidateB = filing(104, { income: '2000.00', client: candidateA.client });
    const registration = filing(105, {
      income: '3000.00',
      filing_type: 'RR',
      client: { id: '105', name: 'Registration' },
    });
    const rows = [original, amendment, candidateA, candidateB, registration];
    const analysis = await analyzeFilings(rows);
    const input = {
      canvas_id: f.instance.canvasId,
      raw_filings: rows,
      selected_filings: analysis.selected,
      selections: analysis.selections,
      activities: analysis.activities,
      provenance,
      source_tool: 'uslobbying_get_client_profile',
    };
    const data = await stageFilings(input, f.ctx);
    const raw = data.tables[0]!;
    const selected = data.tables[1]!;
    const audit = await queryCanvas(
      {
        canvas_id: data.canvas_id,
        sql: `SELECT filing_uuid, income_usd, expenses_usd, selection_status, selected_filing_uuid, issue_count, ambiguous FROM ${raw.table_name} ORDER BY filing_uuid`,
        row_limit: 100,
      },
      f.ctx,
    );
    expect(audit.rows).toEqual([
      {
        filing_uuid: original.filing_uuid,
        income_usd: '999.00',
        expenses_usd: null,
        selection_status: 'superseded',
        selected_filing_uuid: amendment.filing_uuid,
        issue_count: 0,
        ambiguous: false,
      },
      {
        filing_uuid: amendment.filing_uuid,
        income_usd: '12.34',
        expenses_usd: '0.09',
        selection_status: 'selected',
        selected_filing_uuid: amendment.filing_uuid,
        issue_count: 2,
        ambiguous: false,
      },
      {
        filing_uuid: candidateA.filing_uuid,
        income_usd: '1000.00',
        expenses_usd: null,
        selection_status: 'ambiguous',
        selected_filing_uuid: null,
        issue_count: 0,
        ambiguous: true,
      },
      {
        filing_uuid: candidateB.filing_uuid,
        income_usd: '2000.00',
        expenses_usd: null,
        selection_status: 'ambiguous',
        selected_filing_uuid: null,
        issue_count: 0,
        ambiguous: true,
      },
      {
        filing_uuid: registration.filing_uuid,
        income_usd: '3000.00',
        expenses_usd: null,
        selection_status: 'excluded',
        selected_filing_uuid: null,
        issue_count: 0,
        ambiguous: false,
      },
    ]);
    const selectedRows = await queryCanvas(
      {
        canvas_id: data.canvas_id,
        sql: `SELECT filing_uuid, selected_filing_uuid, issue_count, ambiguous FROM ${selected.table_name}`,
      },
      f.ctx,
    );
    expect(selectedRows.rows).toEqual([
      {
        filing_uuid: amendment.filing_uuid,
        selected_filing_uuid: amendment.filing_uuid,
        issue_count: 2,
        ambiguous: false,
      },
    ]);
    const sum = await queryCanvas(
      {
        canvas_id: data.canvas_id,
        sql: `SELECT SUM(CAST(income_usd AS DECIMAL(38,2))) AS income_total, SUM(CAST(expenses_usd AS DECIMAL(38,2))) AS expenses_total FROM ${raw.table_name} WHERE selection_status = 'selected'`,
      },
      f.ctx,
    );
    expect(sum.rows).toEqual([{ income_total: '12.34', expenses_total: '0.09' }]);
    const source = await queryCanvas(
      { canvas_id: data.canvas_id, sql: `SELECT source_fields FROM ${selected.table_name}` },
      f.ctx,
    );
    expect(JSON.parse(String(source.rows[0]!.source_fields))).toMatchObject({
      selection_status: 'source supplied value',
    });
  });
});
