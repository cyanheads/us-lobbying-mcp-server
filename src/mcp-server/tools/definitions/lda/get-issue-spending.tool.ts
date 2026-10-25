/** @fileoverview Analyze amounts on selected filings mentioning an issue. @module mcp-server/tools/definitions/lda/getIssueSpending */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { formatResult } from '@/domain/format.js';
import { analyticalShape, analyzeScope, CanvasIdSchema } from './analytics.js';
import {
  commonInput,
  id,
  invalid,
  outputObject,
  recordOutput,
  scope,
  verifyCode,
  year,
} from './shared.js';

const NAME = 'uslobbying_get_issue_spending';
const Output = z.union([
  recordOutput,
  z.object({
    ...analyticalShape,
    issue_code: z.string().describe('Requested issue membership code.'),
    years: z.array(year).describe('Explicit requested years.'),
  }),
]);
/** Whole-filing reported amounts are overlapping issue associations. */
export const getIssueSpending = tool(NAME, {
  description:
    'Aggregate separate income and expense amounts on quarterly filings mentioning issue_code across explicit years. This is whole-filing association, not allocated issue spending; issue buckets overlap. All versions are acquired before latest-period selection and local issue filtering. Broad scans can take hours and exhaust temporary storage; narrow client_id or registrant_id when appropriate. Follow collecting cursors before interpreting final typed rows or optional SQL datasets.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.strictObject({
    ...commonInput,
    issue_code: z
      .string()
      .optional()
      .describe('Required first-call code from uslobbying_list_reference topic issue_codes.'),
    client_id: id.optional().describe('Optional native client scope.'),
    registrant_id: id.optional().describe('Optional native registrant scope.'),
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
    const resolved = await scope(input, ctx, NAME);
    if (resolved.record) return Output.parse(resolved.record);
    const f = resolved.filters;
    if (typeof f.issue_code !== 'string') invalid('issue_code is required on the first call.');
    await verifyCode('issue_codes', f.issue_code, ctx);
    const years = z.array(year).min(1).safeParse(f.years);
    if (!years.success) invalid('Analytical mode requires explicit nonempty years.');
    const partitions: Record<string, string | number | boolean>[] = [];
    for (const filing_year of years.data) {
      const p: Record<string, string | number | boolean> = {
        filing_year,
        page_size: Number(f.page_size ?? 25),
      };
      if (typeof f.client_id === 'string') p.client_id = f.client_id;
      if (typeof f.registrant_id === 'string') p.registrant_id = f.registrant_id;
      partitions.push(p);
    }
    const result = await analyzeScope(ctx, NAME, f, input, partitions, (base) => ({
      ...base,
      issue_code: f.issue_code,
      years: years.data,
    }));
    return Output.parse(result.response);
  },
  format: formatResult,
});
