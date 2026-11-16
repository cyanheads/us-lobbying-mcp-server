/** @fileoverview Analyze amounts on selected filings mentioning an issue, or on every selected filing in a registrant scope. @module mcp-server/tools/definitions/lda/getIssueSpending */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { CEILINGS } from '@/domain/delivery-limits.js';
import { formatResult } from '@/domain/format.js';
import { analyticalShape, analyzeScope, rowSetsInput } from './analytics.js';
import {
  commonInput,
  id,
  includeInput,
  invalid,
  LDA_PAGE_SIZE,
  outputObject,
  scope,
  verifyCode,
  year,
} from './shared.js';

const NAME = 'uslobbying_get_issue_spending';
const REGISTRANT_WIDE =
  'Without issue_code, ledgers cover every selected filing in the registrant scope, not one issue; issue_codes rows give the overlapping per-issue view.';
const Output = z.union([
  z.object({
    ...analyticalShape,
    issue_code: z
      .string()
      .optional()
      .describe('Requested issue membership code; absent for registrant-wide ledgers.'),
    years: z.array(year).describe('Explicit requested years.'),
  }),
]);
/** Whole-filing reported amounts are overlapping issue associations. */
export const getIssueSpending = tool(NAME, {
  description:
    'Aggregate separate income and expense amounts across explicit years on selected filings mentioning issue_code, or, when registrant_id is given without issue_code, on every selected filing in that registrant scope, broken out per client relationship in clients. Issue association is whole-filing, not allocated issue spending; issue buckets overlap. All versions are acquired before latest-period selection and local issue filtering. Broad scans can take hours; narrow client_id or registrant_id when appropriate. Follow collecting cursors before interpreting final typed rows or SQL datasets. Activity descriptions and lobbyist lists appear in typed rows only when include names them; pass a selected filing UUID to uslobbying_search_filings for its complete record.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.strictObject({
    ...commonInput,
    page_size: commonInput.page_size.describe(
      `Whole analytical rows delivered per call: default 25, at most ${CEILINGS.analytical.page_size}; larger values clamp to it and are disclosed in delivery_limits. Not the upstream page size; a page is short only at the end of the result or while acquisition is still collecting.`,
    ),
    row_sets: rowSetsInput,
    include: includeInput.describe(
      'Lobbying-activity fields to return in selected_filings, raw_filings and activities: activity_descriptions (description) and activity_lobbyists (lobbyists). Fields left out are removed from delivered rows only; totals and SQL datasets are unaffected. Default []. Fixed for the scan: a continuation omits it or repeats it unchanged.',
    ),
    issue_code: z
      .string()
      .optional()
      .describe(
        'First-call code from uslobbying_list_reference topic issue_codes. Required unless registrant_id is given; omit it with registrant_id for ledgers across every issue.',
      ),
    client_id: id
      .optional()
      .describe(
        'Optional client relationship record ID from candidates[].id in uslobbying_get_client_profile resolve mode; candidates[].client_id is secondary.',
      ),
    registrant_id: id
      .optional()
      .describe('Optional native registrant scope; without issue_code, ledgers cover every issue.'),
    years: z
      .array(year)
      .min(1)
      .optional()
      .describe('Required explicit analytical year scope; sorted and deduplicated.'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Reuse this canvas only after complete analytical acquisition.',
    ),
  }),
  output: outputObject(Output.options),
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Invalid scope, identifier, reference code or mode combination, or an over-cap page_size or max_pages while clamping is disabled.',
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
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Explicit staging without a configured canvas.',
      recovery:
        'Use uslobbying_get_client_profile or uslobbying_get_issue_spending for inline results; SQL requires an npm or Docker installation with CANVAS_PROVIDER_TYPE=duckdb, and is unavailable in the MCPB bundle.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Supplied canvas expired or unknown.',
      recovery:
        'Re-run uslobbying_get_client_profile or uslobbying_get_issue_spending to stage data, then pass its returned canvas_id to uslobbying_dataframe_describe.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    ctx = withToolDeadline(ctx);
    const resolved = await scope(input, ctx, NAME, CEILINGS.analytical);
    const f = resolved.filters;
    const issueCode = typeof f.issue_code === 'string' ? f.issue_code : undefined;
    if (issueCode === undefined && typeof f.registrant_id !== 'string')
      throw typeof f.client_id === 'string'
        ? ctx.fail(
            'invalid_filter',
            'issue_code is required unless registrant_id is given; client_id alone does not scope an all-issue ledger.',
            {
              recovery: {
                hint: 'Add issue_code from uslobbying_list_reference topic issue_codes, or analyze this client relationship across every issue with uslobbying_get_client_profile mode profile and client_ids.',
              },
            },
          )
        : ctx.fail('invalid_filter', 'issue_code is required unless registrant_id is given.', {
            recovery: {
              hint: 'Add issue_code from uslobbying_list_reference topic issue_codes, or add registrant_id for ledgers across every issue that firm reported.',
            },
          });
    if (!input.cursor) await verifyCode('issue_codes', issueCode, ctx, 'issue_code');
    const years = z.array(year).min(1).safeParse(f.years);
    if (!years.success) invalid('Analytical mode requires explicit nonempty years.');
    const partitions: Record<string, string | number | boolean>[] = [];
    for (const filing_year of years.data) {
      const p: Record<string, string | number | boolean> = {
        filing_year,
        page_size: LDA_PAGE_SIZE,
      };
      if (typeof f.client_id === 'string') p.client_id = f.client_id;
      if (typeof f.registrant_id === 'string') p.registrant_id = f.registrant_id;
      partitions.push(p);
    }
    const result = await analyzeScope(ctx, NAME, resolved, input.cursor, partitions, (base) => ({
      ...base,
      ...(issueCode === undefined ? {} : { issue_code: issueCode }),
      years: years.data,
    }));
    const output = Output.parse(result.response);
    if (issueCode === undefined) output.notices.push(REGISTRANT_WIDE);
    return output;
  },
  format: formatResult,
});
