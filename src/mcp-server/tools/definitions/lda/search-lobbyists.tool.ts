/** @fileoverview Resolve lobbyist identities and filing-scoped activity evidence. @module mcp-server/tools/definitions/lda/search-lobbyists.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { formatResult } from '@/domain/format.js';
import { JsonValueSchema } from '@/domain/json.js';
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
  invalid,
  outputObject,
  provenance,
  recordOutput,
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
    activity: LobbyingActivitySchema.describe('Complete matched activity.'),
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
  recordOutput,
]);
/** Find identities before requesting filing-scoped covered-position evidence. */
export const searchLobbyists = tool(NAME, {
  description:
    'Find lobbyists by name or registrant in mode search, then retrieve filing-scoped evidence with mode activity, lobbyist_id and filing_year. Covered positions are disclosed text, not verified present employment. Activity mode locally checks the requested lobbyist to prevent attributing another participant’s disclosure. Follow next_cursor for all results.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.strictObject({
    ...commonInput,
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
    client_id: id.optional().describe('Optional activity client relationship scope.'),
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
    const mode = f.mode ?? 'search';
    f.mode = mode;
    if (mode !== 'search' && mode !== 'activity') invalid('mode must be search or activity.');
    if (
      mode === 'search' &&
      (f.lobbyist_id !== undefined ||
        f.filing_year !== undefined ||
        f.client_id !== undefined ||
        f.covered_positions_only !== undefined)
    )
      invalid('Activity selectors cannot be used in identity search.');
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
    const native: Record<string, string | number | boolean> = {
      page_size: Number(f.page_size ?? 25),
    };
    for (const key of mode === 'search'
      ? ['registrant_name', 'registrant_id']
      : ['lobbyist_id', 'filing_year', 'client_id']) {
      const value = f[key];
      if (typeof value === 'string' || typeof value === 'number') native[key] = value;
    }
    if (typeof f.name === 'string') native.lobbyist_name = f.name;
    if (f.covered_positions_only === true) native.lobbyist_covered_position_indicator = true;
    const upstream = source(mode === 'search' ? 'lobbyists' : 'filings', [native]);
    const result = await acquire(ctx, {
      tool: NAME,
      scanKind: String(mode),
      filters: f,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.max_pages ? { maxPages: input.max_pages } : {}),
      provenance: provenance(f),
      source: upstream,
      ...(mode === 'activity'
        ? {
            retainAll: true,
            finalize({
              chunks,
            }: {
              chunks: AsyncIterable<import('@/domain/json.js').JsonValue[]>;
            }) {
              async function* records() {
                for await (const chunk of chunks)
                  for (const filing of chunk)
                    for (const evidence of lobbyistEvidence(
                      [FilingSchema.parse(filing)],
                      String(f.lobbyist_id),
                      f.covered_positions_only === true,
                    ))
                      yield JsonValueSchema.parse(evidence);
              }
              return Promise.resolve({ records: records() });
            },
            identifyFinal: (row: import('@/domain/json.js').JsonValue) => {
              const r = Evidence.parse(row);
              return JSON.stringify([r.filing_uuid, r.activity_index, r.lobbyist_index]);
            },
          }
        : {}),
      buildResponse: (w, _metadata, stored) => ({
        ...envelope(
          w,
          f,
          'No lobbyist evidence matched the completed scope; use uslobbying_search_lobbyists mode search to resolve the name, then mode activity with its lobbyist_id and a filing_year.',
          stored,
        ),
        mode,
        ...(mode === 'search' ? { lobbyists: w.records } : { evidence: w.records }),
      }),
    });
    return Output.parse(result.response);
  },
  format: formatResult,
});
