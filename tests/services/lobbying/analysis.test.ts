/** @fileoverview Independent disclosure selection and accounting examples. @module tests/services/lobbying/analysis */
import { describe, expect, it } from 'vitest';
import { ContributionReportSchema, type Filing, FilingSchema } from '../../../src/domain/lda.js';
import {
  analyzeFilings,
  centsToMoney,
  filterContributionReports,
  lobbyistEvidence,
  matchContributionItems,
  moneyToCents,
  selectQuarterlyFilings,
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

describe('quarterly selection', () => {
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
          ? await selectQuarterlyFilings(chunks())
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
      (await selectQuarterlyFilings([filing(1, { filing_period: period, filing_type: type })]))
        .selected,
    ).toHaveLength(1);
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
  it('excludes registrations, semiannual, unknown latest variants and missing identities', async () => {
    const result = await selectQuarterlyFilings([
      filing(1, { filing_type: 'RR' }),
      filing(2, { filing_type: 'RA' }),
      filing(3, { filing_type: 'MM', filing_period: 'mid_year' }),
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
