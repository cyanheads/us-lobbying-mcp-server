/** @fileoverview Typed analytical rows and complete-scope finalization. @module mcp-server/tools/definitions/lda/analytics */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { CoverageSchema, DatasetSchema } from '@/domain/contracts.js';
import { type JsonValue, JsonValueSchema } from '@/domain/json.js';
import { ActivityRowSchema, FilingSchema, GovernmentEntitySchema } from '@/domain/lda.js';
import { acquire } from '@/services/acquisition/acquisition-service.js';
import { getCanvas, stageFilings } from '@/services/canvas/canvas-service.js';
import { analyzeFilings } from '@/services/lobbying/analysis.js';
import { deliveryShape, envelope, provenance, source } from './shared.js';

const RowSetCounts = z
  .object({
    annual_ledgers: z.number().int().nonnegative().describe('Annual ledger records.'),
    selections: z.number().int().nonnegative().describe('Version-selection decisions.'),
    firms: z.number().int().nonnegative().describe('Firm breakdown records.'),
    issue_codes: z.number().int().nonnegative().describe('Issue breakdown records.'),
    targeted_entities: z.number().int().nonnegative().describe('Targeted entity records.'),
    selected_filings: z.number().int().nonnegative().describe('Selected filing records.'),
    activities: z.number().int().nonnegative().describe('Selected activity records.'),
    raw_filings: z.number().int().nonnegative().describe('Acquired filing versions.'),
  })
  .describe('Record counts for each analytical set.');

const Ledger = z
  .object({
    year: z.number().int().describe('Report year.'),
    known_income_usd: z
      .string()
      .optional()
      .describe('Exact known-income sum; absent if none known.'),
    known_expenses_usd: z
      .string()
      .optional()
      .describe('Exact known-expense sum; never added to income.'),
    income_filing_count: z.number().int().describe('Filings with known income.'),
    expense_filing_count: z.number().int().describe('Filings with known expenses.'),
    missing_amount_count: z.number().int().describe('Filings with neither amount known.'),
    missing_income_count: z.number().int().describe('Filings missing income.'),
    missing_expense_count: z.number().int().describe('Filings missing expenses.'),
    ambiguous_group_count: z.number().int().describe('Equal-latest groups excluded from sums.'),
    matching_filing_count: z.number().int().describe('Selected matching filings.'),
    multi_issue_filing_count: z.number().int().describe('Filings mentioning more than one issue.'),
    expense_methods: z
      .array(
        z
          .object({
            method: z.string().nullable().describe('Reported method or unknown.'),
            known_expenses_usd: z.string().optional().describe('Separate method sum.'),
            expense_filing_count: z.number().int().describe('Known expense count.'),
            missing_expense_count: z.number().int().describe('Unknown expense count.'),
          })
          .describe('Separate expense accounting method.'),
      )
      .describe('Separate expense-method ledgers.'),
  })
  .describe('Annual income and expense ledgers, kept separate.')
  .meta({ id: 'LdaAnnualLedger' });
const Selection = z
  .object({
    candidate_filing_uuids: z.array(z.string()).describe('Latest candidates.'),
    client_id: z.string().nullable().describe('Relationship client.'),
    registrant_id: z.string().nullable().describe('Relationship registrant.'),
    period: z.string().describe('Report period.'),
    year: z.number().int().describe('Report year.'),
    selected_filing_uuid: z.string().optional().describe('Unambiguous selected UUID.'),
    superseded_filing_uuids: z.array(z.string()).describe('Earlier versions.'),
    selection_method: z
      .literal('latest_posted_within_relationship_period')
      .describe('Analytical selection rule, not legal lineage.'),
    status: z.enum(['selected', 'ambiguous', 'excluded']).describe('Selection outcome.'),
    exclusion_reason: z
      .enum(['registration', 'non_quarterly', 'unknown_variant', 'missing_relationship'])
      .optional()
      .describe('Why excluded.'),
  })
  .describe('Latest-version selection and excluded candidates.');
const Firm = z
  .object({
    registrant_id: z.string().describe('Firm ID.'),
    name: z.string().describe('Firm name.'),
    client_ids: z.array(z.string()).describe('Selected relationships.'),
    filing_uuids: z.array(z.string()).describe('Selected report UUIDs.'),
    annual_ledgers: z.array(Ledger).describe('Firm year ledgers.'),
  })
  .describe('Firm breakdown.');
const Issue = z
  .object({
    issue_code: z.string().describe('Issue code.'),
    filing_uuids: z.array(z.string()).describe('Matching report UUIDs.'),
    annual_ledgers: z.array(Ledger).describe('Overlapping issue ledgers.'),
  })
  .describe('Issue membership, not allocated spending.');
const TargetedEntity = z
  .object({
    entity: GovernmentEntitySchema.describe('Targeted entity.'),
    filing_uuids: z.array(z.string()).describe('Source reports.'),
  })
  .describe('Government entity and supporting filings.');
const AnalyticalRow = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('activity'),
    activity: ActivityRowSchema.describe(
      'Complete selected filing activity with no money columns.',
    ),
  }),
  z.object({
    kind: z.literal('annual_ledger'),
    ledger: Ledger.describe('Complete-year separate money ledger.'),
  }),
  z.object({
    kind: z.literal('raw_filing'),
    filing: FilingSchema.describe('Complete acquired source filing.'),
  }),
  z.object({
    kind: z.literal('selected_filing'),
    filing: FilingSchema.describe('Selected matching source filing.'),
  }),
  z.object({
    kind: z.literal('selection'),
    selection: Selection.describe('Auditable version-selection decision.'),
  }),
  z.object({
    kind: z.literal('firm'),
    firm: Firm,
  }),
  z.object({
    kind: z.literal('issue'),
    issue: Issue,
  }),
  z.object({
    kind: z.literal('targeted_entity'),
    entity: GovernmentEntitySchema.describe('Targeted entity.'),
    filing_uuids: z.array(z.string()).describe('Source reports.'),
  }),
]);
export const analyticalShape = {
  ...deliveryShape,
  canvas_available: z
    .boolean()
    .describe('Whether SQL canvas support is enabled on this installation.'),
  row_set_totals: RowSetCounts.optional().describe(
    'Exact complete-set totals, available only after acquisition completes.',
  ),
  row_set_offsets: RowSetCounts.optional().describe(
    'Records delivered or deferred before this window in each set; continue the shared cursor.',
  ),
  status: z
    .enum(['collecting', 'complete'])
    .describe('Source acquisition status, separate from row delivery.'),
  annual_ledgers: z
    .array(Ledger)
    .optional()
    .describe('Complete-year ledgers delivered in this window; absent while collecting.'),
  selections: z
    .array(Selection)
    .optional()
    .describe('Version-selection decisions delivered in this window.'),
  firms: z.array(Firm).optional().describe('Firm breakdowns delivered in this window.'),
  issue_codes: z
    .array(Issue)
    .optional()
    .describe('Overlapping issue breakdowns delivered in this window.'),
  targeted_entities: z
    .array(TargetedEntity)
    .optional()
    .describe('Targeted entities delivered in this window.'),
  selected_filings: z
    .array(FilingSchema)
    .optional()
    .describe('Selected complete filings delivered in this window.'),
  raw_filings: z
    .array(FilingSchema)
    .optional()
    .describe('Complete acquired filing versions delivered in this window.'),
  activities: z
    .array(ActivityRowSchema)
    .optional()
    .describe('Selected activities delivered in this window, without money columns.'),
  dataset: DatasetSchema.optional().describe(
    'Optional complete SQL staging with describe/query routing.',
  ),
  attribution_basis: z
    .literal('whole_filing_mentions_issue')
    .describe('Whole filings mentioning an issue; buckets overlap.'),
  methodology: z
    .object({
      selection_method: z
        .literal('latest_posted_within_relationship_period')
        .describe('Latest posting within relationship and quarter.'),
      issue_buckets_overlap: z.literal(true).describe('Do not sum issue buckets.'),
      amounts_are_separate: z.literal(true).describe('Never combine income and expenses.'),
      client_identity: z
        .literal('caller_selected_relationships')
        .describe('No corporate identity is inferred.'),
    })
    .describe('Accounting limitations.'),
};
function rowSetOffsets(offset: number, metadata: Record<string, JsonValue> | undefined) {
  if (!metadata) return {};
  const totals = RowSetCounts.parse(metadata.row_set_totals);
  let remaining = offset;
  const offsets: Record<string, number> = Object.create(null);
  for (const [name, total] of Object.entries(totals)) {
    offsets[name] = Math.min(remaining, total);
    remaining -= offsets[name];
  }
  return { row_set_offsets: RowSetCounts.parse(offsets) };
}
function analyticalLists(records: JsonValue[]): Record<string, JsonValue[]> {
  const lists: Record<string, JsonValue[]> = Object.create(null);
  const append = (name: string, value: unknown) => {
    lists[name] ??= [];
    lists[name].push(JsonValueSchema.parse(value));
  };
  for (const row of z.array(AnalyticalRow).parse(records)) {
    switch (row.kind) {
      case 'annual_ledger':
        append('annual_ledgers', row.ledger);
        break;
      case 'selection':
        append('selections', row.selection);
        break;
      case 'firm':
        append('firms', row.firm);
        break;
      case 'issue':
        append('issue_codes', row.issue);
        break;
      case 'targeted_entity':
        append('targeted_entities', { entity: row.entity, filing_uuids: row.filing_uuids });
        break;
      case 'selected_filing':
        append('selected_filings', row.filing);
        break;
      case 'raw_filing':
        append('raw_filings', row.filing);
        break;
      case 'activity':
        append('activities', row.activity);
        break;
      default: {
        const unreachable: never = row;
        throw new Error(`Unknown analytical row: ${unreachable}`);
      }
    }
  }
  return lists;
}
export function analyzeScope(
  ctx: Context,
  tool: string,
  f: Record<string, JsonValue>,
  input: { cursor?: string | undefined; max_pages?: number | undefined },
  partitions: Record<string, string | number | boolean>[],
  build: (base: object) => object,
) {
  const method = {
    selection_method: 'latest_posted_within_relationship_period',
    issue_buckets_overlap: true,
    amounts_are_separate: true,
    client_identity: 'caller_selected_relationships',
  };
  return acquire(ctx, {
    tool,
    scanKind: 'analysis',
    filters: f,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    maxPages: input.max_pages ?? 5,
    retainAll: true,
    source: source('filings', partitions),
    provenance: provenance(f),
    buildResponse: (w, meta, stored) =>
      build({
        ...envelope(
          w,
          f,
          'No selected quarterly filings matched the completed scope; inspect uslobbying_list_reference topic issue_codes, or revise years/client/registrant.',
          stored,
        ),
        status: w.coverage.complete ? 'complete' : 'collecting',
        canvas_available: getCanvas() !== undefined,
        ...analyticalLists(w.records),
        attribution_basis: 'whole_filing_mentions_issue',
        methodology: method,
        ...meta,
        ...rowSetOffsets(w.offset, meta),
      }),
    async finalize({ chunks, coverage }) {
      async function* rawFilings() {
        for await (const chunk of chunks)
          for (const filing of chunk) yield FilingSchema.parse(filing);
      }
      const result = await analyzeFilings(
        rawFilings(),
        typeof f.issue_code === 'string' ? { issue_code: f.issue_code } : {},
      );
      let dataset: z.infer<typeof DatasetSchema> | undefined;
      if (getCanvas() || f.canvas_id !== undefined)
        dataset = await stageFilings(
          {
            raw_filings: rawFilings(),
            selected_filings: result.selected,
            selections: result.selections,
            activities: result.activities,
            source_tool: tool,
            provenance: { ...provenance(f), coverage: CoverageSchema.parse(coverage) },
            ...(typeof f.canvas_id === 'string' ? { canvas_id: f.canvas_id } : {}),
          },
          ctx,
        );
      async function* rows(): AsyncGenerator<JsonValue> {
        for (const ledger of result.annual_ledgers)
          yield JsonValueSchema.parse({ kind: 'annual_ledger', ledger });
        for (const selection of result.selections)
          yield JsonValueSchema.parse({ kind: 'selection', selection });
        for (const firm of result.firms) yield JsonValueSchema.parse({ kind: 'firm', firm });
        for (const issue of result.issue_codes)
          yield JsonValueSchema.parse({ kind: 'issue', issue });
        for (const entity of result.targeted_entities)
          yield JsonValueSchema.parse({ kind: 'targeted_entity', ...entity });
        for (const filing of result.selected)
          yield JsonValueSchema.parse({ kind: 'selected_filing', filing });
        for (const activity of result.activities)
          yield JsonValueSchema.parse({ kind: 'activity', activity });
        for await (const filing of rawFilings())
          yield JsonValueSchema.parse({ kind: 'raw_filing', filing });
      }
      return {
        records: rows(),
        metadata: {
          canvas_available: getCanvas() !== undefined,
          row_set_totals: {
            annual_ledgers: result.annual_ledgers.length,
            selections: result.selections.length,
            firms: result.firms.length,
            issue_codes: result.issue_codes.length,
            targeted_entities: result.targeted_entities.length,
            selected_filings: result.selected.length,
            activities: result.selected.reduce(
              (total, filing) => total + (filing.lobbying_activities?.length ?? 0),
              0,
            ),
            raw_filings: coverage.unique_records,
          },
          ...(dataset ? { dataset: JsonValueSchema.parse(dataset) } : {}),
        },
      };
    },
  });
}
