/** @fileoverview Count-bounded delivery, served caps and the include selector through the five LDA tool contracts. @module tests/tools/lda/delivery */
import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientProfile } from '../../../src/mcp-server/tools/definitions/lda/get-client-profile.tool.js';
import { getContributions } from '../../../src/mcp-server/tools/definitions/lda/get-contributions.tool.js';
import { getIssueSpending } from '../../../src/mcp-server/tools/definitions/lda/get-issue-spending.tool.js';
import { searchFilings } from '../../../src/mcp-server/tools/definitions/lda/search-filings.tool.js';
import { searchLobbyists } from '../../../src/mcp-server/tools/definitions/lda/search-lobbyists.tool.js';
import { setCanvas } from '../../../src/services/canvas/canvas-service.js';
import { getLdaService, initLdaService } from '../../../src/services/lda/lda-service.js';
import { type Definition, invoke, page, resetTenant, success, uuid } from './harness.js';

const DESCRIPTION = 'Spectrum auction oversight';
const POSITION = 'Former committee aide';
const activity = {
  general_issue_code: 'TEC',
  description: DESCRIPTION,
  foreign_entity_issues: null,
  government_entities: [{ id: '8', name: 'Senate' }],
  lobbyists: [{ lobbyist: { id: '7' }, covered_position: POSITION, new: false }],
  future: { kept: [true] },
};
/** The activity a default include leaves: every field except description and lobbyists. */
const { description: _description, lobbyists: _lobbyists, ...bare } = activity;
const filing = (n: number, extra: object = {}) => ({
  filing_uuid: uuid(n),
  filing_type: 'Q1',
  filing_year: 2024,
  filing_period: 'first_quarter',
  dt_posted: '2024-04-01T00:00:00Z',
  client: { id: String(n), name: `Client ${n}` },
  registrant: { id: '1', name: 'Firm' },
  income: '1.00',
  expenses: null,
  lobbying_activities: [activity],
  ...extra,
});
const BOTH = ['activity_descriptions', 'activity_lobbyists'];
const NOTICE_BOTH =
  'Lobbying activities omit description and lobbyists; a new call without cursor that adds activity_descriptions and activity_lobbyists to include returns those fields.';
let calls: URL[];
let respond: (url: URL) => Response;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01'));
  resetTenant();
  calls = [];
  setCanvas(undefined);
  respond = () => Response.json(page([]));
  initLdaService({
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      return url.pathname.includes('/constants/')
        ? Response.json([{ value: 'TEC', name: 'Telecommunications' }])
        : respond(url);
    },
  });
});
afterEach(() => {
  getLdaService().dispose();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function reason(value: Awaited<ReturnType<typeof invoke>>, expected: string) {
  expect(value.result.isError, value.text).toBe(true);
  expect(value.data).toMatchObject({ error: { data: { reason: expected } } });
  expect(value.text).toContain(expected);
}
const filingCalls = () => calls.filter((url) => url.pathname === '/api/v1/filings/');
const list = (value: unknown) => z.array(z.record(z.string(), z.unknown())).parse(value ?? []);
/** Every lobbying activity a response carries, wherever it sits. */
function activitiesIn(output: Record<string, unknown>): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const key of ['filings', 'selected_filings', 'raw_filings'])
    for (const row of list(output[key])) found.push(...list(row.lobbying_activities));
  found.push(...list(output.activities));
  for (const row of list(output.evidence))
    found.push(z.record(z.string(), z.unknown()).parse(row.activity));
  return found;
}
/** Two LDA pages: 25 rows with a next link, then the rest. */
function twoPages(total: number, make: (n: number) => unknown) {
  return (url: URL) => {
    const second = url.searchParams.get('page') === '2';
    const next = new URL(url);
    next.searchParams.set('page', '2');
    const rows = Array.from({ length: total }, (_, n) => make(n + 1));
    return Response.json(
      second ? page(rows.slice(25)) : page(rows.slice(0, 25), total > 25 ? String(next) : null),
    );
  };
}

describe('count-bounded delivery', () => {
  it('delivers 30 matches at page_size 10 as 10, 10, 10 and fetches LDA page 2 only on the third call', async () => {
    respond = twoPages(30, (n) => filing(n));
    const sizes: number[] = [];
    const fetched: number[] = [];
    let output = success(await invoke(searchFilings, { filing_year: 2024, page_size: 10 }));
    for (let n = 0; n < 5; n++) {
      sizes.push(list(output.filings).length);
      fetched.push(filingCalls().length);
      expect(output.offset).toBe(n * 10);
      if (output.output_complete) break;
      output = success(await invoke(searchFilings, { cursor: output.next_cursor }));
    }
    expect(sizes).toEqual([10, 10, 10]);
    expect(fetched).toEqual([1, 1, 2]);
    expect(output).not.toHaveProperty('next_cursor');
    expect(filingCalls().every((url) => url.searchParams.get('page_size') === '25')).toBe(true);
  });
  it.each([
    {
      name: 'filings',
      tool: searchFilings,
      input: { filing_year: 2024 },
      key: 'filings',
      size: 10,
    },
    {
      name: 'LD-203 reports',
      tool: getContributions,
      input: { filing_year: 2024 },
      key: 'reports',
      size: 10,
    },
    { name: 'identities', tool: searchLobbyists, input: { name: 'x' }, key: 'lobbyists', size: 25 },
    {
      name: 'candidates',
      tool: getClientProfile,
      input: { client_name: 'x' },
      key: 'candidates',
      size: 25,
    },
    {
      name: 'evidence rows',
      tool: searchLobbyists,
      input: { mode: 'activity', lobbyist_id: '7', filing_year: 2024 },
      key: 'evidence',
      size: 25,
    },
  ])('omitting page_size delivers $size $name', async ({ tool, input, key, size }) => {
    const rows = Array.from({ length: 30 }, (_, n) =>
      key === 'reports'
        ? { ...filing(n + 1), filing_period: 'mid_year', contribution_items: [] }
        : key === 'lobbyists' || key === 'candidates'
          ? { id: String(n + 1), name: 'x' }
          : filing(n + 1),
    );
    respond = () => Response.json(page(rows));
    const output = success(await invoke(tool, input));
    expect(list(output[key])).toHaveLength(size);
    expect(output).toMatchObject({ records_returned: size, output_complete: false });
  });
  it.each([
    { tool: getIssueSpending, input: { issue_code: 'TEC', years: [2024] } },
    { tool: getClientProfile, input: { mode: 'profile', client_ids: ['2'], years: [2024] } },
  ])('omitting page_size delivers 25 analytical rows', async ({ tool, input }) => {
    respond = () => Response.json(page(Array.from({ length: 30 }, (_, n) => filing(n + 1))));
    const output = success(await invoke(tool, input));
    expect(output).toMatchObject({ records_returned: 25, output_complete: false });
  });
  it.each([
    { name: 'filings', tool: searchFilings, input: { filing_year: 2024 }, cap: 25 },
    { name: 'LD-203 reports', tool: getContributions, input: { filing_year: 2024 }, cap: 25 },
    { name: 'identity search', tool: searchLobbyists, input: { name: 'x' }, cap: 25 },
    {
      name: 'activity evidence',
      tool: searchLobbyists,
      input: { mode: 'activity', lobbyist_id: '7', filing_year: 2024 },
      cap: 1000,
    },
    { name: 'client resolve', tool: getClientProfile, input: { client_name: 'x' }, cap: 25 },
    {
      name: 'client profile',
      tool: getClientProfile,
      input: { mode: 'profile', client_ids: ['2'], years: [2024] },
      cap: 250,
    },
    {
      name: 'issue spending',
      tool: getIssueSpending,
      input: { issue_code: 'TEC', years: [2024] },
      cap: 250,
    },
  ])(
    '$name serves page_size $cap and clamps $cap + 1 with disclosure',
    async ({ tool, input, cap }) => {
      const atCap = success(await invoke(tool, { ...input, page_size: cap }));
      expect(atCap.delivery_limits).toEqual({});
      expect(atCap.effective_filters).toMatchObject({ page_size: cap });
      const over = await invoke(tool, { ...input, page_size: cap + 1 });
      expect(success(over).delivery_limits).toEqual({
        page_size: { requested: cap + 1, effective: cap },
      });
      expect(over.data.effective_filters).toMatchObject({ page_size: cap });
      expect(over.text).toContain(`"page_size":{"requested":${cap + 1},"effective":${cap}}`);
    },
  );
  it.each([
    {
      name: 'filings',
      tool: searchFilings,
      input: { filing_year: 2024 },
      cap: 25,
      rows: () => Array.from({ length: 26 }, (_, n) => filing(n + 1)),
    },
    {
      name: 'LD-203 reports',
      tool: getContributions,
      input: { filing_year: 2024 },
      cap: 25,
      rows: () =>
        Array.from({ length: 26 }, (_, n) => ({
          ...filing(n + 1),
          filing_period: 'mid_year',
          contribution_items: [],
        })),
    },
    {
      name: 'identity search',
      tool: searchLobbyists,
      input: { name: 'x' },
      cap: 25,
      rows: () => Array.from({ length: 26 }, (_, n) => ({ id: String(n + 1), name: 'x' })),
    },
    {
      name: 'client resolve',
      tool: getClientProfile,
      input: { client_name: 'x' },
      cap: 25,
      rows: () => Array.from({ length: 26 }, (_, n) => ({ id: String(n + 1), name: 'x' })),
    },
    {
      name: 'activity evidence',
      tool: searchLobbyists,
      input: { mode: 'activity', lobbyist_id: '7', filing_year: 2024 },
      cap: 1000,
      // 1,001 filings each naming lobbyist 7 once yield 1,001 evidence rows.
      rows: () => Array.from({ length: 1001 }, (_, n) => filing(n + 1)),
    },
    {
      name: 'client profile',
      tool: getClientProfile,
      input: { mode: 'profile', client_ids: ['2'], years: [2024] },
      cap: 250,
      // 60 one-activity filings for 60 relationships: 304 analytical rows.
      rows: () => Array.from({ length: 60 }, (_, n) => filing(n + 1)),
    },
    {
      name: 'issue spending',
      tool: getIssueSpending,
      input: { issue_code: 'TEC', years: [2024] },
      cap: 250,
      rows: () => Array.from({ length: 60 }, (_, n) => filing(n + 1)),
    },
  ])(
    '$name delivers exactly $cap whole rows at the cap while more remain',
    async ({ tool, input, cap, rows }) => {
      respond = () => Response.json(page(rows()));
      const first = success(await invoke(tool, { ...input, page_size: cap }));
      expect(first).toMatchObject({ records_returned: cap, offset: 0, output_complete: false });
      const rest = success(await invoke(tool, { cursor: first.next_cursor }));
      expect(rest).toMatchObject({ offset: cap, output_complete: true });
      expect(Number(rest.records_returned)).toBeGreaterThan(0);
    },
  );
  it('records a clamp on the first call only, never on a continuation or its replay', async () => {
    respond = () => Response.json(page(Array.from({ length: 60 }, (_, n) => filing(n + 1))));
    const clamps: unknown[] = [];
    const logging: Definition = {
      ...searchFilings,
      handler: (args: never, ctx: Parameters<typeof searchFilings.handler>[1]) =>
        searchFilings.handler(args, {
          ...ctx,
          log: {
            ...ctx.log,
            info: (message: string, data?: Record<string, unknown>) => {
              if (message.startsWith('Clamped')) clamps.push(data);
            },
          },
        }),
    };
    const first = success(await invoke(logging, { filing_year: 2024, page_size: 26 }));
    expect(clamps).toEqual([
      { tool: 'uslobbying_search_filings', control: 'page_size', requested: 26, effective: 25 },
    ]);
    const second = success(await invoke(logging, { cursor: first.next_cursor, page_size: 26 }));
    expect(second.delivery_limits).toEqual({ page_size: { requested: 26, effective: 25 } });
    expect(success(await invoke(logging, { cursor: first.next_cursor }))).toEqual(second);
    expect(clamps).toHaveLength(1);
  });
  it('returns every record whole at the cap, however large', async () => {
    const large = 'é🌲'.repeat(10_000);
    respond = () =>
      Response.json(page(Array.from({ length: 26 }, (_, n) => filing(n + 1, { large }))));
    const output = success(
      await invoke(searchFilings, { filing_year: 2024, page_size: 25, include: BOTH }),
    );
    const filings = list(output.filings);
    expect(filings).toHaveLength(25);
    expect(filings.every((row) => row.large === large)).toBe(true);
    expect(activitiesIn(output).every((row) => row.description === DESCRIPTION)).toBe(true);
    const rest = success(await invoke(searchFilings, { cursor: output.next_cursor }));
    expect(list(rest.filings)).toEqual([expect.objectContaining({ filing_uuid: uuid(26), large })]);
    expect(rest).toMatchObject({ output_complete: true, offset: 25, records_returned: 1 });
  });
  it('rounds float count noise into the scope, accepts it on continuation, and clamps a very large page_size', async () => {
    respond = () => Response.json(page(Array.from({ length: 30 }, (_, n) => filing(n + 1))));
    const first = success(
      await invoke(searchFilings, {
        filing_year: 2024,
        page_size: 20.000000000000004,
        max_pages: 2.0000000000000004,
      }),
    );
    expect(first.effective_filters).toMatchObject({ page_size: 20 });
    expect(first.delivery_limits).toEqual({});
    expect(list(first.filings)).toHaveLength(20);
    const over = success(
      await invoke(searchFilings, { filing_year: 2024, page_size: 25.000000000000004 }),
    );
    expect(over.delivery_limits).toEqual({});
    expect(over.effective_filters).toMatchObject({ page_size: 25 });
    const rest = success(
      await invoke(searchFilings, { cursor: first.next_cursor, page_size: 20.000000000000004 }),
    );
    expect(list(rest.filings)).toHaveLength(10);
    expect(rest).toMatchObject({ offset: 20, output_complete: true });
    const huge = success(await invoke(searchFilings, { filing_year: 2024, page_size: 1e20 }));
    expect(huge.delivery_limits).toEqual({ page_size: { requested: 1e20, effective: 25 } });
    expect(huge.effective_filters).toMatchObject({ page_size: 25 });
  });
  it('rejects an over-cap count with invalid_filter naming the cap when USLOBBYING_CLAMP_LIMITS=false', async () => {
    vi.stubEnv('USLOBBYING_CLAMP_LIMITS', 'false');
    vi.resetModules();
    const lda = await import('../../../src/services/lda/lda-service.js');
    const { searchLobbyists: strict } = await import(
      '../../../src/mcp-server/tools/definitions/lda/search-lobbyists.tool.js'
    );
    getLdaService().dispose();
    lda.initLdaService({
      fetch: async (input) => {
        calls.push(new URL(String(input)));
        return Response.json(page([]));
      },
    });
    try {
      const input = { mode: 'activity', lobbyist_id: '7', filing_year: 2024 };
      const rejected = await invoke(strict, { ...input, page_size: 1001 });
      reason(rejected, 'invalid_filter');
      expect(rejected.data).toMatchObject({
        error: { data: { field: 'page_size', maximum: 1000 } },
      });
      expect(rejected.text).toContain('page_size cannot exceed 1000.');
      expect(calls).toEqual([]);
      const accepted = success(await invoke(strict, { ...input, page_size: 1000 }));
      expect(accepted.delivery_limits).toEqual({});
    } finally {
      lda.getLdaService().dispose();
      initLdaService({ fetch: async () => Response.json(page([])) });
    }
  });
  const tools = [
    searchFilings,
    getContributions,
    searchLobbyists,
    getClientProfile,
    getIssueSpending,
  ];
  it.each(tools)(
    '$name rejects removed record inputs and advertises no record surface',
    async (tool) => {
      for (const extra of [
        { record_handle: 'handle' },
        { record_path: '/filings/0' },
        { record_offset: 0 },
        { record_limit: 25 },
      ]) {
        const output = await invoke(tool, extra);
        expect(output.result.isError, JSON.stringify(extra)).toBe(true);
        expect(output.data).toMatchObject({ error: { code: -32602 } });
      }
      expect(calls).toEqual([]);
      const schemas = JSON.stringify([z.toJSONSchema(tool.input), z.toJSONSchema(tool.output!)]);
      for (const removed of [
        'record_handle',
        'record_path',
        'record_offset',
        'record_limit',
        'record_window',
        'record_handles',
        'records_deferred',
        'retrieval_tool',
      ])
        expect(schemas).not.toContain(removed);
      expect(
        z
          .object({ properties: z.object({ page_size: z.record(z.string(), z.unknown()) }) })
          .parse(z.toJSONSchema(tool.input)).properties.page_size,
      ).not.toHaveProperty('maximum');
    },
  );
});

describe('include selector', () => {
  it('leaves activity descriptions and lobbyists out of default search results and says so', async () => {
    respond = () => Response.json(page([filing(1)]));
    const output = await invoke(searchFilings, { filing_year: 2024 });
    const data = success(output);
    expect(activitiesIn(data)).toEqual([bare]);
    expect(list(data.filings)[0]).toMatchObject({ filing_uuid: uuid(1), income: '1.00' });
    expect(data.effective_filters).toEqual({ filing_year: 2024, include: [] });
    expect(data.notices).toContain(NOTICE_BOTH);
    expect(output.text).not.toContain(DESCRIPTION);
    expect(output.text).not.toContain(POSITION);
    expect(filingCalls()[0]!.searchParams.has('include')).toBe(false);
  });
  it.each([
    {
      include: ['activity_descriptions'],
      expected: { ...bare, description: DESCRIPTION },
      notice:
        'Lobbying activities omit lobbyists; a new call without cursor that adds activity_lobbyists to include returns those fields.',
    },
    {
      include: ['activity_lobbyists'],
      expected: { ...bare, lobbyists: activity.lobbyists },
      notice:
        'Lobbying activities omit description; a new call without cursor that adds activity_descriptions to include returns those fields.',
    },
    { include: [...BOTH].reverse(), expected: activity, notice: undefined },
  ])('include $include restores exactly its own fields', async ({ include, expected, notice }) => {
    respond = () => Response.json(page([filing(1)]));
    const output = success(await invoke(searchFilings, { filing_year: 2024, include }));
    expect(activitiesIn(output)).toEqual([expected]);
    expect(output.effective_filters).toMatchObject({ include: [...include].sort() });
    const notices = z.array(z.string()).parse(output.notices);
    expect(notices.filter((text) => text.startsWith('Lobbying activities omit'))).toEqual(
      notice ? [notice] : [],
    );
  });
  it('returns the complete filing for filing_uuid unless include narrows it', async () => {
    respond = () => Response.json(page([filing(1)]));
    const complete = success(await invoke(searchFilings, { filing_uuid: uuid(1) }));
    expect(activitiesIn(complete)).toEqual([activity]);
    expect(complete.effective_filters).toEqual({ filing_uuid: uuid(1), include: BOTH });
    expect(z.array(z.string()).parse(complete.notices).join('\n')).not.toContain('omit');
    const narrowed = success(await invoke(searchFilings, { filing_uuid: uuid(1), include: [] }));
    expect(activitiesIn(narrowed)).toEqual([bare]);
    expect(narrowed.notices).toContain(NOTICE_BOTH);
  });
  it('binds include to the cursor without changing the upstream query', async () => {
    respond = twoPages(30, (n) => filing(n));
    const first = success(
      await invoke(searchFilings, {
        filing_year: 2024,
        page_size: 10,
        include: ['activity_lobbyists'],
      }),
    );
    const cursor = first.next_cursor;
    for (const include of [[], ['activity_descriptions'], BOTH])
      reason(await invoke(searchFilings, { cursor, include }), 'cursor_invalid');
    const second = success(
      await invoke(searchFilings, { cursor, include: ['activity_lobbyists'] }),
    );
    expect(success(await invoke(searchFilings, { cursor }))).toEqual(second);
    const third = success(await invoke(searchFilings, { cursor: second.next_cursor }));
    for (const output of [first, second, third])
      expect(activitiesIn(output)).toEqual(
        Array.from({ length: 10 }, () => ({ ...bare, lobbyists: activity.lobbyists })),
      );
    expect(third.output_complete).toBe(true);
    expect(filingCalls()).toHaveLength(2);
    expect(filingCalls().every((url) => !url.searchParams.has('include'))).toBe(true);
  });
  it('rejects include in identity search and client resolve modes, and malformed selections, before transport', async () => {
    const search = await invoke(searchLobbyists, { name: 'x', include: [] });
    reason(search, 'invalid_filter');
    expect(search.text).toContain('covered_positions_only, include) cannot be used');
    reason(
      await invoke(getClientProfile, { client_name: 'x', include: ['activity_lobbyists'] }),
      'invalid_filter',
    );
    for (const include of [['activity_lobbyists', 'activity_lobbyists'], ['lobbyists'], 'all']) {
      const output = await invoke(searchFilings, { filing_year: 2024, include });
      expect(output.data, JSON.stringify(include)).toMatchObject({ error: { code: -32602 } });
    }
    // LD-203 reports carry no lobbying activities, so the selector is not an argument there.
    const contributions = await invoke(getContributions, { filing_year: 2024, include: [] });
    expect(contributions.data).toMatchObject({ error: { code: -32602 } });
    expect(calls).toEqual([]);
  });
  it('projects evidence activities while keeping the matched participant', async () => {
    respond = () => Response.json(page([filing(1)]));
    const input = { mode: 'activity', lobbyist_id: '7', filing_year: 2024 };
    const output = success(await invoke(searchLobbyists, input));
    expect(list(output.evidence)).toEqual([
      expect.objectContaining({
        lobbyist: { id: '7' },
        covered_position: POSITION,
        activity_index: 0,
        lobbyist_index: 0,
        activity: bare,
      }),
    ]);
    expect(output.effective_filters).toMatchObject({ include: [] });
    expect(output.notices).toContain(NOTICE_BOTH);
    const full = success(await invoke(searchLobbyists, { ...input, include: BOTH }));
    expect(list(full.evidence)[0]!.activity).toEqual(activity);
  });
  it.each([
    { tool: getIssueSpending, input: { issue_code: 'TEC', years: [2024] } },
    { tool: getClientProfile, input: { mode: 'profile', client_ids: ['2'], years: [2024] } },
  ])(
    'projects analytical filings and activities in every window with identical totals',
    async ({ tool, input }) => {
      respond = () => Response.json(page(Array.from({ length: 30 }, (_, n) => filing(n + 1))));
      async function drain(include: string[] | undefined) {
        let output = success(
          await invoke(tool, { ...input, page_size: 7, ...(include ? { include } : {}) }),
        );
        const windows = [output];
        for (let n = 0; n < 40 && output.next_cursor; n++) {
          output = success(await invoke(tool, { cursor: output.next_cursor }));
          windows.push(output);
        }
        expect(output.output_complete).toBe(true);
        return windows;
      }
      const narrow = await drain(undefined);
      const wide = await drain(BOTH);
      const narrowActivities = narrow.flatMap(activitiesIn);
      const wideActivities = wide.flatMap(activitiesIn);
      // 30 selected filings, 30 raw versions and 30 activity rows, crossing set boundaries mid-window.
      expect(narrowActivities).toHaveLength(90);
      expect(wideActivities).toHaveLength(90);
      expect(
        narrowActivities.every((row) => !('description' in row) && !('lobbyists' in row)),
      ).toBe(true);
      expect(wideActivities.every((row) => row.description === DESCRIPTION)).toBe(true);
      expect(
        narrow.every((output) => z.array(z.string()).parse(output.notices).includes(NOTICE_BOTH)),
      ).toBe(true);
      expect(narrow.at(-1)!.row_set_totals).toEqual(wide.at(-1)!.row_set_totals);
      expect(narrow.map((output) => output.records_returned)).toEqual(
        wide.map((output) => output.records_returned),
      );
      expect(narrow[0]!.effective_filters).toMatchObject({ include: [] });
      expect(wide[0]!.effective_filters).toMatchObject({ include: BOTH });
    },
  );
});
