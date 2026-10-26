/** @fileoverview Sparse LDA wire contracts retaining every unknown JSON field once. @module domain/lda */
import { z } from '@cyanheads/mcp-ts-core';
import { IdSchema, JsonValueSchema, normalizeSourceId } from './json.js';

const text = z.string().nullable().optional();
/** Disclosed government entity identifiers are normalized like other source identities. */
export const GovernmentEntitySchema = z
  .object({
    id: IdSchema.optional().describe('Official entity ID.'),
    name: text.describe('Source entity name.'),
  })
  .catchall(JsonValueSchema)
  .describe('Disclosed government entity.');
/** Official attribution accompanies all LDA data responses. */
export const LDA_ATTRIBUTION =
  'Senate Office of Public Records cannot vouch for the data or analyses derived from these data after the data have been retrieved from LDA.gov.';
/** Registrant relationship identity; sparse contact/address fields remain in the record. */
export const RegistrantSchema = z
  .object({
    id: IdSchema.describe('Registrant identifier.'),
    name: z.string().describe('Source registrant name.'),
    description: text.describe('Reported business description.'),
    house_registrant_id: IdSchema.nullable().optional().describe('House identifier when supplied.'),
  })
  .catchall(JsonValueSchema)
  .describe('Registrant relationship and disclosures.')
  .meta({ id: 'LdaRegistrant' });
/** Client IDs identify a registrant relationship, not a merged corporate entity. */
export const ClientSchema = z
  .object({
    id: IdSchema.describe(
      'Client relationship record ID; select candidates[].id for client_id or client_ids inputs.',
    ),
    client_id: IdSchema.nullable()
      .optional()
      .describe(
        'Source secondary client number; do not select candidates[].client_id for client filters.',
      ),
    name: z.string().describe('Literal client name.'),
    general_description: text.describe('Reported client description.'),
    effective_date: text.describe('Source effective date.'),
    country: text.describe('Source country code.'),
    state: text.describe('Source jurisdiction code.'),
    registrant: RegistrantSchema.optional().describe('Registrant embedded by client search.'),
  })
  .catchall(JsonValueSchema)
  .describe('Complete client relationship.')
  .meta({ id: 'LdaClient' });
/** Lobbyist identity; covered positions belong to filing activity membership instead. */
export const LobbyistSchema = z
  .object({
    id: IdSchema.describe('Lobbyist identifier.'),
    first_name: text.describe('Source first name.'),
    middle_name: text.describe('Source middle name.'),
    last_name: text.describe('Source last name.'),
    registrant: RegistrantSchema.optional().describe('Registrant embedded by identity search.'),
  })
  .catchall(JsonValueSchema)
  .describe('Disclosed lobbyist identity.')
  .meta({ id: 'LdaLobbyist' });
/** Filing-scoped participant and covered-position disclosure. */
export const ActivityLobbyistSchema = z
  .object({
    lobbyist: LobbyistSchema.omit({ registrant: true }).describe(
      'Filing identity; registrant comes from the parent. All source fields are retained.',
    ),
    covered_position: text.describe('Reported covered-position text, not verified employment.'),
    new: z.boolean().nullable().optional().describe('Source new-lobbyist flag.'),
  })
  .catchall(JsonValueSchema)
  .describe('Filing-scoped lobbyist participation.')
  .meta({ id: 'LdaActivityLobbyist' });
/** Activity has no money amount; filing amounts must never be multiplied by activity joins. */
export const LobbyingActivitySchema = z
  .object({
    general_issue_code: z.string().describe('Official general issue code.'),
    description: text.describe('Complete specific-issues description.'),
    foreign_entity_issues: text.describe('Disclosed foreign issues.'),
    lobbyists: z.array(ActivityLobbyistSchema).optional().describe('All disclosed participants.'),
    government_entities: z
      .array(GovernmentEntitySchema)
      .optional()
      .describe('All targeted government entities.'),
  })
  .catchall(JsonValueSchema)
  .describe('Complete reported lobbying activity.')
  .meta({ id: 'LdaLobbyingActivity' });
/** Derived activity identity is shared by analytical output and SQL staging. */
export const ActivityRowSchema = LobbyingActivitySchema.extend({
  filing_uuid: z.string().describe('Parent filing UUID.'),
  activity_index: z.number().int().describe('Original activity index.'),
  client_id: z.string().describe('Client relationship ID.'),
  registrant_id: z.string().describe('Registrant ID.'),
}).describe('Selected activity and parent relationship IDs.');
/** One derived activity row with a stable parent and array position. */
export type ActivityRow = z.infer<typeof ActivityRowSchema>;
/** Decimal USD source amounts; null means unknown, distinct from explicit zero. */
export const MoneySchema = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,2})?$/)
  .nullable()
  .describe('Exact decimal USD amount or unknown null.');
const filingFields = {
  filing_uuid: z.string().uuid().describe('Filing UUID.'),
  filing_type: z.string().describe('Official filing type, including amendments.'),
  filing_year: z.number().int().describe('Reported filing year.'),
  filing_period: z.string().describe('Source quarterly or semiannual period.'),
  dt_posted: z.iso
    .datetime({ offset: true })
    .describe('Source posting timestamp used in analytical selection.'),
  filing_document_url: text.describe('Official filing-document URL.'),
  filing_document_content_type: text.describe('Source document media type.'),
  registrant: RegistrantSchema.nullable().optional().describe('Reported registrant.'),
};
/** Complete filing representation with typed analytical fields and lossless unknown disclosures. */
export const FilingSchema = z
  .object({
    ...filingFields,
    client: ClientSchema.nullable().optional().describe('Reported client relationship.'),
    income: MoneySchema.optional().describe('Reported income in USD.'),
    expenses: MoneySchema.optional().describe('Reported expenses in USD.'),
    expenses_method: text.describe('Expense accounting method, kept separate in ledgers.'),
    lobbying_activities: z
      .array(LobbyingActivitySchema)
      .optional()
      .describe('Complete activities.'),
    conviction_disclosures: z
      .array(JsonValueSchema)
      .optional()
      .describe('Complete conviction disclosures.'),
    foreign_entities: z.array(JsonValueSchema).optional().describe('Complete foreign entities.'),
    affiliated_organizations: z.array(JsonValueSchema).optional().describe('Complete affiliates.'),
  })
  .catchall(JsonValueSchema)
  .describe('Complete filing and unknown disclosures.')
  .meta({ id: 'LdaFiling' });
/** Contribution child retains membership and repeated identical items. */
export const ContributionItemSchema = z
  .object({
    contribution_type: text.describe('Source payment category.'),
    contributor_name: text.describe('Disclosed contributor.'),
    payee_name: text.describe('Disclosed payee.'),
    honoree_name: text.describe('Disclosed honoree.'),
    amount: MoneySchema.optional().describe('Exact reported USD amount.'),
    date: text.describe('Reported contribution calendar date.'),
  })
  .catchall(JsonValueSchema)
  .describe('One contribution item within its parent report.');
/** Complete LD-203 report; amendments remain separate parent reports. */
export const ContributionReportSchema = z
  .object({
    ...filingFields,
    filer_type: text.describe('Source filer category.'),
    lobbyist: LobbyistSchema.nullable().optional().describe('Reported lobbyist filer.'),
    no_contributions: z
      .boolean()
      .nullable()
      .optional()
      .describe('Source no-contribution declaration.'),
    comments: text.describe('Complete source comments.'),
    pacs: z.array(JsonValueSchema).optional().describe('All disclosed PAC relationships.'),
    contribution_items: z
      .array(ContributionItemSchema)
      .describe('Complete child list, never a filtered subset.'),
    matched_item_indexes: z
      .array(z.number().int().nonnegative())
      .optional()
      .describe('Derived indexes satisfying all local child predicates.'),
  })
  .catchall(JsonValueSchema)
  .describe('Complete contribution report and child lists.');
/** Generic verified LDA list envelope; select the noun schema at the request boundary. */
export function ldaPageSchema<T extends z.ZodType>(record: T) {
  return z
    .object({
      count: z
        .number()
        .int()
        .nonnegative()
        .describe('Upstream envelope count, not a donation count.'),
      next: z.string().nullable().describe('Untrusted next URL; validate before requesting.'),
      previous: z.string().nullable().optional().describe('Source previous URL.'),
      results: z.array(record).describe('Complete fetched source page.'),
    })
    .catchall(JsonValueSchema);
}
/** Validated LDA filing. */
export type Filing = z.infer<typeof FilingSchema>;
/** Validated client relationship. */
export type Client = z.infer<typeof ClientSchema>;
/** Validated lobbyist identity. */
export type Lobbyist = z.infer<typeof LobbyistSchema>;
/** Validated LD-203 report. */
export type ContributionReport = z.infer<typeof ContributionReportSchema>;
/** Validated registrant record. */
export type Registrant = z.infer<typeof RegistrantSchema>;
/** Constant entries retain unknown source metadata. */
export const LdaConstantSchema = z
  .object({
    value: z.union([z.string(), z.number().int().safe()]).describe('Official constant code.'),
    name: z.string().describe('Official constant label.'),
  })
  .catchall(JsonValueSchema);
const ID_KEYS = new Set(['id', 'client_id', 'house_registrant_id']);
const NESTED_KEYS = new Set([
  'results',
  'registrant',
  'client',
  'lobbyist',
  'lobbyists',
  'lobbying_activities',
  'government_entities',
  'conviction_disclosures',
]);
/** Normalize only verified identity-bearing source objects, preserving all unknown fields once. */
export function normalizeLdaRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeLdaRecord);
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    if (ID_KEYS.has(key) && child !== null) result[key] = normalizeSourceId(child);
    else if (NESTED_KEYS.has(key)) result[key] = normalizeLdaRecord(child);
    else result[key] = child;
  }
  return result;
}
