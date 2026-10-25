/** @fileoverview Synthetic Latin-1 FARA transport fixtures, never live source data. @module tests/services/fara/fixtures */
import { Buffer } from 'node:buffer';
import { zipSync } from 'fflate';
import { vi } from 'vitest';

/** Encode actual ISO-8859-1 bytes, including the C1 range. */
export function latin1(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}
/** Package a selected complete XML snapshot; CSV is deliberately unusable. */
export function snapshotResponse(
  kind: 'registrants' | 'foreign_principals',
  rows: string,
): Response {
  const noun = kind === 'registrants' ? 'Registrants' : 'ForeignPrincipals';
  const root = kind === 'registrants' ? 'REGISTRANTS' : 'FOREIGNPRINCIPALS';
  return xmlResponse(noun, `<${root}>${rows}</${root}>`);
}
/** Build a tiny real ZIP with the required XML member and misleading CSV. */
export function xmlResponse(noun: string, xml: string): Response {
  return new Response(
    new Uint8Array(
      zipSync({
        [`FARA_All_${noun}.xml`]: latin1(xml),
        [`FARA_All_${noun}.csv`]: latin1('"unclosed,broken\r\n'),
      }),
    ),
    { headers: { 'last-modified': 'Sat, 24 Oct 2026 12:00:00 GMT' } },
  );
}
/** Minimal snapshot row with caller-supplied raw extension fields. */
export function registrant(id: string, name: string, termination = '', extra = ''): string {
  return `<ROW><Registration_Number>${id}</Registration_Number><Name>${name}</Name><Registration_Date>02/29/2024</Registration_Date><Termination_Date>${termination}</Termination_Date>${extra}</ROW>`;
}
/** Principal status belongs to the principal, independently of the registrant. */
export function principal(id: string, name: string, country = 'Canada', termination = ''): string {
  return `<ROW><Registration_number>${id}</Registration_number><Foreign_principal>${name}</Foreign_principal><Registrant_name>Synthetic firm</Registrant_name><Country_location_represented>${country}</Country_location_represented><FP_registration_date>2024-02-29T00:00:00</FP_registration_date><FP_termination_date>${termination}</FP_termination_date></ROW>`;
}
/** Observe rejection immediately, then advance only fake scheduler time. */
export async function settle<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  const observed = pending.then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    },
  );
  for (let ticks = 0; !settled && ticks < 600; ticks++) await vi.advanceTimersByTimeAsync(100);
  if (!settled) throw new Error('Synthetic operation exceeded its bounded test deadline');
  const result = await observed;
  if ('error' in result) throw result.error;
  return result.value;
}
