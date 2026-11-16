/** @fileoverview Reporting-period, registrant-wide and client-breakdown wiring through the analytical tools. @module tests/tools/lda/analytics-wiring */
import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientProfile } from '../../../src/mcp-server/tools/definitions/lda/get-client-profile.tool.js';
import { getIssueSpending } from '../../../src/mcp-server/tools/definitions/lda/get-issue-spending.tool.js';
import { setCanvas } from '../../../src/services/canvas/canvas-service.js';
import { getLdaService, initLdaService } from '../../../src/services/lda/lda-service.js';
import { invoke, resetTenant, success, uuid } from './harness.js';

interface Report {
  client: { id: string; name: string };
  dt_posted: string;
  expenses: string | null;
  filing_period: string;
  filing_type: string;
  filing_uuid: string;
  filing_year: number;
  income: string | null;
  lobbying_activities: { general_issue_code: string }[];
  registrant: { id: string; name: string };
}
/** One LD-2 report for client record `client` of registrant `registrant`. */
function report(
  n: number,
  filing_type: string,
  filing_period: string,
  filing_year: number,
  posted: string,
  extra: Partial<Omit<Report, 'client' | 'registrant'>> & {
    client?: number;
    registrant?: number;
  } = {},
): Report {
  const { client = 2, registrant = 1, ...fields } = extra;
  return {
    filing_uuid: uuid(n),
    filing_type,
    filing_year,
    filing_period,
    dt_posted: `${posted}T00:00:00Z`,
    client: { id: String(client), name: `Client ${client}` },
    registrant: { id: String(registrant), name: `Firm ${registrant}` },
    income: null,
    expenses: null,
    lobbying_activities: [{ general_issue_code: 'TEC' }],
    ...fields,
  };
}
const REGISTRANT_WIDE =
  'Without issue_code, ledgers cover every selected filing in the registrant scope, not one issue; issue_codes rows give the overlapping per-issue view.';
const versionEmptied = (year: number) =>
  `No filing acquired for ${year} survived version selection; its selections rows give each exclusion or ambiguity.`;
const issueEmptied = (year: number, kept: number, code: string) =>
  `Version selection kept ${kept} filing${kept === 1 ? '' : 's'} for ${year}, but none mention issue_code ${code}.`;
/** Every set in delivery order, written independently of the row-set schema. */
const ORDER = [
  'annual_ledgers',
  'selections',
  'firms',
  'clients',
  'issue_codes',
  'targeted_entities',
  'selected_filings',
  'activities',
  'raw_filings',
] as const;

let calls: URL[];
let filings: Report[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01'));
  resetTenant();
  calls = [];
  filings = [];
  setCanvas(undefined);
  initLdaService({
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://lda.gov') throw new Error(`Unexpected source ${url.origin}`);
      calls.push(url);
      if (url.pathname.includes('/constants/'))
        return Response.json([
          { value: 'TEC', name: 'Telecommunications' },
          { value: 'HCR', name: 'Health' },
        ]);
      // Honors the native partition filters the analytical tools send.
      const p = url.searchParams;
      const results = filings.filter(
        (row) =>
          String(row.filing_year) === p.get('filing_year') &&
          (!p.has('client_id') || row.client.id === p.get('client_id')) &&
          (!p.has('registrant_id') || row.registrant.id === p.get('registrant_id')),
      );
      return Response.json({ count: results.length, next: null, results });
    },
  });
});
afterEach(() => {
  getLdaService().dispose();
  vi.useRealTimers();
});

function failure(value: Awaited<ReturnType<typeof invoke>>, reason: string) {
  expect(value.result.isError).toBe(true);
  const error = z
    .object({
      error: z.object({
        data: z.object({ reason: z.string(), recovery: z.object({ hint: z.string() }) }),
      }),
    })
    .parse(value.data).error.data;
  expect(error.reason).toBe(reason);
  expect(value.text).toContain(reason);
  return { hint: error.recovery.hint, text: value.text };
}
const notices = (output: Record<string, unknown>) => z.array(z.string()).parse(output.notices);
const filingCalls = () => calls.filter((url) => url.pathname === '/api/v1/filings/');

describe('reporting periods', () => {
  it('parses an off-cycle year-end report beside 2008 quarters on both surfaces', async () => {
    const quarters = ['first_quarter', 'second_quarter', 'third_quarter', 'fourth_quarter'];
    const posted = ['2008-04-20', '2008-07-20', '2008-10-20', '2009-01-20'];
    filings = [
      ...quarters.map((period, i) =>
        report(i + 1, `Q${i + 1}`, period, 2008, posted[i]!, { income: '25000.00' }),
      ),
      report(5, 'YY', 'year_end', 2008, '2009-02-14', { income: '50000.00' }),
    ];
    const value = await invoke(getClientProfile, {
      mode: 'profile',
      client_ids: ['2'],
      years: [2008],
      row_sets: ['annual_ledgers', 'selections'],
    });
    const output = success(value);
    expect(output.selections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          period: 'year_end',
          status: 'excluded',
          exclusion_reason: 'off_cycle_period',
          candidate_filing_uuids: [uuid(5)],
        }),
      ]),
    );
    expect(output.annual_ledgers).toMatchObject([
      { year: 2008, known_income_usd: '100000.00', matching_filing_count: 4 },
    ]);
    expect(value.text).toContain('"exclusion_reason":"off_cycle_period"');
  });
  it('names each emptied year and what emptied it while another year selects', async () => {
    filings = [
      report(1, 'RR', 'first_quarter', 2022, '2022-01-20'),
      report(2, 'Q1', 'first_quarter', 2023, '2023-04-20', {
        lobbying_activities: [{ general_issue_code: 'HCR' }],
      }),
      report(3, 'Q1', 'first_quarter', 2024, '2024-04-20', { income: '10.00' }),
    ];
    const value = await invoke(getIssueSpending, {
      issue_code: 'tec',
      client_id: '2',
      years: [2022, 2023, 2024],
      row_sets: ['annual_ledgers'],
    });
    const output = success(value);
    expect(output.annual_ledgers).toMatchObject([
      { year: 2022, matching_filing_count: 0 },
      { year: 2023, matching_filing_count: 0 },
      { year: 2024, matching_filing_count: 1, known_income_usd: '10.00' },
    ]);
    const emptied = notices(output).filter((notice) => /survived|kept/.test(notice));
    expect(emptied).toEqual([versionEmptied(2022), issueEmptied(2023, 1, 'TEC')]);
    for (const notice of emptied) expect(value.text).toContain(notice);
    expect(output.total_records).toBe(5);
  });
  it('sends one notice per emptied year and no scope-wide duplicate when nothing selects', async () => {
    filings = [
      report(1, 'RR', 'first_quarter', 2023, '2023-01-20'),
      report(2, 'YY', 'first_quarter', 2024, '2024-04-20'),
    ];
    const output = success(
      await invoke(getClientProfile, { mode: 'profile', client_ids: ['2'], years: [2023, 2024] }),
    );
    expect(output.selections).toMatchObject([
      { year: 2023, status: 'excluded', exclusion_reason: 'registration' },
      { year: 2024, status: 'excluded', exclusion_reason: 'unknown_variant' },
    ]);
    const all = notices(output);
    expect(all.filter((notice) => notice.includes('survived'))).toEqual([
      versionEmptied(2023),
      versionEmptied(2024),
    ]);
    // ledgers 2 + selections 2 + raw filings 2 + one notice per emptied year
    expect(output.total_records).toBe(8);
    expect(output.records_returned).toBe(8);
  });
});

describe('sparse source filings', () => {
  it('analyzes a selected filing that carries no lobbying_activities without adding one', async () => {
    const { lobbying_activities: _omitted, ...sparse } = report(
      1,
      'Q1',
      'first_quarter',
      2024,
      '2024-04-20',
      { income: '5.00' },
    );
    filings = [
      sparse as Report,
      report(2, 'Q2', 'second_quarter', 2024, '2024-07-20', { income: '7.00' }),
    ];
    const value = await invoke(getClientProfile, {
      mode: 'profile',
      client_ids: ['2'],
      years: [2024],
    });
    const output = success(value);
    expect(output.row_set_totals).toEqual({
      annual_ledgers: 1,
      selections: 2,
      firms: 1,
      clients: 1,
      issue_codes: 1,
      targeted_entities: 0,
      selected_filings: 2,
      activities: 1,
      raw_filings: 2,
    });
    expect(output.annual_ledgers).toMatchObject([
      {
        year: 2024,
        known_income_usd: '12.00',
        matching_filing_count: 2,
        multi_issue_filing_count: 0,
      },
    ]);
    expect(output.issue_codes).toMatchObject([{ issue_code: 'TEC', filing_uuids: [uuid(2)] }]);
    for (const key of ['selected_filings', 'raw_filings']) {
      const rows = z.array(z.record(z.string(), z.unknown())).parse(output[key]);
      expect(rows.map((row) => row.filing_uuid)).toEqual([uuid(1), uuid(2)]);
      expect(rows[0], key).not.toHaveProperty('lobbying_activities');
    }
  });
});

describe('registrant-wide issue spending', () => {
  /** Registrant 1 across two years; registrant 9's filing must never reach a registrant-1 scope. */
  const firmYears = () => [
    report(1, 'Q4', 'fourth_quarter', 2023, '2024-01-15', { income: '300.00' }),
    report(2, 'Q1', 'first_quarter', 2024, '2024-04-01', { income: '100.00' }),
    report(3, 'Q2', 'second_quarter', 2024, '2024-07-01', {
      income: '200.00',
      lobbying_activities: [{ general_issue_code: 'HCR' }],
    }),
    report(4, 'Q1', 'first_quarter', 2024, '2024-04-02', {
      client: 3,
      income: '50.00',
      lobbying_activities: [{ general_issue_code: 'HCR' }],
    }),
    report(5, '1A', 'first_quarter', 2024, '2024-05-01', {
      client: 3,
      income: '60.00',
      lobbying_activities: [{ general_issue_code: 'HCR' }],
    }),
    report(6, 'RR', 'first_quarter', 2024, '2024-01-10', { client: 4, lobbying_activities: [] }),
    report(7, 'Q1Y', 'first_quarter', 2024, '2024-04-03', { client: 5, lobbying_activities: [] }),
    report(8, 'Q1', 'first_quarter', 2024, '2024-04-04', {
      client: 6,
      registrant: 9,
      income: '999.00',
    }),
  ];
  it('characterizes issue-scoped ledgers, selections and breakdowns', async () => {
    filings = firmYears();
    const output = success(
      await invoke(getIssueSpending, {
        issue_code: 'TEC',
        registrant_id: '1',
        years: [2023, 2024],
        row_sets: ['annual_ledgers', 'selections', 'firms', 'issue_codes', 'selected_filings'],
      }),
    );
    expect(output.issue_code).toBe('TEC');
    expect(output.annual_ledgers).toMatchObject([
      { year: 2023, known_income_usd: '300.00', matching_filing_count: 1 },
      { year: 2024, known_income_usd: '100.00', matching_filing_count: 1 },
    ]);
    expect(
      z
        .array(z.object({ status: z.string() }))
        .parse(output.selections)
        .map((selection) => selection.status),
    ).toEqual(['excluded', 'selected', 'selected', 'selected', 'selected', 'selected']);
    expect(output.firms).toMatchObject([
      { registrant_id: '1', client_ids: ['2'], filing_uuids: [uuid(1), uuid(2)] },
    ]);
    expect(output.issue_codes).toMatchObject([
      { issue_code: 'TEC', filing_uuids: [uuid(1), uuid(2)] },
    ]);
    expect(notices(output)).not.toContain(REGISTRANT_WIDE);
    expect(calls.filter((url) => url.pathname.includes('/constants/'))).toHaveLength(1);
  });
  it('ledgers every selected filing of a registrant without issue_code', async () => {
    filings = firmYears();
    const value = await invoke(getIssueSpending, {
      registrant_id: '1',
      years: [2023, 2024],
      row_sets: ['annual_ledgers', 'selections', 'clients', 'issue_codes', 'selected_filings'],
    });
    const output = success(value);
    expect(output).not.toHaveProperty('issue_code');
    expect(output.years).toEqual([2023, 2024]);
    expect(output.row_set_totals).toEqual({
      annual_ledgers: 2,
      selections: 6,
      firms: 1,
      clients: 3,
      issue_codes: 2,
      targeted_entities: 0,
      selected_filings: 5,
      activities: 4,
      raw_filings: 7,
    });
    expect(output).toMatchObject({ records_returned: 18, output_complete: true });
    const ledgers = z
      .array(
        z.object({
          year: z.number(),
          matching_filing_count: z.number(),
          income_filing_count: z.number(),
          known_income_usd: z.string().optional(),
        }),
      )
      .parse(output.annual_ledgers);
    expect(ledgers).toMatchObject([
      { year: 2023, known_income_usd: '300.00', matching_filing_count: 1 },
      { year: 2024, known_income_usd: '360.00', matching_filing_count: 4 },
    ]);
    const selections = z
      .array(z.object({ year: z.number(), status: z.string() }))
      .parse(output.selections);
    for (const ledger of ledgers)
      expect(ledger.matching_filing_count).toBe(
        selections.filter((item) => item.year === ledger.year && item.status === 'selected').length,
      );
    const clients = z
      .array(
        z.object({
          client_id: z.string(),
          name: z.string(),
          registrant_id: z.string(),
          filing_uuids: z.array(z.string()),
          annual_ledgers: z.array(
            z.object({
              year: z.number(),
              matching_filing_count: z.number(),
              income_filing_count: z.number(),
              known_income_usd: z.string().optional(),
            }),
          ),
        }),
      )
      .parse(output.clients);
    expect(clients).toMatchObject([
      {
        client_id: '2',
        name: 'Client 2',
        registrant_id: '1',
        filing_uuids: [uuid(1), uuid(2), uuid(3)],
        annual_ledgers: [
          { year: 2023, known_income_usd: '300.00', matching_filing_count: 1 },
          { year: 2024, known_income_usd: '300.00', matching_filing_count: 2 },
        ],
      },
      {
        client_id: '3',
        registrant_id: '1',
        filing_uuids: [uuid(5)],
        annual_ledgers: [
          { year: 2023, matching_filing_count: 0 },
          { year: 2024, known_income_usd: '60.00', matching_filing_count: 1 },
        ],
      },
      {
        client_id: '5',
        registrant_id: '1',
        filing_uuids: [uuid(7)],
        annual_ledgers: [
          { year: 2023, matching_filing_count: 0 },
          { year: 2024, income_filing_count: 0, matching_filing_count: 1 },
        ],
      },
    ]);
    // Each selected filing sits in exactly one client row, so client ledgers add up to the annual ledger.
    const selected = z
      .array(z.object({ filing_uuid: z.string() }))
      .parse(output.selected_filings)
      .map((row) => row.filing_uuid);
    const assigned = clients.flatMap((client) => client.filing_uuids);
    expect(assigned.toSorted()).toEqual(selected.toSorted());
    for (const ledger of ledgers) {
      const rows = clients.map(
        (client) => client.annual_ledgers.find((entry) => entry.year === ledger.year)!,
      );
      expect(rows.reduce((sum, row) => sum + row.matching_filing_count, 0)).toBe(
        ledger.matching_filing_count,
      );
      expect(rows.reduce((sum, row) => sum + row.income_filing_count, 0)).toBe(
        ledger.income_filing_count,
      );
      expect(
        rows.reduce((cents, row) => cents + Math.round(Number(row.known_income_usd ?? 0) * 100), 0),
      ).toBe(Math.round(Number(ledger.known_income_usd) * 100));
    }
    expect(output.issue_codes).toMatchObject([
      { issue_code: 'TEC', filing_uuids: [uuid(1), uuid(2)] },
      { issue_code: 'HCR', filing_uuids: [uuid(3), uuid(5)] },
    ]);
    expect(notices(output)).toContain(REGISTRANT_WIDE);
    expect(value.text).toContain(REGISTRANT_WIDE);
    expect(calls.some((url) => url.pathname.includes('/constants/'))).toBe(false);
    expect(filingCalls().map((url) => url.searchParams.get('registrant_id'))).toEqual(['1', '1']);
    expect(filingCalls().some((url) => url.searchParams.has('issue_code'))).toBe(false);
  });
  it('continues a registrant-wide scan with cursor alone and rejects a continuation adding issue_code', async () => {
    filings = firmYears();
    const first = success(
      await invoke(getIssueSpending, { registrant_id: '1', years: [2023, 2024], max_pages: 1 }),
    );
    expect(first).toMatchObject({ status: 'collecting', records_returned: 0 });
    expect(first).not.toHaveProperty('issue_code');
    expect(notices(first)).toContain(REGISTRANT_WIDE);
    failure(
      await invoke(getIssueSpending, { cursor: first.next_cursor, issue_code: 'TEC' }),
      'cursor_invalid',
    );
    expect(filingCalls()).toHaveLength(1);
    let output = success(await invoke(getIssueSpending, { cursor: first.next_cursor }));
    expect(output.status).toBe('complete');
    expect(filingCalls()).toHaveLength(2);
    let delivered = 0;
    for (let windows = 0; windows < 10; windows++) {
      expect(output).not.toHaveProperty('issue_code');
      expect(notices(output)).toContain(REGISTRANT_WIDE);
      expect(output.offset).toBe(delivered);
      delivered += z.number().parse(output.records_returned);
      if (output.output_complete) break;
      failure(
        await invoke(getIssueSpending, { cursor: output.next_cursor, issue_code: 'TEC' }),
        'cursor_invalid',
      );
      output = success(await invoke(getIssueSpending, { cursor: output.next_cursor }));
    }
    expect(output.output_complete).toBe(true);
    // 2 ledgers, 6 selections, 1 firm, 3 clients, 2 issues, 5 selected, 4 activities, 7 raw
    expect(delivered).toBe(30);
    expect(output.total_records).toBe(30);
    expect(filingCalls()).toHaveLength(2);
    expect(calls.some((url) => url.pathname.includes('/constants/'))).toBe(false);
  });
  it('returns an honest empty registrant-wide scope', async () => {
    const output = success(await invoke(getIssueSpending, { registrant_id: '77', years: [2024] }));
    expect(output).not.toHaveProperty('issue_code');
    expect(output).not.toHaveProperty('clients');
    expect(output.row_set_totals).toEqual({
      annual_ledgers: 0,
      selections: 0,
      firms: 0,
      clients: 0,
      issue_codes: 0,
      targeted_entities: 0,
      selected_filings: 0,
      activities: 0,
      raw_filings: 0,
    });
    expect(notices(output)).toEqual(
      expect.arrayContaining([
        REGISTRANT_WIDE,
        expect.stringMatching(/^No source filings were fetched for .*registrant_id=77/),
      ]),
    );
    expect(notices(output).some((notice) => notice.includes('survived'))).toBe(false);
  });
  it.each([
    { name: 'client_id alone', input: { client_id: '2', years: [2024] } },
    { name: 'no scope', input: { years: [2024] } },
  ])('still rejects $name without issue_code before transport', async ({ input }) => {
    failure(await invoke(getIssueSpending, input), 'invalid_filter');
    expect(calls).toEqual([]);
  });
  it.each([
    {
      name: 'client_id alone',
      input: { client_id: '2', years: [2024] },
      next: 'uslobbying_get_client_profile',
    },
    { name: 'no scope', input: { years: [2024] }, next: 'registrant_id' },
  ])('names the next step when $name has no issue_code', async ({ input, next }) => {
    const { hint, text } = failure(await invoke(getIssueSpending, input), 'invalid_filter');
    expect(hint).toContain(next);
    expect(hint).toContain('issue_code');
    expect(text).toContain(hint);
  });
});

describe('client relationship rows', () => {
  /** Client 11 files in both years; clients 11–14 belong to firm 1 and 15–17 to firm 9. */
  const relationships = () => [
    report(1, 'Q4', 'fourth_quarter', 2023, '2024-01-15', { client: 11, income: '30.00' }),
    ...Array.from({ length: 7 }, (_, i) =>
      report(i + 2, 'Q1', 'first_quarter', 2024, '2024-04-20', {
        client: 11 + i,
        registrant: i < 4 ? 1 : 9,
        income: `${11 + i}.00`,
      }),
    ),
  ];
  const expectedClients = Array.from({ length: 7 }, (_, i) => ({
    client_id: String(11 + i),
    name: `Client ${11 + i}`,
    registrant_id: i < 4 ? '1' : '9',
    filing_uuids: i === 0 ? [uuid(1), uuid(2)] : [uuid(i + 2)],
    annual_ledgers: [
      i === 0
        ? { year: 2023, known_income_usd: '30.00', matching_filing_count: 1 }
        : { year: 2023, matching_filing_count: 0, income_filing_count: 0 },
      { year: 2024, known_income_usd: `${11 + i}.00`, matching_filing_count: 1 },
    ],
  }));
  const totals = {
    annual_ledgers: 2,
    selections: 8,
    firms: 2,
    clients: 7,
    issue_codes: 1,
    targeted_entities: 0,
    selected_filings: 8,
    activities: 8,
    raw_filings: 8,
  };
  it.each([
    { name: 'every set', row_sets: undefined, page_size: 7 },
    {
      name: 'firms, clients and issues',
      row_sets: ['issue_codes', 'clients', 'firms'],
      page_size: 3,
    },
  ])(
    'pages $name across windows that cross from firms into clients and start inside clients',
    async ({ row_sets, page_size }) => {
      filings = relationships();
      const selected = new Set<string>(row_sets ?? ORDER);
      const rows = ORDER.reduce((sum, name) => sum + (selected.has(name) ? totals[name] : 0), 0);
      let output = success(
        await invoke(getIssueSpending, {
          issue_code: 'TEC',
          years: [2023, 2024],
          page_size,
          ...(row_sets ? { row_sets } : {}),
        }),
      );
      const clients: unknown[] = [];
      const firms: unknown[] = [];
      let delivered = 0;
      let crossed = false;
      let startedInside = false;
      let pastClients = false;
      for (let windows = 0; windows < 20; windows++) {
        expect(output.row_set_totals).toEqual(totals);
        const offsets: Record<string, number> = {};
        let preceding = 0;
        for (const name of ORDER) {
          offsets[name] = selected.has(name)
            ? Math.min(totals[name], Math.max(0, delivered - preceding))
            : 0;
          if (selected.has(name)) preceding += totals[name];
        }
        expect(output.row_set_offsets).toEqual(offsets);
        expect(output.offset).toBe(delivered);
        const returned = Math.min(page_size, rows - delivered);
        expect(output.records_returned).toBe(returned);
        // Each set holds exactly its share of this window's slice of the ordered row stream.
        let start = 0;
        for (const name of ORDER) {
          if (!selected.has(name)) {
            expect(output).not.toHaveProperty(name);
            continue;
          }
          const end = Math.min(delivered + returned, start + totals[name]);
          const share = Math.max(0, end - Math.max(delivered, start));
          expect(z.array(z.unknown()).parse(output[name] ?? []), name).toHaveLength(share);
          start += totals[name];
        }
        const windowClients = z.array(z.unknown()).parse(output.clients ?? []);
        expect(windowClients).toMatchObject(
          expectedClients.slice(offsets.clients, offsets.clients! + windowClients.length),
        );
        if (offsets.firms! < totals.firms && output.firms !== undefined && windowClients.length)
          crossed = true;
        if (offsets.clients! > 0 && offsets.clients! < totals.clients) startedInside = true;
        if (offsets.clients === totals.clients) {
          pastClients = true;
          expect(output).not.toHaveProperty('clients');
        }
        clients.push(...windowClients);
        firms.push(...z.array(z.unknown()).parse(output.firms ?? []));
        delivered += z.number().parse(output.records_returned);
        if (output.output_complete) break;
        const cursor = output.next_cursor;
        const next = success(await invoke(getIssueSpending, { cursor }));
        expect(success(await invoke(getIssueSpending, { cursor }))).toEqual(next);
        output = next;
      }
      expect(output.output_complete).toBe(true);
      expect(output).not.toHaveProperty('next_cursor');
      expect(delivered).toBe(rows);
      expect(output.total_records).toBe(rows);
      expect(crossed).toBe(true);
      expect(startedInside).toBe(true);
      expect(pastClients).toBe(true);
      expect(clients).toMatchObject(expectedClients);
      expect(firms).toMatchObject([
        { registrant_id: '1', client_ids: ['11', '12', '13', '14'] },
        { registrant_id: '9', client_ids: ['15', '16', '17'] },
      ]);
      expect(filingCalls()).toHaveLength(2);
    },
  );
  it('delivers client rows alone in profile mode', async () => {
    filings = [
      report(1, 'Q1', 'first_quarter', 2024, '2024-04-20', { income: '1.00' }),
      report(2, 'Q1', 'first_quarter', 2024, '2024-04-21', { client: 3, expenses: '2.00' }),
    ];
    const output = success(
      await invoke(getClientProfile, {
        mode: 'profile',
        client_ids: ['3', '2'],
        years: [2024],
        row_sets: ['clients'],
      }),
    );
    expect(output).toMatchObject({ records_returned: 2, total_records: 2, output_complete: true });
    expect(output).not.toHaveProperty('firms');
    expect(output.row_set_totals).toMatchObject({ firms: 1, clients: 2 });
    expect(output.clients).toMatchObject([
      {
        client_id: '2',
        registrant_id: '1',
        filing_uuids: [uuid(1)],
        annual_ledgers: [{ year: 2024, known_income_usd: '1.00', matching_filing_count: 1 }],
      },
      {
        client_id: '3',
        registrant_id: '1',
        filing_uuids: [uuid(2)],
        annual_ledgers: [{ year: 2024, known_expenses_usd: '2.00', matching_filing_count: 1 }],
      },
    ]);
  });
});
