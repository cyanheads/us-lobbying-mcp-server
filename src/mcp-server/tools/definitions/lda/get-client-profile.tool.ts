/** @fileoverview Resolve client relationships and analyze explicitly selected IDs. @module mcp-server/tools/definitions/lda/getClientProfile */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { formatResult } from '@/domain/format.js';
import { ClientSchema } from '@/domain/lda.js';
import { acquire } from '@/services/acquisition/acquisition-service.js';
import { analyticalShape, analyzeScope } from './analytics.js';
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
  year,
} from './shared.js';

const NAME = 'uslobbying_get_client_profile';
const Output = z.union([
  recordOutput,
  z.object({
    ...analyticalShape,
    mode: z.literal('profile').describe('Selected relationship analysis.'),
    client_ids: z.array(id).describe('Caller-selected client relationship IDs.'),
    years: z.array(year).describe('Explicit requested years.'),
  }),
  z.object({
    ...deliveryShape,
    mode: z.literal('resolve').describe('Client name resolution.'),
    candidates: z.array(ClientSchema).describe('All matching relationships; never auto-merged.'),
    guidance: z.string().describe('Next profile-mode selection step.'),
  }),
]);
/** Resolve names before selecting client relationships for analysis. */
export const getClientProfile = tool(NAME, {
  description:
    'Resolve client relationship records by client_name in mode resolve (default), then use mode profile with explicit client_ids and years. IDs identify relationships with registrants, not a verified corporate identity. Follow collecting cursors before interpreting separate nullable income and expense ledgers. Typed rows preserve every audit filing and complete analytical list inline; optional canvas datasets support SQL.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.strictObject({
    ...commonInput,
    mode: z
      .preprocess(
        (value) => (typeof value === 'string' ? value.trim().toLowerCase() || undefined : value),
        z.enum(['resolve', 'profile']).optional(),
      )
      .describe(
        'resolve (default) finds client_name candidates; profile requires selected client_ids and years. Omit on continuation.',
      ),
    client_name: z.string().optional().describe('Required literal name in resolve mode.'),
    client_ids: z
      .array(id)
      .min(1)
      .optional()
      .describe('Required explicit relationships in profile mode.'),
    years: z
      .array(year)
      .min(1)
      .optional()
      .describe('Required explicit analytical year scope; sorted and deduplicated.'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Reuse this canvas only after complete analytical acquisition.',
    ),
  }),
  output: outputObject(Output.options).extend({
    mode: z
      .enum(['resolve', 'profile'])
      .optional()
      .describe(
        'Client resolution or selected relationship analysis; absent on stored-record retrieval.',
      ),
  }),
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
    const mode = f.mode ?? 'resolve';
    f.mode = mode;
    if (mode !== 'resolve' && mode !== 'profile') invalid('mode must be resolve or profile.');
    if (mode === 'resolve') {
      if (f.client_ids !== undefined || f.years !== undefined || f.canvas_id !== undefined)
        invalid('Resolve mode accepts only client_name and pagination.');
      if (typeof f.client_name !== 'string') invalid('Resolve mode requires client_name.');
      const result = await acquire(ctx, {
        tool: NAME,
        scanKind: 'resolve',
        filters: f,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.max_pages ? { maxPages: input.max_pages } : {}),
        source: source('clients', [
          { client_name: f.client_name, page_size: Number(f.page_size ?? 25) },
        ]),
        provenance: provenance(f),
        buildResponse: (w, _metadata, stored) => ({
          ...envelope(
            w,
            f,
            'No client records matched; revise client_name in uslobbying_get_client_profile mode resolve.',
            stored,
          ),
          mode: 'resolve',
          candidates: w.records,
          guidance:
            'Call uslobbying_get_client_profile mode profile with chosen client_ids and explicit years; relationship IDs do not assert corporate identity.',
        }),
      });
      return Output.parse(result.response);
    }
    if (f.client_name !== undefined)
      invalid('Profile mode requires selected client_ids, not client_name.');
    const ids = z.array(z.string().regex(/^\d+$/)).min(1).safeParse(f.client_ids);
    if (!ids.success) invalid('Profile mode requires nonempty digit-string client_ids.');
    const years = z.array(year).min(1).safeParse(f.years);
    if (!years.success) invalid('Analytical mode requires explicit nonempty years.');
    const partitions: Record<string, string | number | boolean>[] = [];
    for (const client_id of ids.data)
      for (const filing_year of years.data)
        partitions.push({ client_id, filing_year, page_size: Number(f.page_size ?? 25) });
    const result = await analyzeScope(ctx, NAME, f, input, partitions, (base) => ({
      ...base,
      mode: 'profile',
      client_ids: ids.data,
      years: years.data,
    }));
    return Output.parse(result.response);
  },
  format: formatResult,
});
