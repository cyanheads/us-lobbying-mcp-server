/** @fileoverview Endpoint-specific FARA wire and normalized record contracts. @module domain/fara */
import { z } from '@cyanheads/mcp-ts-core';
import { IdSchema, JsonValueSchema, SourceIdSchema } from './json.js';

const text = z.string().nullable().optional();
/** FARA's JSON writes an all-digit value as a number; a source text field reads it as its digits. */
const sourceString = z.union([z.string(), z.number().transform(String)]);
const sourceText = sourceString.nullable().optional();
const addressFields = {
  ADDRESS_1: sourceText.describe('Source address line one.'),
  ADDRESS_2: sourceText.describe('Source address line two.'),
  CITY: sourceText.describe('Source city.'),
  STATE: sourceText.describe('Source state.'),
  ZIP: z
    .union([z.string(), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
    .nullable()
    .optional()
    .describe('Source postal code, preserving punctuation and leading zeroes in strings.'),
};
/** Live principal wire fields, not a recursive case conversion. */
export const FaraPrincipalWireSchema = z
  .object({
    REG_NUMBER: SourceIdSchema.describe('Registration number.'),
    FP_NAME: sourceString.describe('Foreign principal name.'),
    REG_DATE: sourceText.describe('Raw registrant date.'),
    FP_REG_DATE: sourceText.describe('Raw principal date.'),
    TERMINATION_DATE: sourceText.describe('Raw principal termination date; terminated arm only.'),
    REGISTRANT_NAME: sourceText.describe('Registrant name.'),
    COUNTRY_NAME: sourceText.describe('Represented country/location label.'),
    ...addressFields,
  })
  .catchall(JsonValueSchema);
/** Live short-form wire fields. */
export const FaraShortFormWireSchema = z
  .object({
    REG_NUMBER: SourceIdSchema.describe('Registration number.'),
    SF_FIRST_NAME: sourceText.describe('Individual first name.'),
    SF_LAST_NAME: sourceString.describe('Individual last name, empty when undisclosed.'),
    SHORTFORM_DATE: sourceText.describe('Raw short-form date.'),
    SF_TERM_DATE: sourceText.describe('Raw short-form termination date; terminated arm only.'),
    REG_DATE: sourceText.describe('Raw registrant date.'),
    REGISTRANT_NAME: sourceText.describe('Registrant name.'),
    ...addressFields,
  })
  .catchall(JsonValueSchema);
/** Returned document URLs are authoritative; never synthesize PDF paths. */
export const FaraDocumentWireSchema = z
  .object({
    REGISTRATION_NUMBER: SourceIdSchema.describe('Registration number.'),
    DOCUMENT_TYPE: z.string().describe('Source document type.'),
    URL: z.string().describe('Returned official document URL.'),
    DATE_STAMPED: sourceText.describe('Raw stamped date.'),
    REGISTRANT_NAME: sourceText.describe('Registrant name.'),
    SHORT_FORM_NAME: sourceText.describe('Related individual name.'),
    FOREIGN_PRINCIPAL_NAME: sourceText.describe('Related principal name.'),
    FOREIGN_PRINCIPAL_COUNTRY: sourceText.describe('Related principal country/location.'),
  })
  .catchall(JsonValueSchema);
/** Only verified detail envelope alternatives are accepted. */
export function faraDetailEnvelopeSchema<T extends z.ZodType>(record: T) {
  return z
    .object({
      ROWSET: z
        .union([
          z.literal(''),
          z
            .object({
              ROW: z
                .union([record, z.array(record)])
                .describe('One record or complete record array.'),
            })
            .catchall(JsonValueSchema),
        ])
        .describe('Verified singleton, array or empty-string rowset.'),
    })
    .catchall(JsonValueSchema);
}
/** Normalized records retain original source spellings once inside raw, alongside derived fields. */
export const FaraRecordSchema = z
  .object({
    registration_number: IdSchema.describe('Lossless normalized registration number.'),
    name: z.string().describe('Selected entity name.'),
    entity: z
      .enum(['registrants', 'foreign_principals', 'short_forms', 'documents'])
      .describe('Record grain.'),
    status: z
      .enum(['active', 'terminated'])
      .optional()
      .describe('Selected entity status; omitted for documents.'),
    registration_date: text.describe('Normalized calendar registration date if known.'),
    termination_date: text.describe('Selected entity calendar termination date if known.'),
    registration_date_raw: text.describe('Source registration date spelling.'),
    termination_date_raw: text.describe('Source termination date spelling.'),
    registrant_name: text.describe('Related registrant name.'),
    registrant_status: z
      .enum(['active', 'terminated'])
      .optional()
      .describe('Separate registrant status when known.'),
    country: text.describe('Source represented country/location label; never guessed ISO code.'),
    first_name: text.describe('Disclosed short-form first name.'),
    last_name: text.describe('Disclosed short-form last name.'),
    document_type: text.describe('Source document classification.'),
    date_stamped: text.describe('Normalized document stamped calendar date if known.'),
    date_stamped_raw: text.describe('Original document stamped date.'),
    foreign_principal_name: text.describe('Principal named by a document.'),
    short_form_name: text.describe('Individual named by a document.'),
    listing_url: z.string().describe('Official registrant listing URL.'),
    document_url: z.string().optional().describe('Official URL returned by document source.'),
    raw: z
      .record(z.string(), JsonValueSchema)
      .describe('Complete validated source record, original keys and values.'),
  })
  .describe('FARA entity with complete original source fields.');
/** Normalized consumer-facing FARA record. */
export type FaraRecord = z.infer<typeof FaraRecordSchema>;
