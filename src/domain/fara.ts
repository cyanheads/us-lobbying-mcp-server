/** @fileoverview Endpoint-specific FARA wire and normalized record contracts. @module domain/fara */
import { z } from '@cyanheads/mcp-ts-core';
import { IdSchema, JsonValueSchema, SourceIdSchema } from './json.js';

const text = z.string().nullable().optional();
const addressFields = {
  ADDRESS_1: text.describe('Source address line one.'),
  ADDRESS_2: text.describe('Source address line two.'),
  CITY: text.describe('Source city.'),
  STATE: text.describe('Source state.'),
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
    FP_NAME: z.string().describe('Foreign principal name.'),
    REG_DATE: text.describe('Raw registrant date.'),
    FP_REG_DATE: text.describe('Raw principal date.'),
    REGISTRANT_NAME: text.describe('Registrant name.'),
    COUNTRY_NAME: text.describe('Represented country/location label.'),
    ...addressFields,
  })
  .catchall(JsonValueSchema);
/** Live short-form wire fields. */
export const FaraShortFormWireSchema = z
  .object({
    REG_NUMBER: SourceIdSchema.describe('Registration number.'),
    SF_FIRST_NAME: text.describe('Individual first name.'),
    SF_LAST_NAME: z.string().describe('Individual last name.'),
    SHORTFORM_DATE: text.describe('Raw short-form date.'),
    REG_DATE: text.describe('Raw registrant date.'),
    REGISTRANT_NAME: text.describe('Registrant name.'),
    ...addressFields,
  })
  .catchall(JsonValueSchema);
/** Returned document URLs are authoritative; never synthesize PDF paths. */
export const FaraDocumentWireSchema = z
  .object({
    REGISTRATION_NUMBER: SourceIdSchema.describe('Registration number.'),
    DOCUMENT_TYPE: z.string().describe('Source document type.'),
    URL: z.string().describe('Returned official document URL.'),
    DATE_STAMPED: text.describe('Raw stamped date.'),
    REGISTRANT_NAME: text.describe('Registrant name.'),
    SHORT_FORM_NAME: text.describe('Related individual name.'),
    FOREIGN_PRINCIPAL_NAME: text.describe('Related principal name.'),
    FOREIGN_PRINCIPAL_COUNTRY: text.describe('Related principal country/location.'),
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
