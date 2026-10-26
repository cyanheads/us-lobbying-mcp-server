/** @fileoverview JSON-safe values and lossless source-edge identifiers. @module domain/json */
import { z } from '@cyanheads/mcp-ts-core';

/** JSON values preserve unknown source fields without accepting undefined or nonfinite numbers. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
/** Reject prototype keys before Zod can silently discard them from JSON objects. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.preprocess(
    (value, ctx) => {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.hasOwn(value, '__proto__')
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Source JSON contains an unsupported prototype key.',
        });
      }
      return value;
    },
    z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(JsonValueSchema),
      z.record(z.string(), JsonValueSchema),
    ]),
  ),
);
/** Canonical identifier representation in consumer-facing normalized records. */
export const IdSchema = z
  .string()
  .regex(/^\d+$/)
  .describe('Digit-string identifier; leading zeroes are meaningful.');
/** Wire IDs may be safe integers; unsafe numeric IDs are rejected before conversion. */
export const SourceIdSchema = z
  .union([IdSchema, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .describe('Lossless upstream digit string or safe nonnegative integer.');
/** Validate and convert a source ID, preserving all digits in source strings; throws on any other value. */
export function normalizeSourceId(value: unknown): string {
  return String(SourceIdSchema.parse(value));
}
/** Blank optional form inputs mean absent; names otherwise retain literal spelling. */
export function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === '' ? undefined : normalized;
}
/** Normalize optional reference codes independently of free text. */
export function optionalCode(value: string | undefined): string | undefined {
  return optionalText(value)?.toUpperCase();
}
/** Normalize optional enumerated modes and UUID casing. */
export function optionalLowercase(value: string | undefined): string | undefined {
  return optionalText(value)?.toLowerCase();
}
