/** @fileoverview Independent disclosure selection and accounting examples. @module tests/services/lobbying/analysis */
import { describe, expect, it } from 'vitest';
import { ContributionReportSchema, type Filing, FilingSchema } from '../../../src/domain/lda.js';
import {
  type AnnualLedger,
  analyzeFilings,
  centsToMoney,
  filterContributionReports,
  lobbyistEvidence,
  matchContributionItems,
  moneyToCents,
  selectPeriodFilings,
} from '../../../src/services/lobbying/analysis.js';

function filing(n: number, fields: Partial<Filing> = {}): Filing {
  return FilingSchema.parse({
    filing_uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    filing_type: 'Q1',
    filing_year: 2024,
    filing_period: 'first_quarter',
    dt_posted: '2024-04-01T00:00:00Z',
    registrant: { id: '10', name: 'Synthetic firm' },
    client: { id: String(n), name: 'Synthetic client' },
    ...fields,
  });
}

describe('version selection', () => {
  it.each(['selection', 'analysis'])(
    'consumes asynchronous filing chunks for %s',
    async (operation) => {
      const original = filing(20, { income: '100.00' });
      const amendment = filing(21, {
        client: original.client,
        filing_type: '1A',
        dt_posted: '2024-04-02T00:00:00Z',
        income: '12.34',
        expenses: null,
        future_disclosure: { nested: [null, 'preserved'] },
      });
      const ambiguous = filing(22, { income: '999.00' });
      const tied = filing(23, { client: ambiguous.client });
      const unknown = filing(24, { filing_type: 'FUTURE', income: '888.00' });
      async function* chunks() {
        yield original;
        yield ambiguous;
        await Promise.resolve();
        yield amendment;
        yield tied;
        await Promise.resolve();
        yield unknown;
        yield original;
      }
      const selection =
        operation === 'selection'
          ? await selectPeriodFilings(chunks())
          : await analyzeFilings(chunks());
      expect(selection.selected).toEqual([amendment]);
      expect(selection.selections).toMatchObject([
        {
          status: 'selected',
          selected_filing_uuid: amendment.filing_uuid,
          superseded_filing_uuids: [original.filing_uuid],
        },
        { status: 'ambiguous', candidate_filing_uuids: [ambiguous.filing_uuid, tied.filing_uuid] },
        {
          status: 'excluded',
          exclusion_reason: 'unknown_variant',
          candidate_filing_uuids: [unknown.filing_uuid],
        },
      ]);
      if ('annual_ledgers' in selection)
        expect(selection.annual_ledgers).toEqual([
          {
            year: 2024,
            known_income_usd: '12.34',
            income_filing_count: 1,
            expense_filing_count: 0,
            missing_amount_count: 0,
            missing_income_count: 0,
            missing_expense_count: 1,
            ambiguous_group_count: 1,
            matching_filing_count: 1,
            multi_issue_filing_count: 0,
            expense_methods: [{ method: null, expense_filing_count: 0, missing_expense_count: 1 }],
          },
        ]);
    },
  );
  const periods = ['first_quarter', 'second_quarter', 'third_quarter', 'fourth_quarter'];
  it.each(
    periods.flatMap((period, i) =>
      [
        `Q${i + 1}`,
        `Q${i + 1}Y`,
        `${i + 1}T`,
        `${i + 1}TY`,
        `${i + 1}A`,
        `${i + 1}AY`,
        `${i + 1}@`,
        `${i + 1}@Y`,
      ].map((type) => [period, type]),
    ),
  )('selects %s %s', async (period, type) => {
    expect(
      (await selectPeriodFilings([filing(1, { filing_period: period, filing_type: type })]))
        .selected,
    ).toHaveLength(1);
  });
  it.each(
    Object.entries({
      mid_year: ['MM', 'MMY', 'MT', 'MTY', 'MA', 'MAY', 'M@', 'M@Y'],
      year_end: ['YY', 'YYY', 'YT', 'YTY', 'YA', 'YAY', 'Y@', 'Y@Y'],
    }).flatMap(([period, types]) => types.map((type) => [period, type])),
  )('selects semiannual %s %s', async (period, type) => {
    const report = filing(1, { filing_year: 2004, filing_period: period, filing_type: type });
    expect((await selectPeriodFilings([report])).selected).toEqual([report]);
  });
  it.each([
    ['first_quarter', 'Q2'],
    ['second_quarter', 'MMY'],
    ['third_quarter', '4A'],
    ['fourth_quarter', 'YY'],
    ['mid_year', 'YY'],
    ['mid_year', 'Q2'],
    ['year_end', 'MMY'],
    ['mid_year', 'MY'],
  ])('holds %s filed as %s as an unknown variant', async (period, type) => {
    const result = await selectPeriodFilings([
      filing(1, { filing_year: 2005, filing_period: period, filing_type: type }),
    ]);
    expect(result.selected).toEqual([]);
    expect(result.selections).toMatchObject([
      { status: 'excluded', exclusion_reason: 'unknown_variant' },
    ]);
  });
  it('selects amendment before issue filtering, preserving null amounts', async () => {
    const original = filing(1, {
      income: '30000.00',
      lobbying_activities: [{ general_issue_code: 'TEC' }],
    });
    const amendment = filing(2, {
      client: original.client,
      filing_type: '1AY',
      dt_posted: '2024-04-02T00:00:00Z',
      income: null,
      expenses: null,
      lobbying_activities: [],
    });
    const result = await analyzeFilings([original, amendment, original], { issue_code: 'TEC' });
    expect(result.selected).toEqual([]);
    expect(result.selections[0]).toMatchObject({
      selected_filing_uuid: amendment.filing_uuid,
      superseded_filing_uuids: [original.filing_uuid],
    });
    expect((await analyzeFilings([original, amendment])).annual_ledgers[0]).toMatchObject({
      missing_amount_count: 1,
      income_filing_count: 0,
    });
    expect((await analyzeFilings([original, amendment])).annual_ledgers[0]).not.toHaveProperty(
      'known_income_usd',
    );
  });
  it('excludes registrations, unknown periods, unknown latest variants and missing identities', async () => {
    const result = await selectPeriodFilings([
      filing(1, { filing_type: 'RR' }),
      filing(2, { filing_type: 'RA' }),
      filing(3, { filing_type: 'MM', filing_period: 'future_period' }),
      filing(4, { filing_type: 'future' }),
      filing(5, { client: null }),
    ]);
    expect(result.selected).toEqual([]);
    expect(result.selections.map((x) => x.exclusion_reason)).toEqual([
      'registration',
      'registration',
      'non_quarterly',
      'missing_relationship',
      'unknown_variant',
    ]);
  });
  it('holds equal latest instants ambiguous even across timestamp offsets', async () => {
    const a = filing(1);
    const b = filing(2, { client: a.client, dt_posted: '2024-03-31T20:00:00-04:00' });
    const result = await analyzeFilings([a, b]);
    expect(result.selected).toEqual([]);
    expect(result.selections[0]).toMatchObject({
      status: 'ambiguous',
      candidate_filing_uuids: [a.filing_uuid, b.filing_uuid],
    });
    expect(result.annual_ledgers[0]).toMatchObject({
      ambiguous_group_count: 1,
      matching_filing_count: 0,
    });
  });
});

const QUARTERS = ['first_quarter', 'second_quarter', 'third_quarter', 'fourth_quarter'];
/** One report in a synthetic registrant/client relationship; `posted` orders versions. */
function report(
  n: number,
  filing_type: string,
  filing_period: string,
  filing_year: number,
  posted: string,
  fields: Partial<Filing> = {},
): Filing {
  return filing(n, {
    filing_type,
    filing_period,
    filing_year,
    dt_posted: `${posted}T12:00:00Z`,
    client: { id: '9000', name: 'Synthetic client' },
    ...fields,
  });
}
/** Q1–Q4 originals for one relationship-year, numbered from `first`. */
function quarters(first: number, year: number, fields: Partial<Filing> = {}): Filing[] {
  return QUARTERS.map((period, i) =>
    report(first + i, `Q${i + 1}`, period, year, `${year}-0${i + 1}-28`, fields),
  );
}

describe('reporting grain', () => {
  it('selects a 2004 mid-year and year-end pair into one annual ledger', async () => {
    const mm = report(1, 'MM', 'mid_year', 2004, '2004-08-17', { income: '240000.00' });
    const yy = report(2, 'YY', 'year_end', 2004, '2005-02-15', { income: '220000.00' });
    const result = await analyzeFilings([mm, yy]);
    expect(result.selected).toEqual([mm, yy]);
    expect(result.selections.map((x) => x.status)).toEqual(['selected', 'selected']);
    expect(result.annual_ledgers).toMatchObject([
      {
        year: 2004,
        known_income_usd: '460000.00',
        income_filing_count: 2,
        matching_filing_count: 2,
      },
    ]);
  });
  it('selects a mid-year amendment over the report it supersedes', async () => {
    const mm = report(1, 'MM', 'mid_year', 2004, '2004-08-17', { income: '240000.00' });
    const ma = report(2, 'MA', 'mid_year', 2004, '2004-11-02', { income: '250000.00' });
    const result = await analyzeFilings([mm, ma]);
    expect(result.selected).toEqual([ma]);
    expect(result.selections).toEqual([
      {
        registrant_id: '10',
        client_id: '9000',
        year: 2004,
        period: 'mid_year',
        selection_method: 'latest_posted_within_relationship_period',
        status: 'selected',
        selected_filing_uuid: ma.filing_uuid,
        candidate_filing_uuids: [ma.filing_uuid],
        superseded_filing_uuids: [mm.filing_uuid],
      },
    ]);
    expect(result.annual_ledgers[0]).toMatchObject({
      known_income_usd: '250000.00',
      matching_filing_count: 1,
    });
  });
  it('keeps 2008 quarters and sets aside a year-end report filed beside them', async () => {
    const yy = report(1, 'YY', 'year_end', 2008, '2008-01-12', { income: '50000.00' });
    const q = quarters(2, 2008, { income: '25000.00' });
    const result = await analyzeFilings([yy, ...q]);
    expect(result.selected).toEqual(q);
    expect(result.selections[0]).toEqual({
      registrant_id: '10',
      client_id: '9000',
      year: 2008,
      period: 'year_end',
      selection_method: 'latest_posted_within_relationship_period',
      status: 'excluded',
      exclusion_reason: 'off_cycle_period',
      candidate_filing_uuids: [yy.filing_uuid],
      superseded_filing_uuids: [],
    });
    expect(result.annual_ledgers).toMatchObject([
      {
        year: 2008,
        known_income_usd: '100000.00',
        matching_filing_count: 4,
        ambiguous_group_count: 0,
      },
    ]);
  });
  it('keeps 2007 semiannual reports and sets aside a fourth-quarter amendment beside them', async () => {
    const mm = report(1, 'MM', 'mid_year', 2007, '2007-08-20', { income: '100000.00' });
    const q4 = report(2, '4A', 'fourth_quarter', 2007, '2008-03-17', { income: '70000.00' });
    const ya = report(3, 'YA', 'year_end', 2007, '2008-10-20', { income: '60000.00' });
    const result = await analyzeFilings([mm, q4, ya]);
    expect(result.selected).toEqual([mm, ya]);
    expect(result.selections.map((x) => [x.period, x.status, x.exclusion_reason])).toEqual([
      ['mid_year', 'selected', undefined],
      ['fourth_quarter', 'excluded', 'off_cycle_period'],
      ['year_end', 'selected', undefined],
    ]);
    expect(result.annual_ledgers).toMatchObject([
      { year: 2007, known_income_usd: '160000.00', matching_filing_count: 2 },
    ]);
  });
  it('counts a 2008 relationship-year that filed only semiannual reports', async () => {
    const mm = report(1, 'MM', 'mid_year', 2008, '2009-04-13', {
      income: null,
      expenses: '160179.00',
    });
    const yy = report(2, 'YY', 'year_end', 2008, '2009-04-15', {
      income: null,
      expenses: '155856.00',
    });
    const result = await analyzeFilings([mm, yy]);
    expect(result.selected).toEqual([mm, yy]);
    expect(result.annual_ledgers[0]).toMatchObject({
      known_expenses_usd: '316035.00',
      expense_filing_count: 2,
      income_filing_count: 0,
      matching_filing_count: 2,
    });
    expect(result.annual_ledgers[0]).not.toHaveProperty('known_income_usd');
  });
  it('counts a 2007 relationship-year that filed only quarterly reports', async () => {
    const q4 = report(1, 'Q4', 'fourth_quarter', 2007, '2008-01-18', { income: '40000.00' });
    const result = await analyzeFilings([q4]);
    expect(result.selected).toEqual([q4]);
    expect(result.annual_ledgers[0]).toMatchObject({
      known_income_usd: '40000.00',
      matching_filing_count: 1,
    });
  });
  it('keeps a 2008 quarterly-only relationship-year as it was', async () => {
    const q = quarters(1, 2008, { income: '25000.00' });
    const result = await analyzeFilings(q);
    expect(result.selected).toEqual(q);
    expect(result.annual_ledgers).toMatchObject([
      { year: 2008, known_income_usd: '100000.00', matching_filing_count: 4 },
    ]);
  });
  it('ledgers each year of a 2004 and 2008 scope at its own grain', async () => {
    const mm = report(1, 'MM', 'mid_year', 2004, '2004-08-17', { income: '240000.00' });
    const yy = report(2, 'YY', 'year_end', 2004, '2005-02-15', { income: '220000.00' });
    const q = quarters(3, 2008, { income: null, expenses: null });
    const amendment = report(7, '2AY', 'second_quarter', 2008, '2009-07-18', {
      income: null,
      expenses: null,
    });
    const result = await analyzeFilings([mm, yy, ...q, amendment]);
    expect(result.selected).toEqual([mm, yy, q[0], amendment, q[2], q[3]]);
    expect(result.selections.filter((x) => x.status !== 'selected')).toEqual([]);
    expect(result.annual_ledgers).toMatchObject([
      { year: 2004, known_income_usd: '460000.00', matching_filing_count: 2 },
      { year: 2008, income_filing_count: 0, missing_amount_count: 4, matching_filing_count: 4 },
    ]);
  });
  it('decides the grain for each registrant, client and year separately', async () => {
    const q1 = report(1, 'Q1', 'first_quarter', 2008, '2008-04-20', { income: '10.00' });
    const otherClient = report(2, 'YY', 'year_end', 2008, '2009-02-14', {
      client: { id: '9001', name: 'Synthetic client' },
      income: '20.00',
    });
    const otherFirm = report(3, 'YY', 'year_end', 2008, '2009-02-14', {
      registrant: { id: '11', name: 'Other firm' },
      income: '30.00',
    });
    const otherYear = report(4, 'YY', 'year_end', 2009, '2010-02-14', { income: '40.00' });
    const result = await analyzeFilings([q1, otherClient, otherFirm, otherYear]);
    expect(result.selected).toEqual([q1, otherClient, otherFirm, otherYear]);
    expect(result.annual_ledgers).toMatchObject([
      { year: 2008, known_income_usd: '60.00', matching_filing_count: 3 },
      { year: 2009, known_income_usd: '40.00', matching_filing_count: 1 },
    ]);
  });
  it('sets aside an off-cycle group before judging ties or type variants', async () => {
    const q1 = report(1, 'Q1', 'first_quarter', 2008, '2008-04-20', { income: '10.00' });
    const tied = report(2, 'YY', 'year_end', 2008, '2009-02-14', { income: '20.00' });
    const tie = report(3, 'YYY', 'year_end', 2008, '2009-02-14');
    const mislabeled = report(4, 'YY', 'mid_year', 2008, '2008-08-14', { income: '30.00' });
    const result = await analyzeFilings([q1, tied, tie, mislabeled]);
    expect(result.selected).toEqual([q1]);
    expect(result.selections).toMatchObject([
      { period: 'first_quarter', status: 'selected' },
      {
        period: 'year_end',
        status: 'excluded',
        exclusion_reason: 'off_cycle_period',
        candidate_filing_uuids: [tied.filing_uuid, tie.filing_uuid],
      },
      {
        period: 'mid_year',
        status: 'excluded',
        exclusion_reason: 'off_cycle_period',
        candidate_filing_uuids: [mislabeled.filing_uuid],
      },
    ]);
    expect(result.annual_ledgers).toMatchObject([
      { year: 2008, known_income_usd: '10.00', matching_filing_count: 1, ambiguous_group_count: 0 },
    ]);
  });
  it('keeps a zero ledger for each acquired year that selects nothing', async () => {
    const versions = await analyzeFilings([
      report(1, 'RR', 'first_quarter', 2023, '2023-01-20'),
      report(2, 'Q1', 'first_quarter', 2024, '2024-04-20', { income: '10.00' }),
    ]);
    expect(versions.annual_ledgers.map((x) => [x.year, x.matching_filing_count])).toEqual([
      [2023, 0],
      [2024, 1],
    ]);
    const issue = await analyzeFilings(
      [
        report(1, 'Q1', 'first_quarter', 2023, '2023-04-20', {
          lobbying_activities: [{ general_issue_code: 'TEC' }],
        }),
        report(2, 'Q1', 'first_quarter', 2024, '2024-04-20', {
          lobbying_activities: [{ general_issue_code: 'HCR' }],
        }),
      ],
      { issue_code: 'HCR' },
    );
    expect(issue.annual_ledgers.map((x) => [x.year, x.matching_filing_count])).toEqual([
      [2023, 0],
      [2024, 1],
    ]);
  });
});

describe('client relationship breakdown', () => {
  const firm = { id: '10', name: 'Synthetic firm' };
  const hcr = [{ general_issue_code: 'HCR' }];
  const gammaQ1 = report(1, 'Q1', 'first_quarter', 2024, '2024-04-20', {
    registrant: { id: '11', name: 'Other firm' },
    client: { id: '3', name: 'Gamma' },
    income: null,
    expenses: '10.00',
    expenses_method: 'A',
    lobbying_activities: hcr,
  });
  const alpha = { id: '1', client_id: '77', name: 'Alpha' };
  const alpha2023 = report(2, 'Q1', 'first_quarter', 2023, '2023-04-20', {
    registrant: firm,
    client: alpha,
    income: '100.00',
    lobbying_activities: [{ general_issue_code: 'TEC' }],
  });
  const betaQ1 = report(3, 'Q1Y', 'first_quarter', 2024, '2024-04-20', {
    registrant: firm,
    client: { id: '2', client_id: '77', name: 'Beta' },
    income: null,
    expenses: null,
  });
  const alphaQ1 = report(4, 'Q1', 'first_quarter', 2024, '2024-04-21', {
    registrant: firm,
    client: alpha,
    income: '200.00',
    lobbying_activities: [{ general_issue_code: 'HCR' }, { general_issue_code: 'TEC' }],
  });
  const alphaQ2 = report(5, 'Q2', 'second_quarter', 2024, '2024-07-20', {
    registrant: firm,
    client: alpha,
    income: '50.00',
    lobbying_activities: hcr,
  });
  const alpha2A = report(6, '2A', 'second_quarter', 2024, '2024-08-01', {
    registrant: firm,
    client: alpha,
    income: '60.00',
    lobbying_activities: hcr,
  });
  const orphan = report(7, 'Q3', 'third_quarter', 2024, '2024-10-20', {
    client: null,
    income: '999.00',
    lobbying_activities: hcr,
  });
  const registration = report(8, 'RR', 'first_quarter', 2024, '2024-01-02', {
    registrant: firm,
    client: alpha,
  });
  const filings = [gammaQ1, alpha2023, betaQ1, alphaQ1, alphaQ2, alpha2A, orphan, registration];
  const zeroLedger = (year: number) => ({
    year,
    income_filing_count: 0,
    expense_filing_count: 0,
    missing_amount_count: 0,
    missing_income_count: 0,
    missing_expense_count: 0,
    ambiguous_group_count: 0,
    matching_filing_count: 0,
    multi_issue_filing_count: 0,
    expense_methods: [],
  });

  it('orders firms by first appearance with a ledger for every year in scope', async () => {
    const result = await analyzeFilings(filings);
    expect(result.firms.map(({ annual_ledgers, ...row }) => row)).toEqual([
      {
        registrant_id: '11',
        name: 'Other firm',
        client_ids: ['3'],
        filing_uuids: [gammaQ1.filing_uuid],
      },
      {
        registrant_id: '10',
        name: 'Synthetic firm',
        client_ids: ['1', '2'],
        filing_uuids: [alpha2023, betaQ1, alphaQ1, alpha2A].map((x) => x.filing_uuid),
      },
    ]);
    expect(result.firms[0]?.annual_ledgers[0]).toEqual(zeroLedger(2023));
  });
  it('ledgers every selected filing when no issue code is given', async () => {
    const result = await analyzeFilings(filings);
    const unfiltered = await analyzeFilings(filings, {});
    expect(unfiltered.selected).toEqual(result.selected);
    expect(unfiltered.annual_ledgers).toEqual(result.annual_ledgers);
    expect(result.selected).toEqual([gammaQ1, alpha2023, betaQ1, alphaQ1, alpha2A]);
    expect(result.annual_ledgers.map((x) => [x.year, x.matching_filing_count])).toEqual([
      [2023, 1],
      [2024, 4],
    ]);
    expect(result.issue_codes.map((x) => [x.issue_code, x.filing_uuids.length])).toEqual([
      ['HCR', 3],
      ['TEC', 2],
    ]);
  });
  it('breaks selected filings out per relationship record in the order firms use', async () => {
    const result = await analyzeFilings(filings);
    expect(result.clients.map(({ annual_ledgers, ...row }) => row)).toEqual([
      { client_id: '3', name: 'Gamma', registrant_id: '11', filing_uuids: [gammaQ1.filing_uuid] },
      {
        client_id: '1',
        name: 'Alpha',
        registrant_id: '10',
        filing_uuids: [alpha2023, alphaQ1, alpha2A].map((x) => x.filing_uuid),
      },
      { client_id: '2', name: 'Beta', registrant_id: '10', filing_uuids: [betaQ1.filing_uuid] },
    ]);
    expect(result.clients[0]?.annual_ledgers[0]).toEqual(zeroLedger(2023));
    expect(result.clients[1]?.annual_ledgers).toMatchObject([
      { year: 2023, known_income_usd: '100.00', matching_filing_count: 1 },
      {
        year: 2024,
        known_income_usd: '260.00',
        matching_filing_count: 2,
        multi_issue_filing_count: 1,
      },
    ]);
  });
  it.each([
    {
      predicates: {},
      clients: ['3', '1', '2'],
      ledgers: [
        [2023, 1],
        [2024, 4],
      ],
    },
    {
      predicates: { issue_code: 'HCR' },
      clients: ['3', '1'],
      ledgers: [
        [2023, 0],
        [2024, 3],
      ],
    },
  ])(
    'puts each selected filing in one client row, summing to the annual ledger ($predicates)',
    async ({ predicates, clients, ledgers }) => {
      const result = await analyzeFilings(filings, predicates);
      expect(result.clients.map((x) => x.client_id)).toEqual(clients);
      expect(result.annual_ledgers.map((x) => [x.year, x.matching_filing_count])).toEqual(ledgers);
      expect(result.annual_ledgers.at(-1)).toMatchObject({
        known_income_usd: '260.00',
        known_expenses_usd: '10.00',
      });
      const memberships = result.clients.flatMap((x) => x.filing_uuids);
      expect(memberships).toHaveLength(new Set(memberships).size);
      expect(memberships.toSorted()).toEqual(result.selected.map((x) => x.filing_uuid).toSorted());
      expect(memberships).not.toContain(orphan.filing_uuid);
      const cents = (rows: AnnualLedger[], key: 'known_income_usd' | 'known_expenses_usd') =>
        rows.reduce((sum, row) => {
          const amount = row[key];
          return amount === undefined ? sum : sum + moneyToCents(amount);
        }, 0n);
      for (const annual of result.annual_ledgers) {
        const parts = result.clients.flatMap((x) =>
          x.annual_ledgers.filter((ledger) => ledger.year === annual.year),
        );
        expect(parts).toHaveLength(result.clients.length);
        for (const key of [
          'matching_filing_count',
          'income_filing_count',
          'expense_filing_count',
          'missing_amount_count',
          'missing_income_count',
          'missing_expense_count',
          'multi_issue_filing_count',
        ] as const)
          expect(
            parts.reduce((sum, ledger) => sum + ledger[key], 0),
            `${annual.year} ${key}`,
          ).toBe(annual[key]);
        expect(cents(parts, 'known_income_usd')).toBe(cents([annual], 'known_income_usd'));
        expect(cents(parts, 'known_expenses_usd')).toBe(cents([annual], 'known_expenses_usd'));
      }
    },
  );
  it('returns no client rows for an empty acquisition', async () => {
    const result = await analyzeFilings([]);
    expect(result.clients).toEqual([]);
    expect(result.annual_ledgers).toEqual([]);
  });
  it('names relationship records as the client identity', async () => {
    expect((await analyzeFilings(filings)).methodology).toEqual({
      selection_method: 'latest_posted_within_relationship_period',
      attribution_basis: 'whole_filing_mentions_issue',
      issue_buckets_overlap: true,
      amounts_are_separate: true,
      client_identity: 'relationship_records',
    });
  });
});

describe('exact independent ledgers', () => {
  it('keeps absent versus zero, large cents, expense methods and income separate', async () => {
    const result = await analyzeFilings([
      filing(1, { income: '9007199254740993.01', expenses: '0', expenses_method: 'A' }),
      filing(2, { income: '0.09', expenses: '12.34', expenses_method: 'B' }),
      filing(3, { income: null, expenses: null, expenses_method: 'A' }),
      filing(4),
    ]);
    expect(result.annual_ledgers[0]).toEqual({
      year: 2024,
      known_income_usd: '9007199254740993.10',
      known_expenses_usd: '12.34',
      income_filing_count: 2,
      expense_filing_count: 2,
      missing_amount_count: 2,
      missing_income_count: 2,
      missing_expense_count: 2,
      ambiguous_group_count: 0,
      matching_filing_count: 4,
      multi_issue_filing_count: 0,
      expense_methods: [
        {
          method: 'A',
          known_expenses_usd: '0.00',
          expense_filing_count: 1,
          missing_expense_count: 1,
        },
        {
          method: 'B',
          known_expenses_usd: '12.34',
          expense_filing_count: 1,
          missing_expense_count: 0,
        },
        { method: null, expense_filing_count: 0, missing_expense_count: 1 },
      ],
    });
    expect(moneyToCents('-0.01')).toBe(-1n);
    expect(centsToMoney(-100000000000000001n)).toBe('-1000000000000000.01');
    expect(() => moneyToCents('1.001')).toThrow();
  });
  it('counts duplicate issue activities once and keeps same-name relationships distinct', async () => {
    const a = filing(1, {
      income: '10.00',
      lobbying_activities: [
        { general_issue_code: 'TEC' },
        { general_issue_code: 'TEC' },
        { general_issue_code: 'SCI' },
      ],
    });
    const b = filing(2, { registrant: { id: '11', name: 'Other firm' }, income: '20.00' });
    const result = await analyzeFilings([a, b]);
    expect(result.selected).toHaveLength(2);
    expect(result.firms.map((x) => x.client_ids)).toEqual([['1'], ['2']]);
    expect(result.issue_codes[0]).toMatchObject({
      issue_code: 'TEC',
      filing_uuids: [a.filing_uuid],
      annual_ledgers: [
        { known_income_usd: '10.00', matching_filing_count: 1, multi_issue_filing_count: 1 },
      ],
    });
    expect([...result.activities]).toHaveLength(3);
    expect([...result.activities][0]).not.toHaveProperty('income');
  });
});

describe('child evidence membership', () => {
  it('requires contribution predicates on the same child and preserves full repeated lists', () => {
    const report = ContributionReportSchema.parse({
      ...filing(1),
      filing_type: 'MM',
      filing_period: 'mid_year',
      pacs: [{ name: 'Synthetic PAC' }],
      no_contributions: null,
      contribution_items: [
        { contributor_name: 'Alpha', payee_name: 'Other', date: null },
        { contributor_name: 'Beta', payee_name: 'Target', date: '2024-02-01' },
        { contributor_name: 'Alpha', payee_name: 'Target', date: '2024-02-01' },
        { contributor_name: 'Alpha', payee_name: 'Target', date: '2024-02-01' },
      ],
    });
    expect(
      matchContributionItems(report, {
        contributor: 'alpha',
        payee: 'TARGET',
        contribution_date_after: '2024-02-01',
        contribution_date_before: '2024-02-01',
      }),
    ).toEqual([2, 3]);
    expect(
      filterContributionReports([report, report], { contributor: 'Alpha', payee: 'Target' })[0],
    ).toMatchObject({
      contribution_items: report.contribution_items,
      matched_item_indexes: [2, 3],
      no_contributions: null,
      pacs: report.pacs,
    });
    expect(
      filterContributionReports(
        [
          ContributionReportSchema.parse({
            ...report,
            contribution_items: report.contribution_items.slice(0, 2),
          }),
        ],
        { contributor: 'Alpha', payee: 'Target' },
      ),
    ).toEqual([]);
    expect(
      filterContributionReports([
        ContributionReportSchema.parse({
          ...report,
          contribution_items: [],
          no_contributions: true,
        }),
      ]),
    ).toHaveLength(1);
    expect(
      filterContributionReports(
        [ContributionReportSchema.parse({ ...report, contribution_items: [] })],
        { payee: 'Target' },
      ),
    ).toEqual([]);
  });
  it('uses covered positions only for the requested identity within each activity', () => {
    const record = filing(1, {
      lobbying_activities: [
        {
          general_issue_code: 'TEC',
          lobbyists: [
            { lobbyist: { id: '1' }, covered_position: '  ' },
            { lobbyist: { id: '2' }, covered_position: 'Synthetic office' },
          ],
        },
        {
          general_issue_code: 'SCI',
          lobbyists: [{ lobbyist: { id: '1' }, covered_position: 'Synthetic staff' }],
        },
      ],
    });
    expect(lobbyistEvidence([record, record], '1', true)).toMatchObject([
      {
        activity_index: 1,
        lobbyist_index: 0,
        covered_position: 'Synthetic staff',
        lobbyist: { id: '1' },
      },
    ]);
    expect(lobbyistEvidence([record], '1')).toHaveLength(2);
  });
});
