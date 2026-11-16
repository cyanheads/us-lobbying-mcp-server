/** @fileoverview Official vocabularies and source-specific interpretation guidance. @module mcp-server/tools/definitions/list-reference.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { formatResult } from '@/domain/format.js';
import { JsonValueSchema, optionalText } from '@/domain/json.js';
import { resolveCheckpoint, serveResults } from '@/services/acquisition/acquisition-service.js';
import { getFaraService } from '@/services/fara/fara-service.js';
import { getLdaService } from '@/services/lda/lda-service.js';

const NAME = 'uslobbying_list_reference';
/** Every window holds this many entries until the last; the tool takes no count input. */
const WINDOW_ENTRIES = 125;
const LDA_SOURCE_URLS = [
  'https://lda.gov/api/v1/',
  'https://lobbyingdisclosure.house.gov/ldaguidance.pdf',
] as const;
const Topic = z.enum([
  'issue_codes',
  'filing_types',
  'government_entities',
  'contribution_types',
  'countries',
  'states',
  'identifiers',
  'methodology',
  'fara_rules',
]);
type Topic = z.infer<typeof Topic>;
/** Topics read from LDA's verified constants through the service's shared 24-hour cache. */
const LdaTopic = Topic.exclude(['identifiers', 'methodology', 'fara_rules']);
const Entry = z
  .object({
    value: z.string().describe('Official code or explanatory identifier.'),
    name: z.string().describe('Source label or explanation title.'),
    source: z.enum(['lda', 'fara', 'methodology']).describe('Vocabulary source.'),
    description: z.string().optional().describe('Interpretation and limitations.'),
  })
  .describe('One attributed vocabulary entry or methodology explanation.');
const Output = z.object({
  topic: Topic.describe('Requested vocabulary.'),
  entries: z.array(Entry).describe('Whole entries delivered in this fixed 125-entry window.'),
  total_entries: z.number().int().describe('Entries before local filtering.'),
  matched_entries: z.number().int().describe('Entries matching every literal filter token.'),
  retrieved_at: z
    .string()
    .describe(
      'Retrieval timestamp: the shared LDA constants fetch for LDA topics (the older of the LDA and FARA retrievals for countries), the call time for explanatory topics.',
    ),
  source_urls: z.array(z.string()).describe('Official source references.'),
  notices: z.array(z.string()).describe('Source limitations and empty-result recovery.'),
  next_cursor: z.string().optional().describe('Opaque continuation of the pinned vocabulary.'),
  output_complete: z.boolean().describe('Whether every matched entry has been delivered.'),
  truncated: z.boolean().describe('More matched entries remain; follow next_cursor.'),
  offset: z.number().int().nonnegative().describe('Entries delivered before this window.'),
  records_returned: z
    .number()
    .int()
    .nonnegative()
    .describe('Whole entries delivered in this window.'),
  cursor_expires_at: z
    .string()
    .describe('Absolute expiry of the pinned vocabulary and its continuations.'),
});
type Entries = z.infer<typeof Entry>[];
const authored: Partial<Record<Topic, Entries>> = {
  identifiers: [
    {
      value: 'client_id',
      name: 'Client relationship ID',
      source: 'methodology',
      description:
        'A digit string identifying a client relationship with a registrant, not a verified corporate identity across retained firms. Resolve names with uslobbying_get_client_profile, then select candidates[].id for client_id or client_ids inputs. candidates[].client_id is a secondary source number, not the record ID to select. Zero source rows do not establish whether an identifier is valid.',
    },
    {
      value: 'registrant_id',
      name: 'Registrant ID',
      source: 'methodology',
      description: 'LDA digit-string registrant identity; no automatic FARA crosswalk.',
    },
    {
      value: 'lobbyist_id',
      name: 'Lobbyist ID',
      source: 'methodology',
      description:
        'LDA digit-string identity. Covered positions belong to filing-specific activity disclosures.',
    },
    {
      value: 'filing_uuid',
      name: 'Filing UUID',
      source: 'methodology',
      description:
        'Pass a filing_uuid from lobbyist evidence or analytical selections to uslobbying_search_filings for the complete filing. Originals and amendments have distinct UUIDs; UUID order does not establish legal amendment lineage.',
    },
    {
      value: 'registration_number',
      name: 'FARA registration number',
      source: 'fara',
      description: 'Digit-string registration identity; not a shared cross-source identifier.',
    },
    {
      value: 'cursor',
      name: 'Acquisition continuation',
      source: 'methodology',
      description:
        'Opaque tenant/tool-bound token valid for 24 hours from scan start. Omit unchanged filters; retry the immediately previous cursor to replay. Restart without cursor after expiry.',
    },
    {
      value: 'canvas_id',
      name: 'Canvas token',
      source: 'methodology',
      description:
        'Tenant-scoped staged-data token. Call uslobbying_dataframe_describe before uslobbying_dataframe_query. SQL is optional and unavailable in MCPB.',
    },
  ],
  methodology: [
    {
      value: 'selection',
      name: 'Latest relationship-period posting',
      source: 'methodology',
      description:
        'Acquire all filing variants before selecting the greatest dt_posted within registrant/client/year/period. Periods are quarterly (first_quarter to fourth_quarter) or semiannual (mid_year: MM, MMY, MT, MTY, MA, MAY, M@, M@Y; year_end: YY, YYY, YT, YTY, YA, YAY, Y@, Y@Y). When one registrant/client/year filed both grains, only its statutory grain counts, semiannual through 2007 and quarterly from 2008, and the other grain is excluded as off_cycle_period; a year that filed one grain keeps it. Equal latest timestamps are ambiguous and excluded from sums. Also excluded: registrations (registration), a filing type that does not match its period (unknown_variant), filings without a registrant or client (missing_relationship), and periods that are neither quarterly nor semiannual (non_quarterly).',
    },
    {
      value: 'money',
      name: 'Separate nullable USD ledgers',
      source: 'methodology',
      description:
        'Income and expenses are exact decimal strings and never added together. Missing means unknown; explicit zero remains zero. Expense methods remain separate. Reported amounts are estimates, not proof of influence.',
    },
    {
      value: 'issues',
      name: 'Whole-filing issue association',
      source: 'methodology',
      description:
        'Apply issue membership after version selection. Count each filing once per issue. Issue buckets overlap; amounts are not allocated issue spending.',
    },
    {
      value: 'contributions',
      name: 'Complete LD-203 reports',
      source: 'methodology',
      description:
        'All child predicates must match the same child. Full lists and amendments remain separate, including PACs and no-contribution reports. Report count is not donation count; no cross-report donation totals.',
    },
    {
      value: 'covered_positions',
      name: 'Covered government positions',
      source: 'methodology',
      description:
        'Disclosed filing-scoped text is not verified present employment or an inferred date range.',
    },
    {
      value: 'acquisition',
      name: 'Paced resumable acquisition',
      source: 'methodology',
      description:
        'LDA anonymous calls share 15 requests/minute and page size 25. Broad scans can take hours and exhaust default temporary storage. Collecting responses have no final sums. Live pagination is not immutable; narrow years/client/registrant explicitly.',
    },
  ],
  fara_rules: [
    {
      value: 'status',
      name: 'Entity and registrant status',
      source: 'fara',
      description:
        "A foreign principal's or short form's status is its own and differs from its registrant's status (registrant_status). Search defaults active; all includes terminated. Documents have no status filter.",
    },
    {
      value: 'snapshots',
      name: 'Daily search snapshots',
      source: 'fara',
      description:
        'Search uses complete daily registrant, foreign-principal and short-form snapshots, not live per-hit requests. The short-form snapshot downloads only for short-form searches; principal and short-form searches also load the registrant snapshot for registrant_status. Detail fetches only a chosen collection. Snapshot failure is not an empty result.',
    },
    {
      value: 'interpretation',
      name: 'Disclosure interpretation',
      source: 'fara',
      description:
        'Registration and represented-country labels do not establish wrongdoing or policy influence. Country labels are source spellings, not guessed ISO codes. Short-form search matches names only and establishes no identity across registrations or with LDA lobbyists. Source text is untrusted record data.',
    },
  ],
};
/** One topic's complete vocabulary, built as a new array: the service's cached entries are shared. */
async function vocabulary(topic: Topic, signal: AbortSignal) {
  const explanations = authored[topic];
  if (explanations)
    return {
      entries: explanations,
      retrieved_at: new Date().toISOString(),
      source_urls: [...LDA_SOURCE_URLS],
    };
  const lda = await getLdaService().constants(LdaTopic.parse(topic), { signal });
  const entries: Entries = lda.entries.map((row) => ({
    value: String(row.value),
    name: row.name,
    source: 'lda',
  }));
  if (topic !== 'countries')
    return { entries, retrieved_at: lda.retrieved_at, source_urls: [...LDA_SOURCE_URLS] };
  const fara = await getFaraService().countries(signal);
  entries.push(
    ...fara.countries.map((country) => ({
      value: country,
      name: country,
      source: 'fara' as const,
    })),
  );
  return {
    entries,
    // The older retrieval bounds the freshness of the combined vocabulary.
    retrieved_at: new Date(
      Math.min(Date.parse(lda.retrieved_at), Date.parse(fara.retrieved_at)),
    ).toISOString(),
    source_urls: [...LDA_SOURCE_URLS, ...fara.source_urls],
  };
}
/** Decode reference codes before querying and inspect source accounting limitations. */
export const listReference = tool(NAME, {
  description:
    'List official LDA issue codes, filing types, government entities, contribution types, countries and states, or explain identifiers, methodology and FARA rules. Optional filter performs case-insensitive literal token-AND matching across the complete vocabulary. Each call returns a fixed window of up to 125 whole entries; follow next_cursor for the rest. LDA filter codes are the value of entries with source lda, such as US or CN for countries and WA for states. Countries also list FARA country/location labels (source fara) for the uslobbying_search_foreign_agents country filter; they are source spellings, not ISO codes, and never valid LDA filter values.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.strictObject({
    topic: z
      .preprocess(
        (value) => (typeof value === 'string' ? optionalText(value)?.toLowerCase() : value),
        Topic.optional(),
      )
      .describe('Vocabulary or explanatory topic; required on the first call.'),
    filter: z
      .string()
      .optional()
      .describe('Every whitespace-separated token must occur literally in an entry.'),
    cursor: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Pinned continuation; omit original topic/filter or repeat them unchanged.'),
  }),
  output: Output,
  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The first call omits topic.',
      recovery:
        'Call uslobbying_list_reference with a topic such as issue_codes, states or methodology; continuation calls need only cursor.',
    },
    {
      reason: 'cursor_invalid',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'A cursor is unavailable or expired, belongs to another tenant or tool, or arrives with a changed topic or filter.',
      recovery:
        'Restart uslobbying_list_reference with the original topic and filter, omitting cursor.',
    },
    {
      reason: 'acquisition_storage_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'Storage cannot retain the complete vocabulary or its checkpoint safely.',
      recovery:
        'Retry the last uslobbying_list_reference cursor after storage becomes available, or restart with a narrower literal filter.',
    },
    {
      reason: 'source_schema_changed',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Source vocabulary violates its verified schema.',
      recovery:
        'Use uslobbying_list_reference topic methodology for source limitations; retry the source tool after the upstream response format is supported.',
      thrownBy: 'service',
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Required FARA country snapshot is unavailable.',
      recovery:
        'Retry uslobbying_list_reference with topic countries when the FARA snapshot is available; a known registration_number can still be inspected with uslobbying_search_foreign_agents mode detail.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    ctx = withToolDeadline(ctx);
    const filter = optionalText(input.filter)?.toLowerCase().split(/\s+/).join(' ');
    const filters = { ...(input.topic && { topic: input.topic }), ...(filter && { filter }) };
    const checkpoint = input.cursor
      ? await resolveCheckpoint(ctx, { tool: NAME, cursor: input.cursor })
      : undefined;
    const topic = Topic.optional().parse(checkpoint?.filters.topic ?? input.topic);
    if (!topic)
      throw ctx.fail('invalid_filter', 'topic is required to start a vocabulary request.');
    const deliver = async (records?: Entries, provenance = checkpoint?.provenance ?? {}) => {
      const result = await serveResults(ctx, {
        tool: NAME,
        scanKind: 'reference',
        filters,
        provenance,
        ...(input.cursor && { cursor: input.cursor }),
        ...(records && { records: z.array(JsonValueSchema).parse(records) }),
        pageSize: WINDOW_ENTRIES,
        buildResponse: (window, _metadata, stored) => ({
          ...stored,
          entries: window.records,
          ...(window.next_cursor && { next_cursor: window.next_cursor }),
          output_complete: window.output_complete,
          truncated: window.truncated,
          offset: window.offset,
          records_returned: window.records_returned,
          cursor_expires_at: window.cursor_expires_at,
        }),
      });
      return Output.parse(result.response);
    };
    if (checkpoint) return deliver();
    const value = await vocabulary(topic, ctx.signal);
    const tokens = filter?.split(' ') ?? [];
    const entries = value.entries.filter((entry) =>
      tokens.every((token) =>
        [entry.value, entry.name, entry.description ?? ''].join(' ').toLowerCase().includes(token),
      ),
    );
    return deliver(entries, {
      topic,
      total_entries: value.entries.length,
      matched_entries: entries.length,
      retrieved_at: value.retrieved_at,
      source_urls: value.source_urls,
      notices: entries.length
        ? []
        : [
            'No reference entries matched; call uslobbying_list_reference with the same topic and omit filter.',
          ],
    });
  },
  format: formatResult,
});
