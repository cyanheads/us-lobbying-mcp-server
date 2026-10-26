/** @fileoverview LDA tools through runtime argument/output/format contracts and real acquisition. @module tests/tools/lda/contracts */
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientProfile } from '../../../src/mcp-server/tools/definitions/lda/get-client-profile.tool.js';
import { getContributions } from '../../../src/mcp-server/tools/definitions/lda/get-contributions.tool.js';
import { getIssueSpending } from '../../../src/mcp-server/tools/definitions/lda/get-issue-spending.tool.js';
import { searchFilings } from '../../../src/mcp-server/tools/definitions/lda/search-filings.tool.js';
import { searchLobbyists } from '../../../src/mcp-server/tools/definitions/lda/search-lobbyists.tool.js';
import { setCanvas } from '../../../src/services/canvas/canvas-service.js';
import { getLdaService, initLdaService } from '../../../src/services/lda/lda-service.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const filing = (n = 1, extra: object = {}) => ({
  filing_uuid: uuid(n),
  filing_type: 'Q1',
  filing_year: 2024,
  filing_period: 'first_quarter',
  dt_posted: '2024-04-01T00:00:00Z',
  client: { id: '2', name: 'Synthetic client' },
  registrant: { id: '1', name: 'Synthetic firm' },
  income: '1.01',
  expenses: null,
  lobbying_activities: [
    {
      general_issue_code: 'TEC',
      description: 'é🌲 ```',
      government_entities: [{ id: 8, name: null }],
      lobbyists: [{ lobbyist: { id: '7' }, covered_position: 'Former aide', new: false }],
    },
  ],
  future: { nested: [null, false, 'é🌲'] },
  ...extra,
});
const page = (results: unknown[], next: string | null = null) => ({
  count: results.length,
  results,
  next,
});
type Definition = Parameters<typeof runToolContract>[0];
let state: ReturnType<typeof createMockContext>['state'];
let calls: URL[];
let respond: (url: URL) => Response;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01'));
  state = createMockContext().state;
  calls = [];
  setCanvas(undefined);
  respond = () => Response.json(page([]));
  initLdaService({
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://lda.gov') throw new Error(`Unexpected source ${url.origin}`);
      calls.push(url);
      return url.pathname.includes('/constants/')
        ? Response.json([
            { value: 'TEC', name: 'Telecommunications' },
            { value: 'HCR', name: 'Health' },
            { value: 'feca', name: 'FECA' },
          ])
        : respond(url);
    },
  });
});
afterEach(() => {
  getLdaService().dispose();
  vi.useRealTimers();
});

async function invoke(definition: Definition, input: Record<string, unknown>) {
  // The contract runner creates a request context per call; retain the real tenant store across requests.
  const bound = {
    ...definition,
    handler: (args: never, ctx: Parameters<typeof definition.handler>[1]) =>
      definition.handler(args, { ...ctx, state }),
  };
  const pending = runToolContract(bound, input);
  await vi.runAllTimersAsync();
  const result = await pending;
  const data = z.record(z.string(), z.unknown()).parse(result.structuredContent);
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  if (!result.isError) {
    const fence = text.slice(0, text.indexOf('json\n'));
    expect(
      JSON.parse(text.slice(fence.length + 5, text.indexOf(`\n${fence}`, fence.length + 5))),
    ).toEqual(data);
    expect(definition.output?.parse(data)).toEqual(data);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength + 512).toBeLessThanOrEqual(
      24_000,
    );
  }
  return { result, data, text };
}
function success(value: Awaited<ReturnType<typeof invoke>>) {
  expect(value.result.isError, value.text).not.toBe(true);
  return value.data;
}
function reason(value: Awaited<ReturnType<typeof invoke>>, expected: string) {
  expect(value.result.isError).toBe(true);
  expect(value.data).toMatchObject({
    error: { data: { reason: expected, recovery: { hint: expect.any(String) } } },
  });
  expect(value.text).toContain(expected);
  expect(value.text).toContain('Recovery:');
}

describe('LDA runtime contracts', () => {
  it('characterizes default analysis retaining selected and superseded raw versions', async () => {
    const older = filing(1, { dt_posted: '2024-03-01T00:00:00Z' });
    const selected = filing(2);
    respond = () => Response.json(page([older, selected]));
    const output = success(
      await invoke(getClientProfile, { mode: 'profile', client_ids: ['2'], years: [2024] }),
    );
    expect(output.raw_filings).toMatchObject([
      { filing_uuid: uuid(1), future: older.future },
      { filing_uuid: uuid(2), future: selected.future },
    ]);
    expect(output.selected_filings).toMatchObject([
      { filing_uuid: uuid(2), future: selected.future },
    ]);
    expect(output.row_set_totals).toMatchObject({
      raw_filings: 2,
      selected_filings: 1,
      activities: 1,
    });
  });
  it.each([
    { tool: getClientProfile, input: { mode: 'profile', client_ids: ['2'], years: [2024] } },
    { tool: getIssueSpending, input: { issue_code: 'TEC', years: [2024] } },
  ])(
    'selects inline analytical sets with complete totals and pinned normalized continuations',
    async ({ tool, input }) => {
      const rows = Array.from({ length: 25 }, (_, n) =>
        filing(n + 1, { client: { id: String(n + 1), name: `Client ${n + 1}` } }),
      );
      respond = () => Response.json(page(rows));
      let output = success(
        await invoke(tool, { ...input, row_sets: ['raw_filings', 'activities'] }),
      );
      expect(output.effective_filters).toMatchObject({ row_sets: ['activities', 'raw_filings'] });
      const seen: unknown[] = [];
      let delivered = 0;
      let windows = 0;
      for (; windows < 100; windows++) {
        expect(output).not.toHaveProperty('selected_filings');
        expect(output).not.toHaveProperty('selections');
        expect(output.row_set_totals).toMatchObject({
          selected_filings: 25,
          raw_filings: 25,
          activities: 25,
        });
        expect(output.row_set_offsets).toMatchObject({
          selected_filings: 0,
          activities: Math.min(delivered, 25),
          raw_filings: Math.min(Math.max(delivered - 25, 0), 25),
        });
        seen.push(...z.array(z.unknown()).parse(output.raw_filings ?? []));
        delivered +=
          z.number().parse(output.records_returned) + z.number().parse(output.records_deferred);
        if (output.output_complete) break;
        const cursor = output.next_cursor;
        reason(await invoke(tool, { cursor, row_sets: ['selected_filings'] }), 'cursor_invalid');
        const next = await invoke(tool, {
          cursor,
          ...(windows % 2 ? {} : { row_sets: ['activities', 'raw_filings'] }),
        });
        output = success(next);
        expect(success(await invoke(tool, { cursor }))).toEqual(output);
      }
      expect(output.output_complete).toBe(true);
      expect(windows).toBeGreaterThan(1);
      expect(delivered).toBe(50);
      expect(seen).toHaveLength(25);
      expect(calls.filter((url) => url.pathname === '/api/v1/filings/')).toHaveLength(1);
      expect(calls.every((url) => !url.searchParams.has('row_sets'))).toBe(true);
    },
  );
  it('keeps empty-partition notices when every selected domain set is empty', async () => {
    const output = success(
      await invoke(getClientProfile, {
        mode: 'profile',
        client_ids: ['2', '3'],
        years: [2024],
        row_sets: ['activities'],
      }),
    );
    expect(output.total_records).toBe(2);
    expect(output.records_returned).toBe(2);
    expect(output.output_complete).toBe(true);
    expect(output.row_set_offsets).toMatchObject({ activities: 0, raw_filings: 0 });
    expect(
      z
        .array(z.string())
        .parse(output.notices)
        .filter((notice) => notice.includes('client_id=')),
    ).toHaveLength(2);
  });
  it('describes an empty selected delivery set without denying acquired selected filings', async () => {
    respond = () =>
      Response.json(page([filing(1, { lobbying_activities: [{ general_issue_code: 'TEC' }] })]));
    const output = success(
      await invoke(getClientProfile, {
        mode: 'profile',
        client_ids: ['2'],
        years: [2024],
        row_sets: ['targeted_entities'],
      }),
    );
    expect(output).toMatchObject({
      total_records: 0,
      records_returned: 0,
      records_deferred: 0,
      output_complete: true,
      row_set_totals: { selected_filings: 1, targeted_entities: 0, raw_filings: 1 },
    });
    const notices = z.array(z.string()).parse(output.notices);
    expect(notices).not.toContain(
      'Source filings were acquired, but no quarterly filings survived version and issue selection.',
    );
    expect(notices).toContain(
      'No rows belong to the selected inline row sets; inspect row_set_totals or request another selection.',
    );
  });
  it('retains selected oversized parents and nested Unicode windows past the end', async () => {
    const text = 'é🌲```'.repeat(10_000);
    respond = () => Response.json(page([filing(1, { future: { nested: [{ text }] } })]));
    const output = success(
      await invoke(getClientProfile, {
        mode: 'profile',
        client_ids: ['2'],
        years: [2024],
        row_sets: ['raw_filings'],
      }),
    );
    expect(output).toMatchObject({
      total_records: 1,
      records_returned: 0,
      records_deferred: 1,
      output_complete: true,
    });
    expect(output).not.toHaveProperty('selected_filings');
    const handle = z
      .array(z.object({ record_handle: z.string() }))
      .parse(output.record_handles)[0]!.record_handle;
    const parent = success(
      await invoke(getClientProfile, {
        record_handle: handle,
        record_path: '/filing/future/nested',
      }),
    );
    expect(parent.record_window).toMatchObject({
      kind: 'array',
      items: [{ index: 0, path: '/filing/future/nested/0' }],
    });
    const nested = success(
      await invoke(getClientProfile, {
        record_handle: handle,
        record_path: '/filing/future/nested/0',
      }),
    );
    expect(nested.record_window).toMatchObject({
      kind: 'object',
      entries: [{ key: 'text', path: '/filing/future/nested/0/text' }],
    });
    let offset = 0;
    let recovered = '';
    while (offset < [...text].length) {
      const fragment = success(
        await invoke(getClientProfile, {
          record_handle: handle,
          record_path: '/filing/future/nested/0/text',
          record_offset: offset,
        }),
      );
      const window = z
        .object({ text: z.string(), returned: z.number(), next_offset: z.number().optional() })
        .parse(fragment.record_window);
      expect(window.returned).toBeGreaterThan(0);
      recovered += window.text;
      offset += window.returned;
    }
    expect(recovered).toBe(text);
    const end = success(
      await invoke(getClientProfile, {
        record_handle: handle,
        record_path: '/filing/future/nested/0/text',
        record_offset: offset,
      }),
    );
    expect(end.record_window).toMatchObject({ text: '', returned: 0, complete: true });
    reason(
      await invoke(getClientProfile, {
        record_handle: handle,
        record_path: '/filing/future/nested/0/text',
        record_offset: offset + 1,
      }),
      'invalid_filter',
    );
    expect(calls).toHaveLength(1);
  });
  it('rejects empty, duplicate, unknown and non-analytical row selections before transport', async () => {
    for (const row_sets of [[], ['activities', 'activities'], ['unknown'], [null]]) {
      const value = await invoke(getIssueSpending, { issue_code: 'TEC', years: [2024], row_sets });
      expect(value.result.isError, JSON.stringify(row_sets)).toBe(true);
      expect(value.data).toMatchObject({ error: { code: -32602 } });
    }
    reason(
      await invoke(getClientProfile, { client_name: 'Example', row_sets: ['activities'] }),
      'invalid_filter',
    );
    expect(calls).toEqual([]);
  });
  it('characterizes decimal disclosure preservation and default record selector acceptance', async () => {
    const row = filing(1, { income: '9007199254740993.01', lobbying_activities: [] });
    respond = () => Response.json(page([row]));
    const output = success(await invoke(searchFilings, { filing_year: 2024, record_limit: 25 }));
    expect(output.filings).toEqual([row]);
    expect(calls[0]?.searchParams.get('page_size')).toBe('25');
    expect(output.effective_filters).toEqual({ filing_year: 2024 });
  });
  it('maps complete native filing filters and preserves normalized scope', async () => {
    respond = () => Response.json(page([filing()]));
    const output = success(
      await invoke(searchFilings, {
        filing_uuid: uuid(1),
        posted_after: '2024-01-01',
        posted_before: '2024-12-31',
        amount_min: '-0.01',
        amount_max: '9007199254740993.01',
        client_state: ' wa ',
        client_country: 'us',
        foreign_entity_name: ' Example ',
        foreign_entity_country: ' ca ',
        lobbyist_name: ' Person ',
      }),
    );
    expect(output.effective_filters).toMatchObject({
      client_state: 'WA',
      client_country: 'US',
      foreign_entity_country: 'CA',
      lobbyist_name: 'Person',
    });
    const params = Object.fromEntries(calls[0]!.searchParams);
    expect(params).toMatchObject({
      filing_uuid: uuid(1),
      filing_dt_posted_after: '2024-01-01',
      filing_dt_posted_before: '2024-12-31',
      filing_amount_reported_min: '-0.01',
      filing_amount_reported_max: '9007199254740993.01',
      client_state: 'WA',
      client_country: 'US',
      foreign_entity_name: 'Example',
      foreign_entity_country: 'CA',
      lobbyist_name: 'Person',
    });
  });
  it('returns a completed empty UUID scope without inferring identifier invalidity', async () => {
    const output = success(await invoke(searchFilings, { filing_uuid: uuid(999) }));
    expect(output.filings).toEqual([]);
    expect(output.coverage).toMatchObject({ complete: true, records_fetched: 0 });
    expect(calls[0]!.searchParams.get('filing_uuid')).toBe(uuid(999));
    expect(calls[0]!.pathname).toBe('/api/v1/filings/');
  });
  it('uses exact inclusive same-child contribution amounts without native amount filters', async () => {
    const items = [
      { contributor_name: 'Alice', amount: null },
      { contributor_name: 'Bob', amount: '9007199254740993.01' },
      { contributor_name: 'Alice', amount: '9007199254740993.00' },
      { contributor_name: 'Alice', amount: '9007199254740993.01' },
    ];
    respond = () =>
      Response.json(
        page([
          { ...filing(), contribution_items: items },
          { ...filing(2), contribution_items: [] },
        ]),
      );
    const output = success(
      await invoke(getContributions, {
        filing_year: 2024,
        contributor: 'alice',
        amount_min: '9007199254740993.01',
        amount_max: '9007199254740993.01',
      }),
    );
    expect(output.reports).toEqual([
      expect.objectContaining({ contribution_items: items, matched_item_indexes: [3] }),
    ]);
    expect(calls[0]!.searchParams.has('contribution_amount_min')).toBe(false);
    expect(calls[0]!.searchParams.has('contribution_amount_max')).toBe(false);
  });
  it('clamps positive delivery controls before scope checks and discloses both values', async () => {
    const output = success(
      await invoke(searchFilings, {
        filing_year: 2024,
        page_size: 26,
        max_pages: 6,
        record_limit: 26,
      }),
    );
    expect(output.effective_filters).toEqual({ filing_year: 2024, page_size: 25 });
    expect(output.delivery_limits).toEqual({
      page_size: { requested: 26, effective: 25 },
      max_pages: { requested: 6, effective: 5 },
      record_limit: { requested: 26, effective: 25 },
    });
    expect(output.coverage).toMatchObject({ complete: true, records_fetched: 0 });
    const huge = success(await invoke(searchFilings, { filing_year: 2024, page_size: 1e20 }));
    expect(huge.delivery_limits).toEqual({ page_size: { requested: 1e20, effective: 25 } });
  });
  it('compares effective page sizes, retains replay disclosure and retrieves clamped nested handles', async () => {
    const rows = Array.from({ length: 30 }, (_, n) => filing(n + 1));
    respond = () => Response.json(page(rows));
    const first = success(await invoke(searchFilings, { filing_year: 2024, page_size: 26 }));
    const next = success(await invoke(searchFilings, { cursor: first.next_cursor, page_size: 99 }));
    expect(next.delivery_limits).toEqual({ page_size: { requested: 99, effective: 25 } });
    expect(
      success(await invoke(searchFilings, { cursor: first.next_cursor, page_size: 100 })),
    ).toEqual(next);
    reason(
      await invoke(searchFilings, { cursor: first.next_cursor, page_size: 24 }),
      'cursor_invalid',
    );
    respond = () =>
      Response.json(page([filing(100, { future: { nested: [{ text: 'é🌲'.repeat(9000) }] } })]));
    const large = success(await invoke(searchFilings, { filing_uuid: uuid(100) }));
    const handle = z
      .array(z.object({ record_handle: z.string() }))
      .parse(large.record_handles)[0]!.record_handle;
    const nested = success(
      await invoke(searchFilings, {
        record_handle: handle,
        record_path: '/future/nested',
        record_limit: 99,
      }),
    );
    expect(nested.delivery_limits).toEqual({ record_limit: { requested: 99, effective: 25 } });
    expect(nested.record_window).toMatchObject({
      kind: 'array',
      items: [{ path: '/future/nested/0' }],
    });
    const text = success(
      await invoke(searchFilings, {
        record_handle: handle,
        record_path: '/future/nested/0/text',
        record_limit: 99,
      }),
    );
    expect(text.record_window).toMatchObject({
      kind: 'string',
      text: expect.stringContaining('é🌲'),
      returned: expect.any(Number),
    });
    expect(z.object({ returned: z.number() }).parse(text.record_window).returned).toBeGreaterThan(
      25,
    );
    const end = success(
      await invoke(searchFilings, {
        record_handle: handle,
        record_path: '/future/nested',
        record_offset: 1,
        record_limit: 99,
      }),
    );
    expect(end.record_window).toMatchObject({ items: [], complete: true });
    reason(
      await invoke(searchFilings, {
        record_handle: handle,
        record_path: '/future/nested',
        record_offset: 2,
        record_limit: 99,
      }),
      'invalid_filter',
    );
  });
  it('clears previous workload disclosures on fresh continuation and deferred reads', async () => {
    respond = () => Response.json(page(Array.from({ length: 30 }, (_, n) => filing(n + 1))));
    const first = success(
      await invoke(searchFilings, { filing_year: 2024, max_pages: 6, record_limit: 26 }),
    );
    const second = success(await invoke(searchFilings, { cursor: first.next_cursor }));
    expect(second.delivery_limits).toEqual({});
    expect(
      success(await invoke(searchFilings, { cursor: first.next_cursor, max_pages: 99 })),
    ).toEqual(second);
    respond = () => Response.json(page([filing(100, { future: 'é🌲'.repeat(9000) })]));
    const large = success(await invoke(searchFilings, { filing_year: 2024, max_pages: 6 }));
    const handle = z
      .array(z.object({ record_handle: z.string() }))
      .parse(large.record_handles)[0]!.record_handle;
    const record = success(await invoke(searchFilings, { record_handle: handle }));
    expect(record.delivery_limits).toEqual({});
  });
  it.each([
    { posted_after: '2024-02-30' },
    { filing_uuid: 'wrong' },
    { amount_min: '1e3' },
    { amount_max: '1.001' },
    { posted_after: '2024-02-02', posted_before: '2024-02-01' },
    { amount_min: '2', amount_max: '1.99' },
  ])('rejects invalid filing filters before acquisition %j', async (filters) => {
    const result = await invoke(searchFilings, { filing_year: 2024, ...filters });
    expect(result.result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
  it('rejects blank-only scope and conjunctive amount misses without dropping parent data', async () => {
    reason(
      await invoke(searchFilings, { client_state: ' ', lobbyist_name: ' ' }),
      'invalid_filter',
    );
    expect(calls).toEqual([]);
    respond = () =>
      Response.json(
        page([
          {
            ...filing(),
            contribution_items: [
              { contributor_name: 'Alice', amount: null },
              { contributor_name: 'Bob', amount: '0' },
            ],
          },
        ]),
      );
    const empty = success(
      await invoke(getContributions, { filing_year: 2024, contributor: 'Alice', amount_max: '0' }),
    );
    expect(empty.reports).toEqual([]);
    expect(empty.coverage).toMatchObject({ complete: true, records_fetched: 1 });
    reason(
      await invoke(getContributions, { filing_year: 2024, amount_min: '1', amount_max: '0' }),
      'invalid_filter',
    );
  });
  it('trims optional UUID, calendar and decimal grammar before validation and omits blanks', async () => {
    const output = success(
      await invoke(searchFilings, {
        filing_uuid: ` ${uuid(1)} `,
        posted_after: ' 2024-01-01 ',
        posted_before: ' ',
        amount_min: ' -1.00 ',
        amount_max: ' ',
      }),
    );
    expect(output.effective_filters).toEqual({
      filing_uuid: uuid(1),
      posted_after: '2024-01-01',
      amount_min: '-1.00',
    });
    reason(
      await invoke(searchFilings, { filing_uuid: ' ', posted_after: ' ', amount_min: ' ' }),
      'invalid_filter',
    );
    const contributions = success(
      await invoke(getContributions, { filing_year: 2024, amount_min: ' ', amount_max: ' 0.01 ' }),
    );
    expect(contributions.effective_filters).toEqual({ filing_year: 2024, amount_max: '0.01' });
  });
  it('names candidate record IDs and preserves differing and identical secondary IDs', async () => {
    respond = () =>
      Response.json(
        page([
          { id: 100542, client_id: 862, name: 'Example' },
          { id: 7, client_id: 7, name: 'Another' },
        ]),
      );
    const result = success(await invoke(getClientProfile, { client_name: 'Example' }));
    expect(result.candidates).toEqual([
      { id: '100542', client_id: '862', name: 'Example' },
      { id: '7', client_id: '7', name: 'Another' },
    ]);
    expect(result.guidance).toContain('candidates[].id');
    expect(result.guidance).toContain('candidates[].client_id');
  });
  it.each(['862', '987654321987654321', '7'])(
    'reports empty source scope without inferring identifier validity for %s',
    async (clientId) => {
      const result = success(
        await invoke(getClientProfile, { mode: 'profile', client_ids: [clientId], years: [2024] }),
      );
      expect(calls[0]?.searchParams.get('client_id')).toBe(clientId);
      expect(result.coverage).toMatchObject({ complete: true, records_fetched: 0 });
      expect(JSON.stringify(result.notices)).toContain('No source filings');
      expect(JSON.stringify(result.notices)).toContain(clientId);
      expect(JSON.stringify(result.notices)).toContain('2024');
      expect(JSON.stringify(result.notices)).not.toMatch(/invalid|issue_codes/);
    },
  );
  it('distinguishes acquired but excluded filings from empty client/year partitions', async () => {
    respond = (url) =>
      Response.json(
        page(
          url.searchParams.get('client_id') === '2'
            ? [filing(1, { filing_type: 'RR', filing_period: 'mid_year' })]
            : [],
        ),
      );
    const output = success(
      await invoke(getClientProfile, { mode: 'profile', client_ids: ['2', '3'], years: [2024] }),
    );
    expect(output.coverage).toMatchObject({ records_fetched: 1, upstream_count: 1 });
    expect(output.row_set_totals).toMatchObject({
      selected_filings: 0,
      raw_filings: 1,
      selections: 1,
    });
    expect(output.notices).toEqual(
      expect.arrayContaining([
        'Source filings were acquired, but no quarterly filings survived version and issue selection.',
        'No source filings were fetched for client_id=3, filing_year=2024; zero rows do not establish identifier validity.',
      ]),
    );
    expect(JSON.stringify(output.notices)).not.toContain('client_id=2');
    expect(output.total_records).toBe(5);
  });
  it('delivers every empty-partition notice through bounded windows and exact replay', async () => {
    const ids = Array.from({ length: 130 }, (_, n) => String(n + 1));
    let output = success(
      await invoke(getClientProfile, { mode: 'profile', client_ids: ids, years: [2024] }),
    );
    const notices: string[] = [];
    let sawDeliveryContinuation = false;
    for (let index = 0; index < 80; index++) {
      notices.push(
        ...z
          .array(z.string())
          .parse(output.notices)
          .filter((notice) => notice.includes('client_id=')),
      );
      if (!output.next_cursor) break;
      const cursor = output.next_cursor;
      const previousComplete = z.object({ complete: z.boolean() }).parse(output.coverage).complete;
      output = success(await invoke(getClientProfile, { cursor }));
      if (previousComplete) {
        sawDeliveryContinuation = true;
        const callCount = calls.length;
        expect(success(await invoke(getClientProfile, { cursor }))).toEqual(output);
        expect(calls).toHaveLength(callCount);
      }
    }
    expect(output.output_complete).toBe(true);
    expect(sawDeliveryContinuation).toBe(true);
    expect(notices).toHaveLength(130);
    expect(new Set(notices).size).toBe(130);
    expect(output.total_records).toBe(130);
    expect(output.row_set_offsets).toEqual(output.row_set_totals);
    expect(output.row_set_totals).toMatchObject({
      raw_filings: 0,
      selections: 0,
      annual_ledgers: 0,
    });
    expect(calls).toHaveLength(130);
  });
  it('retains oversized partition notices behind lossless record handles', async () => {
    const clientId = '7'.repeat(4000);
    const output = success(
      await invoke(getClientProfile, { mode: 'profile', client_ids: [clientId], years: [2024] }),
    );
    expect(output.records_deferred).toBe(1);
    expect(output.total_records).toBe(1);
    const handle = z
      .array(z.object({ record_handle: z.string() }))
      .parse(output.record_handles)[0]!;
    let restored = '';
    let offset = 0;
    for (let index = 0; index < 20; index++) {
      const result = success(
        await invoke(getClientProfile, {
          record_handle: handle.record_handle,
          record_path: '/notice',
          record_offset: offset,
        }),
      );
      const window = z
        .object({
          kind: z.literal('string'),
          text: z.string(),
          complete: z.boolean(),
          next_offset: z.number().optional(),
        })
        .parse(result.record_window);
      restored += window.text;
      if (window.complete) break;
      offset = window.next_offset!;
    }
    expect(restored).toBe(
      `No source filings were fetched for client_id=${clientId}, filing_year=2024; zero rows do not establish identifier validity.`,
    );
    expect(calls).toHaveLength(1);
  });
  it('validates initial issue codes but makes no source requests for retained windows and replay', async () => {
    respond = () => Response.json(page(Array.from({ length: 30 }, (_, n) => filing(n + 1))));
    const first = success(await invoke(getIssueSpending, { issue_code: 'TEC', years: [2024] }));
    expect(calls.filter((url) => url.pathname.includes('/constants/'))).toHaveLength(1);
    expect(calls.filter((url) => url.pathname === '/api/v1/filings/')).toHaveLength(1);
    expect(first.coverage).toMatchObject({ complete: true });
    expect(first.next_cursor).toBeTypeOf('string');
    calls.length = 0;
    const second = success(await invoke(getIssueSpending, { cursor: first.next_cursor }));
    expect(calls).toHaveLength(0);
    expect(success(await invoke(getIssueSpending, { cursor: first.next_cursor }))).toEqual(second);
    expect(calls).toHaveLength(0);
    reason(
      await invoke(getIssueSpending, { cursor: first.next_cursor, issue_code: 'HCR' }),
      'cursor_invalid',
    );
    reason(await invoke(searchFilings, { cursor: first.next_cursor }), 'cursor_invalid');
    reason(await invoke(getIssueSpending, { cursor: 'unknown' }), 'cursor_invalid');
    expect(calls).toHaveLength(0);
    reason(
      await invoke(getIssueSpending, { issue_code: 'UNKNOWN', years: [2024] }),
      'invalid_filter',
    );
    expect(calls.filter((url) => url.pathname.includes('/constants/'))).toHaveLength(1);
  });
  it('cancels analytical finalization while reading real retained source chunks', async () => {
    const controller = new AbortController();
    respond = () => Response.json(page([filing()]));
    const get = state.get.bind(state);
    const finalizationReads: string[] = [];
    const intercepted = vi.spyOn(state, 'get').mockImplementation(async (...args) => {
      const value = await get(...args);
      if (args[0].startsWith('acquisition/chunk/')) {
        finalizationReads.push(args[0]);
        controller.abort(
          new DOMException('Cancelled while finalizing acquired filings', 'AbortError'),
        );
      }
      return value;
    });
    const handler: typeof getIssueSpending.handler = (input, ctx) =>
      getIssueSpending.handler(input, { ...ctx, state });
    try {
      const pending = runToolContract(
        { ...getIssueSpending, handler },
        { issue_code: 'TEC', years: [2024] },
        { context: { signal: controller.signal } },
      );
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(finalizationReads).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32011, message: 'Cancelled while finalizing acquired filings' },
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('Cancelled while finalizing acquired filings'),
          }),
        ]),
      );
      expect(result.structuredContent).not.toHaveProperty('annual_ledgers');
      expect(result.structuredContent).not.toHaveProperty('dataset');
      expect(calls.filter((url) => url.pathname === '/api/v1/filings/')).toHaveLength(1);
    } finally {
      intercepted.mockRestore();
    }
  });
  it('shares one 45-second budget across reference validation retries and filing acquisition', async () => {
    const started = Date.now();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Synthetic timeout', 'TimeoutError')), ms);
      return controller.signal;
    });
    let constants = 0;
    const starts: string[] = [];
    getLdaService().dispose();
    initLdaService({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://lda.gov');
        starts.push(url.pathname);
        const reference = url.pathname.includes('/constants/');
        const attempt = reference ? ++constants : 0;
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          signal?.throwIfAborted();
          const timer = setTimeout(
            () => {
              signal?.removeEventListener('abort', abort);
              resolve(
                reference
                  ? attempt === 1
                    ? new Response('temporary', { status: 503 })
                    : Response.json([{ value: 'TEC', name: 'Telecommunications' }])
                  : Response.json(page([filing()])),
              );
            },
            reference ? 17_000 : 19_000,
          );
          const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
          };
          signal?.addEventListener('abort', abort, { once: true });
        });
      },
    });
    let settledAt: number | undefined;
    const pending = runToolContract(searchFilings, { filing_year: 2024, issue_code: 'TEC' }).then(
      (result) => {
        settledAt = Date.now() - started;
        return result;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(45_000);
      const settledByDeadline = settledAt;
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(starts).toEqual([
        '/api/v1/constants/filing/lobbyingactivityissues/',
        '/api/v1/constants/filing/lobbyingactivityissues/',
        '/api/v1/filings/',
      ]);
      expect(settledByDeadline).toBeDefined();
      expect(settledAt).toBeLessThanOrEqual(45_000);
      expect(result.isError).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
  const modes = [
    {
      name: 'filings',
      tool: searchFilings,
      input: { filing_year: 2024 },
      key: 'filings',
      row: filing(),
    },
    {
      name: 'lobbyists',
      tool: searchLobbyists,
      input: { name: 'Synthetic' },
      key: 'lobbyists',
      row: { id: 7, first_name: null, future: { text: '🌲' } },
    },
    {
      name: 'resolve',
      tool: getClientProfile,
      input: { client_name: 'Synthetic' },
      key: 'candidates',
      row: { id: 2, name: 'Synthetic', registrant: { id: 1, name: 'Firm' }, future: [null] },
    },
    {
      name: 'activity',
      tool: searchLobbyists,
      input: { mode: 'activity', lobbyist_id: '7', filing_year: 2024 },
      key: 'evidence',
      row: filing(),
    },
    {
      name: 'contributions',
      tool: getContributions,
      input: { filing_year: 2024 },
      key: 'reports',
      row: {
        ...filing(),
        filing_period: 'mid_year',
        contribution_items: [],
        no_contributions: true,
        pacs: [{ name: 'PAC' }],
      },
    },
    {
      name: 'issue analysis',
      tool: getIssueSpending,
      input: { issue_code: 'TEC', years: [2024] },
      key: 'raw_filings',
      row: filing(),
    },
    {
      name: 'profile analysis',
      tool: getClientProfile,
      input: { mode: 'profile', client_ids: ['2'], years: [2024] },
      key: 'raw_filings',
      row: filing(),
    },
  ];
  it.each(modes)(
    '$name preserves sparse and nested records on both surfaces',
    async ({ tool, input, row, key }) => {
      respond = () => Response.json(page([row]));
      const output = success(await invoke(tool, input));
      expect(output.coverage).toMatchObject({ complete: true, pages_fetched: 1 });
      expect(z.array(z.unknown()).parse(output[key]).length).toBeGreaterThan(0);
      expect(output.attribution).toContain('Senate Office of Public Records');
      const schema = z.toJSONSchema(tool.output!);
      expect(schema).toHaveProperty(`properties.${key}`);
    },
  );
  it.each(modes)('$name returns honest empty complete results', async ({ tool, input, key }) => {
    const output = success(await invoke(tool, input));
    if (key === 'raw_filings') {
      expect(output).not.toHaveProperty('raw_filings');
      expect(output).not.toHaveProperty('annual_ledgers');
      expect(output.records_returned).toBe(1);
      expect(output.total_records).toBe(1);
      expect(output.notices).toEqual(
        expect.arrayContaining([expect.stringContaining('No source filings')]),
      );
      const empty = {
        annual_ledgers: 0,
        selections: 0,
        firms: 0,
        issue_codes: 0,
        targeted_entities: 0,
        selected_filings: 0,
        activities: 0,
        raw_filings: 0,
      };
      expect(output.canvas_available).toBe(false);
      expect(output.row_set_totals).toEqual(empty);
      expect(output.row_set_offsets).toEqual(empty);
    } else expect(output[key]).toEqual([]);
    expect(output.coverage).toMatchObject({ complete: true, records_fetched: 0 });
    expect(output.notices).toEqual(expect.arrayContaining([expect.stringContaining('No ')]));
  });
  it.each(modes)(
    '$name rejects malformed source with dual-surface recovery',
    async ({ tool, input }) => {
      respond = () => Response.json({ count: 1, next: null, results: [{}] });
      reason(await invoke(tool, input), 'source_schema_changed');
    },
  );
  it.each(modes)('$name enforces page limits before transport', async ({ tool, input }) => {
    for (const extra of [
      { page_size: 0 },
      { max_pages: 0 },
      { page_size: -1 },
      { page_size: 1.5 },
      { max_pages: Infinity },
      { record_limit: 'abc' },
      { record_limit: NaN },
    ]) {
      const output = await invoke(tool, { ...input, ...extra });
      expect(output.result.isError).toBe(true);
      expect(output.data).toMatchObject({ error: { code: -32602 } });
    }
    expect(calls).toEqual([]);
  });
  it.each(modes)(
    '$name rejects unknown cursors with recovery before transport',
    async ({ tool }) => {
      reason(await invoke(tool, { cursor: 'not-a-retained-cursor' }), 'cursor_invalid');
      expect(calls).toEqual([]);
    },
  );
  it.each(modes)(
    '$name clamps delivery controls and preserves filter identity',
    async ({ tool, input }) => {
      const output = success(
        await invoke(tool, { ...input, page_size: 26, max_pages: 6, record_limit: 26 }),
      );
      expect(output.delivery_limits).toMatchObject({
        page_size: { requested: 26, effective: 25 },
        max_pages: { requested: 6, effective: 5 },
        record_limit: { requested: 26, effective: 25 },
      });
      expect(output.effective_filters).toMatchObject({ page_size: 25 });
      expect(output.effective_filters).not.toHaveProperty('max_pages');
      expect(output.effective_filters).not.toHaveProperty('record_limit');
    },
  );
  it.each(modes)('$name rejects nonprogressing upstream pages', async ({ tool, input, row }) => {
    respond = (url) => Response.json(page([row], String(url)));
    reason(await invoke(tool, input), 'pagination_invalid');
  });
  it('honors the maximum five-page workload and continues the sixth page', async () => {
    respond = (url) => {
      const n = Number(url.searchParams.get('page'));
      const next = new URL(url);
      next.searchParams.set('page', String(n + 1));
      return Response.json(page([filing(n)], n < 6 ? String(next) : null));
    };
    const first = success(
      await invoke(searchFilings, { filing_year: 2024, page_size: 1, max_pages: 5 }),
    );
    expect(first.coverage).toMatchObject({ complete: false, pages_fetched: 5 });
    expect(first.filings).toHaveLength(5);
    expect(calls).toHaveLength(5);
    const last = success(await invoke(searchFilings, { cursor: first.next_cursor }));
    expect(last.coverage).toMatchObject({ complete: true, pages_fetched: 6 });
    expect(last.filings).toEqual([expect.objectContaining({ filing_uuid: uuid(6) })]);
  });
  it('delivers every analytical list across final output windows without reacquiring', async () => {
    respond = () =>
      Response.json(
        page(
          Array.from({ length: 25 }, (_, n) =>
            filing(n + 1, { client: { id: String(n + 1), name: `Client ${n + 1}` } }),
          ),
        ),
      );
    let output = success(
      await invoke(getIssueSpending, { issue_code: 'TEC', years: [2024], page_size: 25 }),
    );
    const lists = new Map<string, unknown[]>();
    const keys = [
      'annual_ledgers',
      'selections',
      'firms',
      'issue_codes',
      'targeted_entities',
      'selected_filings',
      'activities',
      'raw_filings',
    ];
    const totals = {
      annual_ledgers: 1,
      selections: 25,
      firms: 1,
      issue_codes: 1,
      targeted_entities: 1,
      selected_filings: 25,
      activities: 25,
      raw_filings: 25,
    };
    let delivered = 0;
    for (let n = 0; n < 100; n++) {
      expect(output.canvas_available).toBe(false);
      expect(output.row_set_totals).toEqual(totals);
      let preceding = 0;
      const expectedOffsets: Record<string, number> = {};
      for (const [key, count] of Object.entries(totals)) {
        expectedOffsets[key] = Math.min(count, Math.max(0, delivered - preceding));
        preceding += count;
      }
      expect(output.row_set_offsets).toEqual(expectedOffsets);
      expect(output.offset).toBe(delivered);
      for (const key of keys) {
        const list = lists.get(key) ?? [];
        if (output[key] !== undefined) list.push(...z.array(z.unknown()).parse(output[key]));
        lists.set(key, list);
      }
      delivered += z.number().parse(output.records_returned);
      if (output.output_complete) break;
      output = success(await invoke(getIssueSpending, { cursor: output.next_cursor }));
    }
    expect(output.output_complete).toBe(true);
    for (const key of ['raw_filings', 'selected_filings', 'selections', 'activities'])
      expect(lists.get(key)).toHaveLength(25);
    for (const key of ['annual_ledgers', 'firms', 'issue_codes', 'targeted_entities'])
      expect(lists.get(key)).toHaveLength(1);
    expect(lists.get('annual_ledgers')).toMatchObject([
      { known_income_usd: '25.25', matching_filing_count: 25 },
    ]);
    expect(lists.get('raw_filings')).toMatchObject(
      Array.from({ length: 25 }, (_, n) => ({
        filing_uuid: uuid(n + 1),
        future: { nested: [null, false, 'é🌲'] },
      })),
    );
    expect(delivered).toBe(104);
    expect(calls.filter((url) => url.pathname === '/api/v1/filings/')).toHaveLength(1);
  });
  it('keeps all 25 rows and traverses omitted/repeated filters, replay and changed scope', async () => {
    respond = (url) => {
      const n = Number(url.searchParams.get('page'));
      const next = new URL(url);
      next.searchParams.set('page', String(n + 1));
      return Response.json(
        page(
          Array.from({ length: 25 }, (_, i) => filing((n - 1) * 25 + i + 1)),
          n < 3 ? String(next) : null,
        ),
      );
    };
    const first = success(
      await invoke(searchFilings, { filing_year: 2024, page_size: 25, max_pages: 1 }),
    );
    // Full nested records can require output delivery windows; every committed page is retained.
    const second = await invoke(searchFilings, {
      cursor: first.next_cursor,
      filing_year: 2024,
      page_size: 25,
    });
    success(second);
    const replay = await invoke(searchFilings, { cursor: first.next_cursor });
    expect(replay.data).toEqual(second.data);
    reason(
      await invoke(searchFilings, { cursor: second.data.next_cursor, filing_year: 2023 }),
      'cursor_invalid',
    );
    let output = second.data;
    const rows = [
      ...z.array(z.unknown()).parse(first.filings),
      ...z.array(z.unknown()).parse(second.data.filings),
    ];
    for (let n = 0; n < 30 && output.next_cursor; n++) {
      output = success(await invoke(searchFilings, { cursor: output.next_cursor }));
      rows.push(...z.array(z.unknown()).parse(output.filings));
    }
    expect(rows).toHaveLength(75);
    expect(output.coverage).toMatchObject({ complete: true, pages_fetched: 3, unique_records: 75 });
    expect(output.output_complete).toBe(true);
  });
  it('selects amendments before issue filtering and emits no analytical rows while collecting', async () => {
    respond = (url) => {
      const next = new URL(url);
      next.searchParams.set('page', '2');
      return Response.json(
        url.searchParams.get('page') === '1'
          ? page([filing()], String(next))
          : page([
              filing(2, {
                filing_type: '1A',
                dt_posted: '2024-04-02T00:00:00Z',
                lobbying_activities: [{ general_issue_code: 'HCR' }],
              }),
            ]),
      );
    };
    const first = success(
      await invoke(getIssueSpending, { issue_code: 'tec', years: [2024], max_pages: 1 }),
    );
    expect(first).toMatchObject({ status: 'collecting', records_returned: 0 });
    expect(first).not.toHaveProperty('annual_ledgers');
    expect(first).not.toHaveProperty('selected_filings');
    expect(first).not.toHaveProperty('row_set_totals');
    expect(first).not.toHaveProperty('row_set_offsets');
    expect(JSON.stringify(first)).not.toContain('known_income_usd');
    const final = success(await invoke(getIssueSpending, { cursor: first.next_cursor }));
    expect(final.status).toBe('complete');
    expect(final).not.toHaveProperty('selected_filings');
    expect(final.raw_filings).toHaveLength(2);
    expect(final.annual_ledgers).toMatchObject([{ matching_filing_count: 0 }]);
    expect(final.canvas_available).toBe(false);
    expect(final.row_set_totals).toEqual({
      annual_ledgers: 1,
      selections: 1,
      firms: 0,
      issue_codes: 0,
      targeted_entities: 0,
      selected_filings: 0,
      activities: 0,
      raw_filings: 2,
    });
    expect(
      calls.every(
        (url) => !url.searchParams.has('issue_code') && !url.searchParams.has('general_issue_code'),
      ),
    ).toBe(true);
  });
  it('profiles only explicit sorted unique relationships and delivers every final audit row', async () => {
    respond = (url) =>
      Response.json(
        page([
          filing(Number(url.searchParams.get('client_id')), {
            client: { id: url.searchParams.get('client_id'), name: 'Same name' },
            income: url.searchParams.get('client_id') === '2' ? '1.01' : null,
            expenses: url.searchParams.get('client_id') === '3' ? '2.02' : null,
          }),
        ]),
      );
    const first = success(
      await invoke(getClientProfile, {
        mode: 'profile',
        client_ids: ['3', '2', '3'],
        years: [2024, 2024],
        max_pages: 1,
      }),
    );
    expect(first).toMatchObject({
      client_ids: ['2', '3'],
      years: [2024],
      records_returned: 0,
      status: 'collecting',
    });
    expect(first.coverage).not.toHaveProperty('upstream_count');
    const final = success(await invoke(getClientProfile, { cursor: first.next_cursor }));
    expect(final.coverage).toMatchObject({ upstream_count: 2, records_fetched: 2 });
    expect(final).toMatchObject({ status: 'complete', output_complete: true });
    expect(first).not.toHaveProperty('annual_ledgers');
    expect(first).not.toHaveProperty('row_set_totals');
    expect(first).not.toHaveProperty('row_set_offsets');
    expect(final.canvas_available).toBe(false);
    expect(final.row_set_totals).toEqual({
      annual_ledgers: 1,
      selections: 2,
      firms: 1,
      issue_codes: 1,
      targeted_entities: 1,
      selected_filings: 2,
      activities: 2,
      raw_filings: 2,
    });
    expect(final.row_set_offsets).toEqual({
      annual_ledgers: 0,
      selections: 0,
      firms: 0,
      issue_codes: 0,
      targeted_entities: 0,
      selected_filings: 0,
      activities: 0,
      raw_filings: 0,
    });
    expect(final.raw_filings).toHaveLength(2);
    expect(final.selected_filings).toHaveLength(2);
    expect(final.annual_ledgers).toMatchObject([
      { known_income_usd: '1.01', known_expenses_usd: '2.02', matching_filing_count: 2 },
    ]);
    expect(calls.map((url) => url.searchParams.get('client_id'))).toEqual(['2', '3']);
  });
  it('checks covered positions against the requested local lobbyist identity', async () => {
    respond = () =>
      Response.json(
        page([
          filing(1, {
            lobbying_activities: [
              {
                general_issue_code: 'TEC',
                lobbyists: [
                  { lobbyist: { id: '8' }, covered_position: 'Other person' },
                  { lobbyist: { id: '7' }, covered_position: ' ' },
                  { lobbyist: { id: '7' }, covered_position: 'Former aide' },
                ],
              },
            ],
          }),
        ]),
      );
    const output = success(
      await invoke(searchLobbyists, {
        mode: 'activity',
        lobbyist_id: '7',
        filing_year: 2024,
        covered_positions_only: true,
      }),
    );
    expect(output.evidence).toEqual([
      expect.objectContaining({
        lobbyist_index: 2,
        covered_position: 'Former aide',
        lobbyist: { id: '7' },
      }),
    ]);
    expect(calls[0]?.searchParams.get('lobbyist_covered_position_indicator')).toBe('true');
  });
  it('requires all predicates on the same child and retains all siblings and amendments', async () => {
    const items = [
      { contributor_name: 'Alice', payee_name: 'Other', date: '2024-01-01' },
      { contributor_name: 'Other', payee_name: 'Committee', date: '2024-01-01' },
    ];
    const matched = {
      contributor_name: 'ALICE',
      payee_name: 'Committee',
      date: '2024-01-02',
      amount: '0.00',
    };
    respond = () =>
      Response.json(
        page([
          { ...filing(1), contribution_items: items },
          {
            ...filing(2),
            contribution_items: [...items, matched, matched],
            pacs: [null],
            no_contributions: false,
          },
          { ...filing(3), filing_type: 'MA', contribution_items: [matched], comments: null },
        ]),
      );
    const output = success(
      await invoke(getContributions, {
        filing_year: 2024,
        contributor: 'alice',
        payee: 'committee',
        contribution_date_after: '2024-01-02',
        contribution_date_before: '2024-01-02',
      }),
    );
    expect(output).toMatchObject({
      report_count_in_batch: 2,
      item_count_in_batch: 5,
      amendment_policy: 'all_versions',
      reports: [
        { contribution_items: [...items, matched, matched], matched_item_indexes: [2, 3] },
        { filing_type: 'MA', contribution_items: [matched], matched_item_indexes: [0] },
      ],
    });
  });
  it.each([searchFilings, getContributions, getClientProfile, getIssueSpending, searchLobbyists])(
    'reports invalid filters without fetching for $name',
    async (tool) => {
      reason(await invoke(tool, {}), 'invalid_filter');
      expect(calls).toEqual([]);
    },
  );
  it('returns a complete nested oversized parent through handle paths and exact Unicode windows', async () => {
    const long = 'é🌲'.repeat(9000);
    respond = () => Response.json(page([filing(1, { future: { nested: [{ text: long }] } })]));
    const first = success(await invoke(searchFilings, { filing_year: 2024 }));
    expect(first).toMatchObject({ filings: [], records_deferred: 1 });
    const handle = z
      .array(z.object({ record_handle: z.string() }))
      .parse(first.record_handles)[0]!.record_handle;
    const nested = success(
      await invoke(searchFilings, { record_handle: handle, record_path: '/future/nested' }),
    );
    expect(nested.record_window).toMatchObject({
      kind: 'array',
      items: [{ index: 0, path: '/future/nested/0' }],
    });
    const window = success(
      await invoke(searchFilings, {
        record_handle: handle,
        record_path: '/future/nested/0/text',
        record_offset: 1,
        record_limit: 25,
      }),
    );
    const fragment = z.object({ text: z.string() }).parse(window.record_window).text;
    const codePoints = Array.from(fragment).length;
    expect(codePoints).toBeGreaterThan(25);
    expect(fragment).toBe(
      Array.from(long)
        .slice(1, 1 + codePoints)
        .join(''),
    );
    expect(window.record_window).toMatchObject({
      kind: 'string',
      offset: 1,
      returned: codePoints,
      total: 18000,
      complete: false,
      next_offset: 1 + codePoints,
    });
    const past = success(
      await invoke(searchFilings, {
        record_handle: handle,
        record_path: '/future/nested/0/text',
        record_offset: 18000,
      }),
    );
    expect(past.record_window).toMatchObject({ text: '', returned: 0, complete: true });
    reason(
      await invoke(searchFilings, { record_handle: handle, filing_year: 2024 }),
      'invalid_filter',
    );
  });
});
