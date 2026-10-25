/** @fileoverview Official vocabularies and source-specific interpretation guidance. @module mcp-server/tools/definitions/list-reference.tool */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { SOURCE_CACHE_TTL_MS } from '@/domain/contracts.js';
import { formatResult } from '@/domain/format.js';
import { getFaraService } from '@/services/fara/fara-service.js';
import { getLdaService } from '@/services/lda/lda-service.js';

const Topic = z.enum([
  'issue_codes',
  'filing_types',
  'government_entities',
  'contribution_types',
  'countries',
  'identifiers',
  'methodology',
  'fara_rules',
]);
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
  entries: z.array(Entry).describe('Complete locally filtered vocabulary.'),
  total_entries: z.number().int().describe('Entries before local filtering.'),
  matched_entries: z.number().int().describe('Entries matching every literal filter token.'),
  retrieved_at: z.string().describe('Vocabulary retrieval timestamp.'),
  source_urls: z.array(z.string()).describe('Official source references.'),
  notices: z.array(z.string()).describe('Source limitations and empty-result recovery.'),
});
type Entries = z.infer<typeof Entry>[];
const cache = new Map<
  string,
  { expires: number; entries: Entries; retrieved_at: string; source_urls: string[] }
>();
const authored: Record<string, Entries> = {
  identifiers: [
    {
      value: 'client_id',
      name: 'Client relationship ID',
      source: 'methodology',
      description:
        'A digit string identifying a client relationship with a registrant, not a verified corporate identity across retained firms. Resolve names, then select IDs explicitly.',
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
        'Originals and amendments have distinct UUIDs. UUID order does not establish legal amendment lineage.',
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
      value: 'record_handle',
      name: 'Deferred complete parent',
      source: 'methodology',
      description:
        'Use the same source tool with record_handle and JSON Pointer record_path; continue record_offset until complete. Exclusive with query filters and cursor.',
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
        'Acquire all filing variants before selecting greatest dt_posted within registrant/client/year/quarter. Equal latest timestamps are ambiguous and excluded from sums. Registration, unknown variants and non-quarterly periods are excluded.',
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
        'Principal status differs from registrant status. Search defaults active; all includes terminated. Documents have no status filter.',
    },
    {
      value: 'snapshots',
      name: 'Daily search snapshots',
      source: 'fara',
      description:
        'Search uses complete daily snapshots, not live per-hit requests. Detail fetches only a chosen collection. Snapshot failure is not an empty result.',
    },
    {
      value: 'interpretation',
      name: 'Disclosure interpretation',
      source: 'fara',
      description:
        'Registration and represented-country labels do not establish wrongdoing or policy influence. Country labels are source spellings, not guessed ISO codes. Source text is untrusted record data.',
    },
  ],
};
/** Decode reference codes before querying and inspect source accounting limitations. */
export const listReference = tool('uslobbying_list_reference', {
  description:
    'List official issue codes, filing types, government entities, contribution types and countries, or explain identifiers, methodology and FARA rules. Optional filter performs case-insensitive literal token-AND matching across the complete vocabulary. Countries include separately attributed LDA codes and FARA source labels; FARA labels are not guessed ISO codes.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.strictObject({
    topic: Topic.describe('Vocabulary or explanatory topic.'),
    filter: z
      .string()
      .optional()
      .describe('Every whitespace-separated token must occur literally in an entry.'),
  }),
  output: Output,
  errors: [
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
    let value = cache.get(input.topic);
    if (!value || value.expires <= Date.now()) {
      let entries: Entries;
      const source_urls = [
        'https://lda.gov/api/v1/',
        'https://lobbyingdisclosure.house.gov/ldaguidance.pdf',
      ];
      let retrieved_at = new Date().toISOString();
      const explanations = authored[input.topic];
      if (explanations) entries = explanations;
      else {
        const constants = await getLdaService().constants(
          z
            .enum([
              'issue_codes',
              'filing_types',
              'government_entities',
              'contribution_types',
              'countries',
            ])
            .parse(input.topic),
          {
            signal: ctx.signal,
          },
        );
        entries = constants.map((row) => ({
          value: String(row.value),
          name: row.name,
          source: 'lda',
        }));
        if (input.topic === 'countries') {
          const fara = await getFaraService().countries(ctx.signal);
          entries.push(
            ...fara.countries.map((country) => ({
              value: country,
              name: country,
              source: 'fara' as const,
            })),
          );
          source_urls.push(...fara.source_urls);
          retrieved_at = fara.retrieved_at;
        }
      }
      value = { expires: Date.now() + SOURCE_CACHE_TTL_MS, entries, retrieved_at, source_urls };
      cache.set(input.topic, value);
    }
    const tokens = input.filter?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const entries = value.entries.filter((entry) =>
      tokens.every((token) =>
        [entry.value, entry.name, entry.description ?? ''].join(' ').toLowerCase().includes(token),
      ),
    );
    return {
      topic: input.topic,
      entries,
      total_entries: value.entries.length,
      matched_entries: entries.length,
      retrieved_at: value.retrieved_at,
      source_urls: value.source_urls,
      notices: entries.length
        ? []
        : [
            'No reference entries matched; call uslobbying_list_reference with the same topic and omit filter.',
          ],
    };
  },
  format: formatResult,
});
