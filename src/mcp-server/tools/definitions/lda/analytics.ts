/** @fileoverview Typed analytical rows and complete-scope finalization. @module mcp-server/tools/definitions/lda/analytics */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { CanvasPointersShape, CoverageSchema, DatasetSchema } from '@/domain/contracts.js';
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

/** Inline selection changes delivery only; complete analysis and SQL staging retain every set. */
export const rowSetsInput = z
  .array(RowSetCounts.keyof())
  .min(1)
  .refine((sets) => new Set(sets).size === sets.length, 'row_sets must contain unique names.')
  .optional()
  .describe(
    'Inline analytical sets; omit for all sets. Selection never limits acquisition, totals or SQL staging. Omitted sets remain available from a new call with another selection or staged tables. Continue with omitted or equivalent row_sets.',
  );

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
  z.object({ kind: z.literal('notice'), notice: z.string() }),
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
  canvas_id: CanvasPointersShape.canvas_id.optional(),
  describe_tool: CanvasPointersShape.describe_tool.optional(),
  query_tool: CanvasPointersShape.query_tool.optional(),
  guidance: CanvasPointersShape.guidance.optional(),
  canvas_available: z.boolean().describe('SQL canvas support is enabled.'),
  row_set_totals: RowSetCounts.optional().describe(
    'Exact all-set totals after acquisition completes.',
  ),
  row_set_offsets: RowSetCounts.optional().describe(
    'Selected-set rows delivered or deferred before this window; others zero.',
  ),
  status: z
    .enum(['collecting', 'complete'])
    .describe('Source acquisition status, separate from row delivery.'),
  annual_ledgers: z
    .array(Ledger)
    .optional()
    .describe('Complete-year ledgers in this window; absent while collecting.'),
  selections: z.array(Selection).optional().describe('Version-selection decisions in this window.'),
  firms: z.array(Firm).optional().describe('Firm breakdowns in this window.'),
  issue_codes: z.array(Issue).optional().describe('Overlapping issue breakdowns in this window.'),
  targeted_entities: z
    .array(TargetedEntity)
    .optional()
    .describe('Targeted entities in this window.'),
  selected_filings: z
    .array(FilingSchema)
    .optional()
    .describe('Complete selected filings in this window.'),
  raw_filings: z
    .array(FilingSchema)
    .optional()
    .describe('All acquired versions in this window, including selected versions.'),
  activities: z
    .array(ActivityRowSchema)
    .optional()
    .describe('Selected activities in this window; no money columns.'),
  dataset: DatasetSchema.optional().describe(
    'Complete SQL metadata on the first final window and its replay.',
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
function rowSetOffsets(
  offset: number,
  metadata: Record<string, JsonValue> | undefined,
  selected: Set<string>,
) {
  if (!metadata) return {};
  const totals = RowSetCounts.parse(metadata.row_set_totals);
  let remaining = offset;
  const offsets: Record<string, number> = Object.create(null);
  for (const [name, total] of Object.entries(totals)) {
    offsets[name] = selected.has(name) ? Math.min(remaining, total) : 0;
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
      case 'notice':
        append('notices', row.notice);
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
  const selected = new Set(
    z.array(z.string()).parse(f.row_sets ?? Object.keys(RowSetCounts.shape)),
  );
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
    maxPages: Math.min(input.max_pages ?? 5, 5),
    retainAll: true,
    source: source('filings', partitions),
    provenance: provenance(f, input),
    buildResponse: (w, meta, stored) => {
      const { dataset: staged, ...metadata } = meta ?? {};
      const dataset = staged === undefined ? undefined : DatasetSchema.parse(staged);
      const lists = analyticalLists(w.records);
      const base = envelope(
        w,
        f,
        w.coverage.records_fetched === 0
          ? 'No source filings were fetched for the completed scope; zero rows do not establish identifier validity.'
          : meta && RowSetCounts.parse(meta.row_set_totals).selected_filings > 0
            ? 'No rows belong to the selected inline row sets; inspect row_set_totals or request another selection.'
            : 'Source filings were acquired, but no quarterly filings survived version and issue selection.',
        stored,
        input,
      );
      return build({
        ...base,
        status: w.coverage.complete ? 'complete' : 'collecting',
        canvas_available: getCanvas() !== undefined,
        ...lists,
        notices: [...base.notices, ...(lists.notices ?? [])],
        attribution_basis: 'whole_filing_mentions_issue',
        methodology: method,
        ...metadata,
        ...(dataset
          ? {
              canvas_id: dataset.canvas_id,
              describe_tool: dataset.describe_tool,
              query_tool: dataset.query_tool,
              guidance: dataset.guidance,
              ...(w.offset === 0 ? { dataset } : {}),
            }
          : {}),
        ...rowSetOffsets(w.offset, meta, selected),
      });
    },
    async finalize({ chunks, coverage, checkpoint }) {
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
        if (selected.has('annual_ledgers'))
          for (const ledger of result.annual_ledgers)
            yield JsonValueSchema.parse({ kind: 'annual_ledger', ledger });
        if (selected.has('selections'))
          for (const selection of result.selections)
            yield JsonValueSchema.parse({ kind: 'selection', selection });
        if (selected.has('firms'))
          for (const firm of result.firms) yield JsonValueSchema.parse({ kind: 'firm', firm });
        if (selected.has('issue_codes'))
          for (const issue of result.issue_codes)
            yield JsonValueSchema.parse({ kind: 'issue', issue });
        if (selected.has('targeted_entities'))
          for (const entity of result.targeted_entities)
            yield JsonValueSchema.parse({ kind: 'targeted_entity', ...entity });
        if (selected.has('selected_filings'))
          for (const filing of result.selected)
            yield JsonValueSchema.parse({ kind: 'selected_filing', filing });
        if (selected.has('activities'))
          for (const activity of result.activities)
            yield JsonValueSchema.parse({ kind: 'activity', activity });
        if (selected.has('raw_filings'))
          for await (const filing of rawFilings())
            yield JsonValueSchema.parse({ kind: 'raw_filing', filing });
        // Notices use the same retained windows as records, so many empty partitions cannot inflate every response.
        for (const [index, observed] of Object.entries(checkpoint.partitions?.observed ?? {})) {
          const partition = partitions[Number(index)];
          if (!observed.completeHistory || observed.recordsFetched !== 0 || !partition) continue;
          const scope = Object.entries(partition)
            .filter(([key]) => key !== 'page_size')
            .map(([key, value]) => `${key}=${value}`)
            .join(', ');
          yield {
            kind: 'notice',
            notice: `No source filings were fetched for ${scope}; zero rows do not establish identifier validity.`,
          };
        }
        if (coverage.records_fetched > 0 && result.selected.length === 0)
          yield {
            kind: 'notice',
            notice:
              'Source filings were acquired, but no quarterly filings survived version and issue selection.',
          };
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
