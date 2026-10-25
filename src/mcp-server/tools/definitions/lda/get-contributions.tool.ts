/** @fileoverview Retrieve complete semiannual LD-203 reports, contributions, PAC relationships and certifications, preserving original and amended reports. Child predicates must match the same item; full parent contribution lists and matched_item_indexes remain available. Report counts are not donation counts and no cross-report donation total is inferred. @module mcp-server/tools/definitions/lda/get-contributions.tool.ts */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { formatResult } from '@/domain/format.js';
import { JsonValueSchema } from '@/domain/json.js';
import { ContributionReportSchema } from '@/domain/lda.js';
import { acquire } from '@/services/acquisition/acquisition-service.js';
import { matchContributionItems } from '@/services/lobbying/analysis.js';
import {
  commonInput,
  deliveryShape,
  envelope,
  id,
  invalid,
  outputObject,
  provenance,
  recordOutput,
  scope,
  source,
  verifyCode,
  year,
} from './shared.js';

const NAME = 'uslobbying_get_contributions';
const ContributionPredicatesSchema = z.object({
  contribution_type: z.string().optional(),
  contributor: z.string().optional(),
  payee: z.string().optional(),
  honoree: z.string().optional(),
  contribution_date_after: z.string().optional(),
  contribution_date_before: z.string().optional(),
});
const Output = z.union([
  z.object({
    ...deliveryShape,
    reports: z
      .array(ContributionReportSchema)
      .describe('Full parent reports and complete child lists.'),
    report_count_in_batch: z.number().int().describe('Complete parent reports returned.'),
    item_count_in_batch: z.number().int().describe('Items in returned complete parent lists.'),
    amendment_policy: z.literal('all_versions').describe('Amendments remain separate reports.'),
  }),
  recordOutput,
]);
/** Retrieve complete semiannual LD-203 reports, contributions, PAC relationships and certifications, preserving original and amended reports. Child predicates must match the same item; full parent contribution lists and matched_item_indexes remain available. Report counts are not donation counts and no cross-report donation total is inferred. */
export const getContributions = tool(NAME, {
  description:
    'Retrieve complete semiannual LD-203 reports, contributions, PAC relationships and certifications, preserving original and amended reports. Child predicates must match the same item; full parent contribution lists and matched_item_indexes remain available. Report counts are not donation counts and no cross-report donation total is inferred.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.strictObject({
    ...commonInput,
    filing_year: year
      .min(2008)
      .optional()
      .describe('Required first-call reporting year, 2008 through current UTC year.'),
    filing_period: z.enum(['mid_year', 'year_end']).optional().describe('Semiannual period.'),
    registrant_id: id.optional().describe('Registrant ID.'),
    lobbyist_id: id.optional().describe('Lobbyist filer ID.'),
    registrant_name: z.string().optional().describe('Registrant name upstream search.'),
    lobbyist_name: z.string().optional().describe('Lobbyist name upstream search.'),
    contribution_type: z
      .string()
      .optional()
      .describe('Official feca, he, me, ple or pic payment code.'),
    contributor: z.string().optional().describe('Case-insensitive literal contributor substring.'),
    payee: z.string().optional().describe('Case-insensitive literal payee substring.'),
    honoree: z.string().optional().describe('Case-insensitive literal honoree substring.'),
    contribution_date_after: z.iso
      .date()
      .optional()
      .describe('Inclusive earliest item calendar date.'),
    contribution_date_before: z.iso
      .date()
      .optional()
      .describe('Inclusive latest item calendar date.'),
  }),
  output: outputObject(Output.options),
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Invalid scope, identifier, reference code or mode combination.',
      recovery:
        'Call uslobbying_list_reference with topic identifiers or methodology, then retry this tool with the required filters.',
      thrownBy: 'service',
    },
    {
      reason: 'cursor_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unknown, expired, stale or mismatched continuation.',
      recovery: 'Restart the same tool with the original filters and omit cursor.',
      thrownBy: 'service',
    },
    {
      reason: 'acquisition_storage_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Storage cannot safely retain a checkpoint.',
      recovery:
        'Retry the last cursor after storage is available, or restart this source tool with narrower year/client/registrant filters; larger durable scans can use STORAGE_PROVIDER_TYPE=filesystem and STORAGE_FILESYSTEM_PATH.',
      thrownBy: 'service',
    },
    {
      reason: 'pagination_invalid',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Invalid or nonprogressing upstream pagination.',
      recovery:
        'Retry the source tool without cursor with a narrower client or registrant scope; consult uslobbying_list_reference topic methodology.',
      thrownBy: 'service',
    },
    {
      reason: 'source_schema_changed',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Successful source response violates its verified schema.',
      recovery:
        'Use uslobbying_list_reference topic methodology for source limitations; retry the source tool after the upstream response format is supported.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    ctx = withToolDeadline(ctx);
    const resolved = await scope(input, ctx, NAME);
    if (resolved.record) return Output.parse(resolved.record);
    const f = resolved.filters;
    if (typeof f.filing_year !== 'number') invalid('filing_year is required on the first call.');
    if (
      typeof f.contribution_date_after === 'string' &&
      typeof f.contribution_date_before === 'string' &&
      f.contribution_date_after > f.contribution_date_before
    )
      invalid('Contribution date range is inverted.');
    await verifyCode('contribution_types', f.contribution_type, ctx);
    const parsed = ContributionPredicatesSchema.parse(f);
    const predicates: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed))
      if (value !== undefined) predicates[key] = value;
    const native: Record<string, string | number | boolean> = {
      page_size: Number(f.page_size ?? 25),
    };
    for (const key of [
      'filing_year',
      'filing_period',
      'registrant_id',
      'lobbyist_id',
      'registrant_name',
      'lobbyist_name',
      'contribution_type',
      'contribution_date_after',
      'contribution_date_before',
    ]) {
      const value = f[key];
      if (typeof value === 'string' || typeof value === 'number') native[key] = value;
    }
    for (const key of ['contributor', 'payee', 'honoree'])
      if (typeof f[key] === 'string') native[`contribution_${key}`] = f[key];
    const upstream = source('contributions', [native]);
    const result = await acquire(ctx, {
      tool: NAME,
      scanKind: 'contributions',
      filters: f,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.max_pages ? { maxPages: input.max_pages } : {}),
      provenance: provenance(f),
      source: {
        ...upstream,
        async fetchPage(...args) {
          const page = await upstream.fetchPage(...args);
          return {
            ...page,
            records: z.array(JsonValueSchema).parse(
              z
                .array(ContributionReportSchema)
                .parse(page.records)
                .map((report) => ({
                  ...report,
                  matched_item_indexes: matchContributionItems(report, predicates),
                })),
            ),
          };
        },
      },
      matches: (row) =>
        Object.keys(predicates).length === 0 ||
        (ContributionReportSchema.parse(row).matched_item_indexes?.length ?? 0) > 0,
      buildResponse: (w, _metadata, stored) => ({
        ...envelope(
          w,
          f,
          'No LD-203 reports matched the completed scope; use uslobbying_list_reference topic contribution_types, then revise uslobbying_get_contributions.',
          stored,
        ),
        reports: w.records,
        report_count_in_batch: w.records.length,
        item_count_in_batch: z
          .array(ContributionReportSchema)
          .parse(w.records)
          .reduce((sum, r) => sum + r.contribution_items.length, 0),
        amendment_policy: 'all_versions',
      }),
    });
    return Output.parse(result.response);
  },
  format: formatResult,
});
