/** @fileoverview Pure relationship-period selection and exact disclosure accounting. @module services/lobbying/analysis */
import type { z } from '@cyanheads/mcp-ts-core';
import type { ContributionReport, Filing, GovernmentEntitySchema } from '@/domain/lda.js';
import { ActivityRowSchema, ContributionReportSchema, MoneySchema } from '@/domain/lda.js';

type GovernmentEntity = z.infer<typeof GovernmentEntitySchema>;

const METHOD = 'latest_posted_within_relationship_period' as const;
const PERIODS = ['first_quarter', 'second_quarter', 'third_quarter', 'fourth_quarter'];
/** Selected records always have explicit relationship identities. */
export type SelectedFiling = Filing & {
  client: NonNullable<Filing['client']>;
  registrant: NonNullable<Filing['registrant']>;
};
function hasRelationship(filing: Filing): filing is SelectedFiling {
  return filing.client != null && filing.registrant != null;
}
/** An auditable decision holds identifiers only; source records remain in acquired/selected tables. */
export interface FilingSelection {
  candidate_filing_uuids: string[];
  client_id: string | null;
  exclusion_reason?: 'registration' | 'non_quarterly' | 'unknown_variant' | 'missing_relationship';
  period: string;
  registrant_id: string | null;
  selected_filing_uuid?: string;
  selection_method: typeof METHOD;
  status: 'selected' | 'ambiguous' | 'excluded';
  superseded_filing_uuids: string[];
  year: number;
}
/** Exact integer cents, accepting only the declared decimal source grammar. */
export function moneyToCents(amount: string): bigint {
  const parsed = MoneySchema.parse(amount);
  if (parsed === null) throw new Error('A concrete amount is required.');
  const negative = parsed.startsWith('-');
  const unsigned = negative ? parsed.slice(1) : parsed;
  const point = unsigned.indexOf('.');
  const whole = point === -1 ? unsigned : unsigned.slice(0, point);
  const fraction = point === -1 ? '' : unsigned.slice(point + 1);
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}
/** Canonical USD decimal serialization without floating-point conversion. */
export function centsToMoney(cents: bigint): string {
  const absolute = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
function knownQuarterly(filing: Filing): boolean {
  const index = PERIODS.indexOf(filing.filing_period) + 1;
  return index > 0 && new RegExp(`^(?:Q${index}|${index}[TA@])Y?$`).test(filing.filing_type);
}
/** Select latest postings before applying any issue, text, or monetary predicates. */
export async function selectQuarterlyFilings(
  filings: Iterable<Filing> | AsyncIterable<Filing>,
): Promise<{
  selected: SelectedFiling[];
  selections: FilingSelection[];
}> {
  const groups = new Map<
    string,
    {
      latest: number;
      candidates: [
        { filing: SelectedFiling; order: number },
        ...{ filing: SelectedFiling; order: number }[],
      ];
      superseded: { uuid: string; order: number }[];
    }
  >();
  const seen = new Set<string>();
  const selections: FilingSelection[] = [];
  let order = 0;
  for await (const filing of filings) {
    if (seen.has(filing.filing_uuid)) continue;
    seen.add(filing.filing_uuid);
    const base = {
      registrant_id: filing.registrant?.id ?? null,
      client_id: filing.client?.id ?? null,
      year: filing.filing_year,
      period: filing.filing_period,
      selection_method: METHOD,
    };
    const excluded = {
      ...base,
      status: 'excluded' as const,
      candidate_filing_uuids: [filing.filing_uuid],
      superseded_filing_uuids: [],
    };
    const reason = ['RR', 'RA'].includes(filing.filing_type)
      ? 'registration'
      : !PERIODS.includes(filing.filing_period)
        ? 'non_quarterly'
        : undefined;
    if (reason) {
      selections.push({ ...excluded, exclusion_reason: reason });
      continue;
    }
    if (!hasRelationship(filing)) {
      selections.push({ ...excluded, exclusion_reason: 'missing_relationship' });
      continue;
    }
    const key = JSON.stringify([base.registrant_id, base.client_id, base.year, base.period]);
    const group = groups.get(key);
    const posted = Date.parse(filing.dt_posted);
    const index = order++;
    if (!group)
      groups.set(key, { latest: posted, candidates: [{ filing, order: index }], superseded: [] });
    else if (posted > group.latest) {
      for (const candidate of group.candidates)
        group.superseded.push({ uuid: candidate.filing.filing_uuid, order: candidate.order });
      group.latest = posted;
      group.candidates = [{ filing, order: index }];
    } else if (posted === group.latest) {
      group.candidates.push({ filing, order: index });
    } else group.superseded.push({ uuid: filing.filing_uuid, order: index });
  }
  const selected: SelectedFiling[] = [];
  for (const { candidates, superseded } of groups.values()) {
    const first = candidates[0].filing;
    const base = {
      registrant_id: first.registrant.id,
      client_id: first.client.id,
      year: first.filing_year,
      period: first.filing_period,
      selection_method: METHOD,
      candidate_filing_uuids: candidates.map(({ filing }) => filing.filing_uuid),
      superseded_filing_uuids: superseded
        .sort((a, b) => a.order - b.order)
        .map((item) => item.uuid),
    };
    if (candidates.length > 1) selections.push({ ...base, status: 'ambiguous' });
    else if (!knownQuarterly(first))
      selections.push({ ...base, status: 'excluded', exclusion_reason: 'unknown_variant' });
    else {
      selected.push(first);
      selections.push({ ...base, status: 'selected', selected_filing_uuid: first.filing_uuid });
    }
  }
  return { selected, selections };
}
/** Local predicates run on the selected version, never on superseded originals. */
export interface FilingPredicates {
  expenses_max?: string;
  expenses_min?: string;
  income_max?: string;
  income_min?: string;
  issue_code?: string;
  specific_issues?: string;
}
/** Literal, case-insensitive text matching without regex interpretation. */
export function includesLiteral(value: string | null | undefined, query: string): boolean {
  return value?.toLowerCase().includes(query.toLowerCase()) === true;
}
/** Whether one complete selected filing satisfies every local predicate. */
export function matchesFiling(filing: Filing, predicates: FilingPredicates): boolean {
  const activities = filing.lobbying_activities ?? [];
  if (
    predicates.issue_code &&
    !activities.some((activity) => activity.general_issue_code === predicates.issue_code)
  )
    return false;
  const specificIssues = predicates.specific_issues;
  if (
    specificIssues &&
    !activities.some((activity) => includesLiteral(activity.description, specificIssues))
  )
    return false;
  for (const field of ['income', 'expenses'] as const) {
    const minimum = predicates[`${field}_min`];
    const maximum = predicates[`${field}_max`];
    if (minimum === undefined && maximum === undefined) continue;
    const amount = filing[field];
    if (amount == null) return false;
    const cents = moneyToCents(amount);
    if (
      (minimum !== undefined && cents < moneyToCents(minimum)) ||
      (maximum !== undefined && cents > moneyToCents(maximum))
    )
      return false;
  }
  return true;
}
/** Known sums are absent when no source amount is known; income and expenses never combine. */
export interface AnnualLedger {
  ambiguous_group_count: number;
  expense_filing_count: number;
  expense_methods: {
    method: string | null;
    known_expenses_usd?: string;
    expense_filing_count: number;
    missing_expense_count: number;
  }[];
  income_filing_count: number;
  known_expenses_usd?: string;
  known_income_usd?: string;
  matching_filing_count: number;
  missing_amount_count: number;
  missing_expense_count: number;
  missing_income_count: number;
  multi_issue_filing_count: number;
  year: number;
}
function ledger(year: number, filings: readonly Filing[], ambiguous: number): AnnualLedger {
  let income = 0n;
  let expenses = 0n;
  let incomeCount = 0;
  let expenseCount = 0;
  const methods = new Map<string | null, { sum: bigint; known: number; missing: number }>();
  for (const filing of filings) {
    if (filing.income != null) {
      income += moneyToCents(filing.income);
      incomeCount++;
    }
    const method = filing.expenses_method ?? null;
    const entry = methods.get(method) ?? { sum: 0n, known: 0, missing: 0 };
    if (filing.expenses != null) {
      const cents = moneyToCents(filing.expenses);
      expenses += cents;
      expenseCount++;
      entry.sum += cents;
      entry.known++;
    } else entry.missing++;
    methods.set(method, entry);
  }
  return {
    year,
    ...(incomeCount ? { known_income_usd: centsToMoney(income) } : {}),
    ...(expenseCount ? { known_expenses_usd: centsToMoney(expenses) } : {}),
    income_filing_count: incomeCount,
    expense_filing_count: expenseCount,
    missing_amount_count: filings.filter(
      (filing) => filing.income == null && filing.expenses == null,
    ).length,
    missing_income_count: filings.length - incomeCount,
    missing_expense_count: filings.length - expenseCount,
    ambiguous_group_count: ambiguous,
    matching_filing_count: filings.length,
    multi_issue_filing_count: filings.filter(
      (filing) =>
        new Set(filing.lobbying_activities?.map((activity) => activity.general_issue_code)).size >
        1,
    ).length,
    expense_methods: [...methods].map(([method, entry]) => ({
      method,
      ...(entry.known ? { known_expenses_usd: centsToMoney(entry.sum) } : {}),
      expense_filing_count: entry.known,
      missing_expense_count: entry.missing,
    })),
  };
}
/** Complete final analysis over an already exhausted source acquisition. Caller controls scope. */
export async function analyzeFilings(
  filings: Iterable<Filing> | AsyncIterable<Filing>,
  predicates: FilingPredicates = {},
) {
  const selection = await selectQuarterlyFilings(filings);
  const selected = selection.selected.filter((filing) => matchesFiling(filing, predicates));
  const years = [...new Set(selection.selections.map((item) => item.year))].sort((a, b) => a - b);
  const breakdownLedgers = (records: readonly Filing[]) =>
    years.map((year) =>
      ledger(
        year,
        records.filter((filing) => filing.filing_year === year),
        0,
      ),
    );
  const annual_ledgers = years.map((year) =>
    ledger(
      year,
      selected.filter((filing) => filing.filing_year === year),
      selection.selections.filter((item) => item.year === year && item.status === 'ambiguous')
        .length,
    ),
  );
  const firms = new Map<
    string,
    { registrant_id: string; name: string; client_ids: Set<string>; filings: Filing[] }
  >();
  const issues = new Map<string, Filing[]>();
  const entities = new Map<string, { entity: GovernmentEntity; filing_uuids: Set<string> }>();
  for (const filing of selected) {
    const firm = firms.get(filing.registrant.id) ?? {
      registrant_id: filing.registrant.id,
      name: filing.registrant.name,
      client_ids: new Set<string>(),
      filings: [],
    };
    firm.client_ids.add(filing.client.id);
    firm.filings.push(filing);
    firms.set(firm.registrant_id, firm);
    for (const code of new Set(
      filing.lobbying_activities?.map((activity) => activity.general_issue_code),
    )) {
      const bucket = issues.get(code);
      if (bucket) bucket.push(filing);
      else issues.set(code, [filing]);
    }
    for (const activity of filing.lobbying_activities ?? []) {
      for (const entity of activity.government_entities ?? []) {
        const key = JSON.stringify(Object.entries(entity).sort(([a], [b]) => a.localeCompare(b)));
        const bucket = entities.get(key) ?? { entity, filing_uuids: new Set<string>() };
        bucket.filing_uuids.add(filing.filing_uuid);
        entities.set(key, bucket);
      }
    }
  }
  return {
    selected,
    selections: selection.selections,
    annual_ledgers,
    firms: [...firms.values()].map((firm) => ({
      registrant_id: firm.registrant_id,
      name: firm.name,
      client_ids: [...firm.client_ids],
      filing_uuids: firm.filings.map((filing) => filing.filing_uuid),
      annual_ledgers: breakdownLedgers(firm.filings),
    })),
    issue_codes: [...issues].map(([issue_code, records]) => ({
      issue_code,
      filing_uuids: records.map((filing) => filing.filing_uuid),
      annual_ledgers: breakdownLedgers(records),
    })),
    targeted_entities: [...entities.values()].map((value) => ({
      entity: value.entity,
      filing_uuids: [...value.filing_uuids],
    })),
    activities: {
      *[Symbol.iterator]() {
        for (const filing of selected)
          for (const [activity_index, activity] of (filing.lobbying_activities ?? []).entries())
            yield ActivityRowSchema.parse({
              filing_uuid: filing.filing_uuid,
              activity_index,
              registrant_id: filing.registrant.id,
              client_id: filing.client.id,
              ...activity,
            });
      },
    },
    methodology: {
      selection_method: METHOD,
      attribution_basis: 'whole_filing_mentions_issue' as const,
      issue_buckets_overlap: true,
      amounts_are_separate: true,
      client_identity: 'caller_selected_relationships' as const,
    },
  };
}
/** All child predicates must match one child; parent reports and repeated child rows stay whole. */
export interface ContributionPredicates {
  amount_max?: string;
  amount_min?: string;
  contribution_date_after?: string;
  contribution_date_before?: string;
  contribution_type?: string;
  contributor?: string;
  honoree?: string;
  payee?: string;
}
/** Return original child indexes satisfying all predicates; an empty unfiltered parent stays eligible. */
export function matchContributionItems(
  report: ContributionReport,
  predicates: ContributionPredicates = {},
): number[] {
  const minimum =
    predicates.amount_min === undefined ? undefined : moneyToCents(predicates.amount_min);
  const maximum =
    predicates.amount_max === undefined ? undefined : moneyToCents(predicates.amount_max);
  return report.contribution_items.flatMap((item, index) => {
    if (minimum !== undefined || maximum !== undefined) {
      if (item.amount == null) return [];
      const amount = moneyToCents(item.amount);
      if (
        (minimum !== undefined && amount < minimum) ||
        (maximum !== undefined && amount > maximum)
      )
        return [];
    }
    if (predicates.contribution_type && item.contribution_type !== predicates.contribution_type)
      return [];
    for (const [key, value] of [
      ['contributor_name', predicates.contributor],
      ['payee_name', predicates.payee],
      ['honoree_name', predicates.honoree],
    ] as const)
      if (value && !includesLiteral(item[key], value)) return [];
    if (
      predicates.contribution_date_after &&
      (item.date == null || item.date < predicates.contribution_date_after)
    )
      return [];
    if (
      predicates.contribution_date_before &&
      (item.date == null || item.date > predicates.contribution_date_before)
    )
      return [];
    return [index];
  });
}
/** Filter parent reports only after computing same-child membership; never filter their child arrays. */
export function filterContributionReports(
  reports: Iterable<ContributionReport>,
  predicates: ContributionPredicates = {},
): ContributionReport[] {
  const seen = new Set<string>();
  const output: ContributionReport[] = [];
  const filtered = Object.values(predicates).some((value) => value !== undefined && value !== '');
  for (const report of reports) {
    if (seen.has(report.filing_uuid)) continue;
    seen.add(report.filing_uuid);
    const matched_item_indexes = matchContributionItems(report, predicates);
    if (!filtered || matched_item_indexes.length)
      output.push(ContributionReportSchema.parse({ ...report, matched_item_indexes }));
  }
  return output;
}
/** Filing-scoped evidence always checks the requested lobbyist locally. */
export function lobbyistEvidence(
  filings: Iterable<Filing>,
  lobbyistId: string,
  coveredPositionsOnly = false,
) {
  const evidence = [];
  const seen = new Set<string>();
  for (const filing of filings) {
    if (seen.has(filing.filing_uuid)) continue;
    seen.add(filing.filing_uuid);
    for (const [activity_index, activity] of (filing.lobbying_activities ?? []).entries())
      for (const [lobbyist_index, participant] of (activity.lobbyists ?? []).entries()) {
        if (
          participant.lobbyist.id !== lobbyistId ||
          (coveredPositionsOnly && !participant.covered_position?.trim())
        )
          continue;
        evidence.push({
          filing_uuid: filing.filing_uuid,
          filing_year: filing.filing_year,
          filing_period: filing.filing_period,
          filing_type: filing.filing_type,
          dt_posted: filing.dt_posted,
          ...(filing.filing_document_url !== undefined
            ? { filing_document_url: filing.filing_document_url }
            : {}),
          registrant_id: filing.registrant?.id ?? null,
          client_id: filing.client?.id ?? null,
          activity_index,
          lobbyist_index,
          general_issue_code: activity.general_issue_code,
          activity,
          ...participant,
        });
      }
  }
  return evidence;
}
