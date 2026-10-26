/** @fileoverview Explicit lossless disclosure table schemas and streaming projections. @module services/canvas/table-rows */
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import type { ActivityRow, Filing } from '@/domain/lda.js';
/** Replayable acquisition chunks or already computed source rows are accepted without buffering. */
export type RowSource<T> = Iterable<T> | AsyncIterable<T>;
/** Per-version accounting decision, independent of local issue membership. */
export interface FilingAudit {
  ambiguous: boolean;
  selected_filing_uuid: string | null;
  selection_status: 'selected' | 'superseded' | 'ambiguous' | 'excluded';
}

/** Decimal money stays nullable VARCHAR; explicit casts are the SQL caller's choice. */
export const filingColumns: ColumnSchema[] = [
  { name: 'filing_uuid', type: 'VARCHAR', nullable: false },
  { name: 'filing_type', type: 'VARCHAR', nullable: false },
  { name: 'filing_year', type: 'INTEGER', nullable: false },
  { name: 'filing_period', type: 'VARCHAR', nullable: false },
  { name: 'dt_posted', type: 'VARCHAR', nullable: false },
  { name: 'filing_document_url', type: 'VARCHAR', nullable: true },
  { name: 'filing_document_content_type', type: 'VARCHAR', nullable: true },
  { name: 'registrant_id', type: 'VARCHAR', nullable: true },
  { name: 'client_id', type: 'VARCHAR', nullable: true },
  { name: 'income_usd', type: 'VARCHAR', nullable: true },
  { name: 'expenses_usd', type: 'VARCHAR', nullable: true },
  { name: 'selection_status', type: 'VARCHAR', nullable: false },
  { name: 'selected_filing_uuid', type: 'VARCHAR', nullable: true },
  { name: 'issue_count', type: 'INTEGER', nullable: false },
  { name: 'ambiguous', type: 'BOOLEAN', nullable: false },
  { name: 'expenses_method', type: 'VARCHAR', nullable: true },
  { name: 'registrant', type: 'JSON', nullable: true },
  { name: 'client', type: 'JSON', nullable: true },
  { name: 'lobbying_activities', type: 'JSON', nullable: true },
  { name: 'conviction_disclosures', type: 'JSON', nullable: true },
  { name: 'foreign_entities', type: 'JSON', nullable: true },
  { name: 'affiliated_organizations', type: 'JSON', nullable: true },
  { name: 'source_fields', type: 'JSON', nullable: false },
];

/** Activity rows deliberately contain no filing-level monetary columns. */
export const activityColumns: ColumnSchema[] = [
  { name: 'filing_uuid', type: 'VARCHAR', nullable: false },
  { name: 'activity_index', type: 'INTEGER', nullable: false },
  { name: 'registrant_id', type: 'VARCHAR', nullable: false },
  { name: 'client_id', type: 'VARCHAR', nullable: false },
  { name: 'general_issue_code', type: 'VARCHAR', nullable: false },
  { name: 'description', type: 'VARCHAR', nullable: true },
  { name: 'foreign_entity_issues', type: 'VARCHAR', nullable: true },
  { name: 'lobbyists', type: 'JSON', nullable: true },
  { name: 'government_entities', type: 'JSON', nullable: true },
  { name: 'source_fields', type: 'JSON', nullable: false },
];

function project(
  row: Record<string, unknown>,
  columns: ColumnSchema[],
  derived: Record<string, unknown> = {},
): Record<string, unknown> {
  const declared = new Set(columns.map((column) => column.name));
  const result: Record<string, unknown> = Object.create(null);
  const extra: Record<string, unknown> = Object.create(null);
  for (const column of columns)
    if (column.name !== 'source_fields')
      result[column.name] =
        (Object.hasOwn(derived, column.name) ? derived[column.name] : row[column.name]) ?? null;
  for (const [key, value] of Object.entries(row)) if (!declared.has(key)) extra[key] = value;
  // Retain a source field literally named source_fields rather than overwriting it.
  if (Object.hasOwn(row, 'source_fields')) extra.source_fields = row.source_fields;
  for (const name of Object.keys(derived)) if (Object.hasOwn(row, name)) extra[name] = row[name];
  result.source_fields = extra;
  return result;
}

/** Stream one filing at a time, keeping all unknown source fields exactly once. */
export async function* filingRows(
  rows: RowSource<Filing>,
  decisions: ReadonlyMap<string, FilingAudit>,
  signal: AbortSignal,
) {
  for await (const filing of rows) {
    signal.throwIfAborted();
    const decision = decisions.get(filing.filing_uuid);
    if (!decision) throw new Error('Every staged filing requires a version-selection decision.');
    const { income, expenses, ...source } = filing;
    yield project(source, filingColumns, {
      ...decision,
      income_usd: income ?? null,
      expenses_usd: expenses ?? null,
      issue_count: new Set(
        (filing.lobbying_activities ?? []).map((activity) => activity.general_issue_code),
      ).size,
      registrant_id: filing.registrant?.id ?? null,
      client_id: filing.client?.id ?? null,
    });
  }
}

/** Stream child rows with their parent UUID and original array index. */
export async function* activityRows(rows: RowSource<ActivityRow>, signal: AbortSignal) {
  for await (const activity of rows) {
    signal.throwIfAborted();
    yield project(activity, activityColumns);
  }
}
