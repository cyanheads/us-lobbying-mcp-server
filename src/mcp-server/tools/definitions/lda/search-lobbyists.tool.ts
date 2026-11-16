/** @fileoverview Resolve lobbyist identities and filing-scoped activity evidence. @module mcp-server/tools/definitions/lda/search-lobbyists.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { CEILINGS } from '@/domain/delivery-limits.js';
import { formatResult } from '@/domain/format.js';
import { type JsonValue, JsonValueSchema } from '@/domain/json.js';
import {
  ActivityLobbyistSchema,
  FilingSchema,
  LobbyingActivitySchema,
  LobbyistSchema,
} from '@/domain/lda.js';
import { acquire } from '@/services/acquisition/acquisition-service.js';
import { lobbyistEvidence } from '@/services/lobbying/analysis.js';
import {
  commonInput,
  deliveryShape,
  envelope,
  id,
  includeInput,
  invalid,
  nativeFilters,
  outputObject,
  projectActivity,
  provenance,
  scope,
  source,
  year,
} from './shared.js';

const NAME = 'uslobbying_search_lobbyists';
const Evidence = z
  .object({
    ...ActivityLobbyistSchema.shape,
    filing_uuid: z.string().describe('Parent filing UUID.'),
    filing_year: year.describe('Parent report year.'),
    filing_period: z.string().describe('Parent period.'),
    filing_type: z.string().describe('Parent report type.'),
    dt_posted: z.string().describe('Parent posting time.'),
    filing_document_url: z.string().nullable().optional().describe('Returned document URL.'),
    registrant_id: id.nullable().describe('Parent registrant.'),
    client_id: id.nullable().describe('Parent client relationship.'),
    activity_index: z.number().int().describe('Original activity index.'),
    lobbyist_index: z.number().int().describe('Original participant index.'),
    general_issue_code: z.string().describe('Activity issue code.'),
    activity: LobbyingActivitySchema.describe(
      'Matched activity; description and its lobbyist list appear only when include names them.',
    ),
  })
  .catchall(JsonValueSchema)
  .describe('Complete filing-scoped lobbyist evidence.');
const Output = z.union([
  z.object({
    ...deliveryShape,
    mode: z.enum(['search', 'activity']).describe('Resolved operation.'),
    lobbyists: z
      .array(LobbyistSchema)
      .optional()
      .describe('Complete identity records in search mode.'),
    evidence: z
      .array(Evidence)
      .optional()
      .describe('Matched filing-based participant evidence in activity mode.'),
  }),
]);
/** Find identities before requesting filing-scoped covered-position evidence. */
export const searchLobbyists = tool(NAME, {
  description:
    'Find lobbyists by name or registrant in mode search, then retrieve filing-scoped evidence with mode activity, lobbyist_id and filing_year. Pass an evidence filing_uuid to uslobbying_search_filings for the complete filing. Covered positions are disclosed text, not verified present employment. Activity mode checks the requested lobbyist locally; evidence activities carry description and lobbyist lists only when include names them. Follow next_cursor for all results.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.strictObject({
    ...commonInput,
    page_size: commonInput.page_size.describe(
      `Whole records delivered per call: identities in search mode (default 25, at most ${CEILINGS.identities.page_size}), evidence rows in activity mode (default 25, at most ${CEILINGS.evidence.page_size}). Larger values clamp to the mode's ceiling and are disclosed in delivery_limits. Not the upstream page size; a page is short only at the end of the result or while acquisition is still collecting.`,
    ),
    include: includeInput.describe(
      'Activity mode only: lobbying-activity fields to return in evidence[].activity, activity_descriptions (description) and activity_lobbyists (lobbyists). Fields left out are removed; nothing else is. Default []. Fixed for the scan: a continuation omits it or repeats it unchanged.',
    ),
    mode: z
      .preprocess(
        (value) => (typeof value === 'string' ? value.trim().toLowerCase() || undefined : value),
        z.enum(['search', 'activity']).optional(),
      )
      .describe(
        'search (default) finds identities by name or registrant; activity requires lobbyist_id and filing_year. Omit with cursor.',
      ),
    name: z.string().optional().describe('Lobbyist identity name substring.'),
    registrant_name: z.string().optional().describe('Registrant identity name substring.'),
    registrant_id: id.optional().describe('Registrant identity ID.'),
    lobbyist_id: id.optional().describe('Required in activity mode.'),
    filing_year: year.optional().describe('Required report year in activity mode.'),
    client_id: id
      .optional()
      .describe(
        'Optional activity client relationship record ID from candidates[].id in uslobbying_get_client_profile resolve mode; candidates[].client_id is secondary.',
      ),
    covered_positions_only: z
      .boolean()
      .optional()
      .describe('Activity only: require this lobbyist’s nonblank covered-position disclosure.'),
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
  ],
  async handler(input, ctx) {
    ctx = withToolDeadline(ctx);
    const resolved = await scope(input, ctx, NAME, (filters) =>
      filters.mode === 'activity' ? CEILINGS.evidence : CEILINGS.identities,
    );
    const f = resolved.filters;
    const mode = f.mode ?? 'search';
    f.mode = mode;
    if (mode !== 'search' && mode !== 'activity') invalid('mode must be search or activity.');
    if (
      mode === 'search' &&
      (f.lobbyist_id !== undefined ||
        f.filing_year !== undefined ||
        f.client_id !== undefined ||
        f.covered_positions_only !== undefined ||
        f.include !== undefined)
    )
      invalid(
        'Activity selectors (lobbyist_id, filing_year, client_id, covered_positions_only, include) cannot be used in identity search.',
      );
    if (
      mode === 'activity' &&
      (f.name !== undefined || f.registrant_name !== undefined || f.registrant_id !== undefined)
    )
      invalid('Identity search selectors cannot be used in activity mode.');
    if (
      mode === 'activity' &&
      (typeof f.lobbyist_id !== 'string' || typeof f.filing_year !== 'number')
    )
      invalid('Activity mode requires lobbyist_id and filing_year.');
    if (mode === 'search' && !f.name && !f.registrant_name && !f.registrant_id)
      invalid('Search mode requires name or registrant scope.');
    if (mode === 'activity') f.include ??= [];
    const native = nativeFilters(
      f,
      mode === 'search'
        ? ['registrant_name', 'registrant_id']
        : ['lobbyist_id', 'filing_year', 'client_id'],
    );
    if (typeof f.name === 'string') native.lobbyist_name = f.name;
    if (f.covered_positions_only === true) native.lobbyist_covered_position_indicator = true;
    const upstream = source(mode === 'search' ? 'lobbyists' : 'filings', [native]);
    const result = await acquire(ctx, {
      tool: NAME,
      scanKind: mode,
      filters: f,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      pageSize: resolved.page_size ?? 25,
      ...(resolved.max_pages ? { maxPages: resolved.max_pages } : {}),
      provenance: provenance(f, resolved.delivery_limits),
      source: upstream,
      ...(mode === 'activity'
        ? {
            retainAll: true,
            finalize({ chunks }: { chunks: AsyncIterable<JsonValue[]> }) {
              // Evidence is found through the full participant list, then projected for delivery.
              async function* records() {
                for await (const chunk of chunks)
                  for (const filing of chunk)
                    for (const evidence of lobbyistEvidence(
                      [FilingSchema.parse(filing)],
                      String(f.lobbyist_id),
                      f.covered_positions_only === true,
                    ))
                      yield JsonValueSchema.parse({
                        ...evidence,
                        activity: projectActivity(
                          JsonValueSchema.parse(evidence.activity),
                          f.include,
                        ),
                      });
              }
              return Promise.resolve({ records: records() });
            },
          }
        : {}),
      buildResponse: (w, _metadata, stored) => ({
        ...envelope(
          w,
          f,
          'No lobbyist evidence matched the completed scope; use uslobbying_search_lobbyists mode search to resolve the name, then mode activity with its lobbyist_id and a filing_year.',
          stored,
          resolved.delivery_limits,
        ),
        mode,
        ...(mode === 'search' ? { lobbyists: w.records } : { evidence: w.records }),
      }),
    });
    return Output.parse(result.response);
  },
  format: formatResult,
});
