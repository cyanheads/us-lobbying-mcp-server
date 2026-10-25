/** @fileoverview Fixed-host FARA snapshots and live registration collections. @module services/fara/fara-service */
import { Buffer } from 'node:buffer';
import { z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
  httpErrorFromResponse,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';
import { unzipSync } from 'fflate';
import { EXCHANGE_DEADLINE_MS, SOURCE_CACHE_TTL_MS, TOOL_DEADLINE_MS } from '@/domain/contracts.js';
import {
  FaraDocumentWireSchema,
  FaraPrincipalWireSchema,
  type FaraRecord,
  FaraShortFormWireSchema,
  faraDetailEnvelopeSchema,
} from '@/domain/fara.js';
import { IdSchema, JsonValueSchema, normalizeSourceId } from '@/domain/json.js';
import type { FaraDetail, FaraSearch, FaraSourceResult, FaraStatus } from './types.js';

const ORIGIN = 'https://efile.fara.gov';
const pacer = createPacer({
  name: 'fara',
  limits: [{ requests: 5, perMs: 10_000 }],
  minStartGapMs: 4100,
  maxConcurrent: 1,
  maxQueueDepth: 32,
  cooldown: { baseMs: 10_000, maxMs: 30_000 },
});
const xmlRow = z.record(z.string(), JsonValueSchema);
const xmlParser = new XMLParser({
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: false,
  ignoreAttributes: false,
  onDangerousProperty() {
    throw schemaFailure();
  },
});
type SnapshotKind = 'registrants' | 'foreign_principals';
interface Snapshot {
  lastModified?: string;
  records: FaraRecord[];
  retrievedAt: string;
  url: string;
}
interface Flight {
  controller: AbortController;
  promise: Promise<Snapshot>;
  waiters: number;
}
const snapshots = new Map<SnapshotKind, Snapshot>();
const flights = new Map<SnapshotKind, Flight>();

function schemaFailure(cause?: unknown): McpError {
  return new McpError(
    JsonRpcErrorCode.SerializationError,
    'FARA returned an incompatible source record or envelope.',
    { reason: 'source_schema_changed', retryable: false },
    { cause },
  );
}
function calendar(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(value);
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const result = iso
    ? `${iso[1]}-${iso[2]}-${iso[3]}`
    : us
      ? `${us[3]}-${us[1]}-${us[2]}`
      : undefined;
  if (!result) return undefined;
  const parsed = new Date(`${result}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().startsWith(result)
    ? result
    : undefined;
}
function dates(
  registration: string | null | undefined,
  termination?: string | null,
): Partial<FaraRecord> {
  const reg = calendar(registration);
  const term = calendar(termination);
  return {
    ...(registration !== undefined && { registration_date_raw: registration }),
    ...(termination !== undefined && { termination_date_raw: termination }),
    ...(reg && { registration_date: reg }),
    ...(term && { termination_date: term }),
  };
}
function listing(status: FaraStatus = 'active'): string {
  return `${ORIGIN}/api/v1/Registrants/html/${status === 'terminated' ? 'Terminated' : 'Active'}`;
}
function statusOf(raw: string): 'active' | 'terminated' {
  return raw.trim() === '' ? 'active' : 'terminated';
}
function abort(signal: AbortSignal): void {
  signal.throwIfAborted();
}
function field(raw: z.infer<typeof xmlRow>, key: string): string | undefined {
  const value = raw[key];
  if (value !== undefined && typeof value !== 'string') throw schemaFailure();
  return value;
}
function callSignal(signal: AbortSignal, deadlineAtMs: number): AbortSignal {
  abort(signal);
  const remainingMs = Math.min(TOOL_DEADLINE_MS, deadlineAtMs - Date.now());
  if (remainingMs <= 0)
    throw new McpError(JsonRpcErrorCode.Timeout, 'FARA call deadline expired.', {
      retryable: false,
    });
  return AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]);
}

/** Fixed-host source adapter. Inject fetch for deterministic transport tests. */
export class FaraService {
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }

  private request<T>(
    path: string,
    signal: AbortSignal,
    deadlineMs: number,
    parse: (bytes: Uint8Array, response: Response, signal: AbortSignal) => T | Promise<T>,
  ): Promise<T> {
    return withRetry(
      async ({ signal: attemptSignal, remainingMs }) =>
        pacer.run(
          async () => {
            const exchange = AbortSignal.any([
              attemptSignal,
              AbortSignal.timeout(Math.min(EXCHANGE_DEADLINE_MS, remainingMs)),
            ]);
            let response: Response;
            let bytes: Uint8Array;
            try {
              response = await this.fetcher(`${ORIGIN}${path}`, {
                signal: exchange,
                redirect: 'error',
                headers: { Accept: path.endsWith('.zip') ? 'application/zip' : 'application/json' },
              });
              if (!response.ok) {
                const error = await httpErrorFromResponse(response, {
                  service: 'FARA',
                  captureBody: false,
                  data: {
                    reason:
                      response.status === 429 ? 'source_rate_limited' : 'upstream_unavailable',
                    retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
                  },
                });
                throw error;
              }
              bytes = new Uint8Array(await response.arrayBuffer());
            } catch (cause) {
              if (attemptSignal.aborted) throw attemptSignal.reason;
              if (cause instanceof McpError) throw cause;
              if (
                !(cause instanceof TypeError) &&
                !exchange.aborted &&
                !(
                  cause instanceof DOMException &&
                  ['NetworkError', 'AbortError', 'TimeoutError'].includes(cause.name)
                )
              )
                throw cause;
              throw serviceUnavailable(
                'FARA network exchange failed; retry the same scope.',
                { reason: 'upstream_unavailable' },
                { cause },
              );
            }
            abort(exchange);
            return parse(bytes, response, exchange);
          },
          { signal: attemptSignal, maxWaitMs: remainingMs },
        ),
      {
        signal,
        deadlineMs,
        maxRetries: 1,
        baseDelayMs: 10_000,
        maxDelayMs: 30_000,
        operation: 'FARA source request',
        isTransient: (error) => error instanceof McpError && defaultIsTransient(error),
      },
    );
  }

  private async loadSnapshot(kind: SnapshotKind, signal: AbortSignal): Promise<Snapshot> {
    const noun = kind === 'registrants' ? 'Registrants' : 'ForeignPrincipals';
    const path = `/bulk/zip/FARA_All_${noun}.xml.zip`;
    try {
      return await this.request(path, signal, TOOL_DEADLINE_MS, (bytes, response, parseSignal) => {
        let members: ReturnType<typeof unzipSync>;
        try {
          members = unzipSync(bytes);
        } catch (cause) {
          throw schemaFailure(cause);
        }
        const member = members[`FARA_All_${noun}.xml`];
        if (!member) throw schemaFailure();
        const text = Buffer.from(member).toString('latin1');
        if (/<!DOCTYPE|<!ENTITY|<__proto__(?:\s|>|\/)/i.test(text)) throw schemaFailure();
        let parsed: unknown;
        try {
          SyntaxValidator.validate(text);
          parsed = xmlParser.parse(text);
        } catch (cause) {
          throw schemaFailure(cause);
        }
        const json = JsonValueSchema.safeParse(parsed);
        if (!json.success) throw schemaFailure(json.error);
        const rootName = kind === 'registrants' ? 'REGISTRANTS' : 'FOREIGNPRINCIPALS';
        const envelope = z
          .object({ [rootName]: z.object({ ROW: z.union([xmlRow, z.array(xmlRow)]) }) })
          .safeParse(json.data);
        if (!envelope.success) throw schemaFailure(envelope.error);
        const collection = envelope.data[rootName];
        if (!collection) throw schemaFailure();
        const rows = Array.isArray(collection.ROW) ? collection.ROW : [collection.ROW];
        const records: FaraRecord[] = [];
        for (const value of rows) {
          abort(parseSignal);
          const row = xmlRow.safeParse(value);
          if (!row.success) throw schemaFailure(row.error);
          const { '#text': layout, ...raw } = row.data;
          if (layout !== undefined && (typeof layout !== 'string' || layout.trim() !== ''))
            throw schemaFailure();
          const principal = kind === 'foreign_principals';
          const id = IdSchema.safeParse(
            raw[principal ? 'Registration_number' : 'Registration_Number'],
          );
          if (!id.success) throw schemaFailure(id.error);
          const name = field(raw, principal ? 'Foreign_principal' : 'Name');
          const termination = field(raw, principal ? 'FP_termination_date' : 'Termination_Date');
          if (name === undefined) throw schemaFailure();
          const status = termination === undefined ? 'active' : statusOf(termination);
          records.push({
            registration_number: id.data,
            name,
            entity: kind,
            status,
            ...dates(
              field(raw, principal ? 'FP_registration_date' : 'Registration_Date'),
              termination,
            ),
            ...(principal && {
              ...(field(raw, 'Registrant_name') !== undefined && {
                registrant_name: field(raw, 'Registrant_name'),
              }),
              ...(field(raw, 'Country_location_represented') !== undefined && {
                country: field(raw, 'Country_location_represented'),
              }),
            }),
            listing_url: listing(status),
            raw,
          });
        }
        const lastModified = response.headers.get('last-modified');
        return {
          records,
          retrievedAt: new Date().toISOString(),
          url: `${ORIGIN}${path}`,
          ...(lastModified !== null && { lastModified }),
        };
      });
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      if (!(cause instanceof McpError)) throw cause;
      if (
        cause.code === JsonRpcErrorCode.RateLimited ||
        cause.data?.reason === 'source_schema_changed'
      )
        throw cause;
      throw serviceUnavailable(
        'FARA snapshot could not be acquired; retry later or request detail with a known registration number.',
        { reason: 'snapshot_unavailable', retryable: false },
        { cause },
      );
    }
  }

  private async snapshot(kind: SnapshotKind, signal: AbortSignal): Promise<Snapshot> {
    abort(signal);
    const cached = snapshots.get(kind);
    if (cached && Date.now() - Date.parse(cached.retrievedAt) < SOURCE_CACHE_TTL_MS) return cached;
    let flight = flights.get(kind);
    if (!flight) {
      const controller = new AbortController();
      const created: Flight = {
        controller,
        waiters: 0,
        promise: this.loadSnapshot(kind, controller.signal),
      };
      created.promise = created.promise
        .then((value) => {
          snapshots.set(kind, value);
          return value;
        })
        .finally(() => {
          if (flights.get(kind) === created) flights.delete(kind);
        });
      flights.set(kind, created);
      flight = created;
    }
    const current = flight;
    current.waiters++;
    try {
      return await new Promise<Snapshot>((resolve, reject) => {
        const cancelled = () => reject(signal.reason);
        signal.addEventListener('abort', cancelled, { once: true });
        current.promise
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', cancelled));
      });
    } finally {
      current.waiters--;
      if (current.waiters === 0 && flights.get(kind) === current) {
        current.controller.abort();
        flights.delete(kind);
        await current.promise.catch(() => undefined);
      }
    }
  }

  /** Filter the entire selected daily snapshot; results are ready to pin into a continuation. */
  async search(
    input: FaraSearch,
    signal: AbortSignal,
    deadlineAtMs = Date.now() + TOOL_DEADLINE_MS,
  ): Promise<FaraSourceResult> {
    const scope = callSignal(signal, deadlineAtMs);
    const entity = input.entity ?? 'registrants';
    if (input.country && entity !== 'foreign_principals')
      throw validationError('Country requires foreign_principals.', { reason: 'invalid_filter' });
    const selected = await this.snapshot(entity, scope);
    const registrants =
      entity === 'foreign_principals' ? await this.snapshot('registrants', scope) : undefined;
    const byId = new Map(registrants?.records.map((row) => [row.registration_number, row.status]));
    const tokens =
      input.name_contains?.trim().toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean) ?? [];
    const status = input.status ?? 'active';
    const country = input.country?.trim().toLocaleLowerCase('en-US');
    if (
      country &&
      !selected.records.some((row) => row.country?.toLocaleLowerCase('en-US') === country)
    )
      throw validationError(
        'Unknown FARA country/location; use uslobbying_list_reference topic countries.',
        { reason: 'invalid_filter' },
      );
    const records: FaraRecord[] = [];
    for (const row of selected.records) {
      abort(scope);
      if (
        (status === 'all' || row.status === status) &&
        tokens.every((token) => row.name.toLocaleLowerCase('en-US').includes(token)) &&
        (!country || row.country?.toLocaleLowerCase('en-US') === country)
      ) {
        const registrantStatus = byId.get(row.registration_number);
        records.push(
          registrantStatus
            ? {
                ...row,
                registrant_status: registrantStatus,
                listing_url: listing(registrantStatus),
              }
            : row,
        );
      }
    }
    const used = registrants ? [selected, registrants] : [selected];
    return {
      records,
      status,
      retrieved_at: new Date().toISOString(),
      source_urls: used.map((value) => value.url),
      snapshot_retrieved_at: selected.retrievedAt,
      snapshot_source_urls: used.map((value) => value.url),
      ...(selected.lastModified !== undefined && { snapshot_last_modified: selected.lastModified }),
      notices: [
        'FARA search uses complete daily snapshots; principal status is independent of registrant status.',
      ],
    };
  }

  /** Complete country labels from the principal snapshot, without guessed ISO mappings. */
  async countries(
    signal: AbortSignal,
    deadlineAtMs = Date.now() + TOOL_DEADLINE_MS,
  ): Promise<{ countries: string[]; retrieved_at: string; source_urls: string[] }> {
    const snapshot = await this.snapshot('foreign_principals', callSignal(signal, deadlineAtMs));
    return {
      countries: [
        ...new Set(snapshot.records.flatMap((row) => (row.country ? [row.country] : []))),
      ].sort(),
      retrieved_at: snapshot.retrievedAt,
      source_urls: [snapshot.url],
    };
  }

  /** Fetch only the requested live collection; the acquisition layer retains its result. */
  async detail(
    input: FaraDetail,
    signal: AbortSignal,
    deadlineAtMs = Date.now() + TOOL_DEADLINE_MS,
  ): Promise<FaraSourceResult> {
    const scope = callSignal(signal, deadlineAtMs);
    const id = IdSchema.parse(input.registration_number);
    const detail = input.detail ?? 'foreign_principals';
    if (detail === 'documents' && input.status && input.status !== 'all')
      throw validationError('FARA documents have no status filter.', { reason: 'invalid_filter' });
    const status = input.status ?? (detail === 'documents' ? 'all' : 'active');
    const statuses = status === 'all' ? (['active', 'terminated'] as const) : [status];
    const paths =
      detail === 'documents'
        ? [`/api/v1/RegDocs/json/${id}`]
        : statuses.map(
            (arm) =>
              `/api/v1/${detail === 'foreign_principals' ? 'ForeignPrincipals' : 'ShortFormRegistrants'}/json/${arm === 'active' ? 'Active' : 'Terminated'}/${id}`,
          );
    const records: FaraRecord[] = [];
    for (const [index, path] of paths.entries()) {
      abort(scope);
      const result = await this.request(
        path,
        scope,
        Math.max(1, deadlineAtMs - Date.now()),
        (bytes, _response, parseSignal) => {
          const text = Buffer.from(bytes).toString('latin1');
          if (/^\s*<(?:!DOCTYPE\s+html|html[\s>])/i.test(text))
            throw serviceUnavailable('FARA returned HTML instead of JSON.', {
              reason: 'upstream_unavailable',
            });
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch (cause) {
            throw schemaFailure(cause);
          }
          const json = JsonValueSchema.safeParse(value);
          if (!json.success) throw schemaFailure(json.error);
          const wire =
            detail === 'documents'
              ? FaraDocumentWireSchema
              : detail === 'short_forms'
                ? FaraShortFormWireSchema
                : FaraPrincipalWireSchema;
          const parsed = faraDetailEnvelopeSchema(wire).safeParse(json.data);
          if (!parsed.success) throw schemaFailure(parsed.error);
          const rowset = parsed.data.ROWSET;
          const rows = rowset === '' ? [] : Array.isArray(rowset.ROW) ? rowset.ROW : [rowset.ROW];
          return rows.map((raw) => {
            abort(parseSignal);
            const doc = FaraDocumentWireSchema.safeParse(raw);
            const principal = FaraPrincipalWireSchema.safeParse(raw);
            const short = FaraShortFormWireSchema.safeParse(raw);
            const source = z.record(z.string(), JsonValueSchema).parse(raw);
            if (detail === 'documents' && doc.success)
              return {
                registration_number: normalizeSourceId(doc.data.REGISTRATION_NUMBER),
                name: doc.data.DOCUMENT_TYPE,
                entity: 'documents' as const,
                document_type: doc.data.DOCUMENT_TYPE,
                ...(doc.data.DATE_STAMPED !== undefined && {
                  date_stamped_raw: doc.data.DATE_STAMPED,
                }),
                ...(calendar(doc.data.DATE_STAMPED) && {
                  date_stamped: calendar(doc.data.DATE_STAMPED),
                }),
                ...(doc.data.FOREIGN_PRINCIPAL_NAME !== undefined && {
                  foreign_principal_name: doc.data.FOREIGN_PRINCIPAL_NAME,
                }),
                ...(doc.data.SHORT_FORM_NAME !== undefined && {
                  short_form_name: doc.data.SHORT_FORM_NAME,
                }),
                ...(doc.data.FOREIGN_PRINCIPAL_COUNTRY !== undefined && {
                  country: doc.data.FOREIGN_PRINCIPAL_COUNTRY,
                }),
                ...(doc.data.REGISTRANT_NAME !== undefined && {
                  registrant_name: doc.data.REGISTRANT_NAME,
                }),
                document_url: doc.data.URL,
                listing_url: listing(),
                raw: source,
              };
            if (detail === 'foreign_principals' && principal.success)
              return {
                registration_number: normalizeSourceId(principal.data.REG_NUMBER),
                name: principal.data.FP_NAME,
                entity: 'foreign_principals' as const,
                status: statuses[index],
                ...dates(principal.data.FP_REG_DATE),
                ...(principal.data.REGISTRANT_NAME !== undefined && {
                  registrant_name: principal.data.REGISTRANT_NAME,
                }),
                ...(principal.data.COUNTRY_NAME !== undefined && {
                  country: principal.data.COUNTRY_NAME,
                }),
                listing_url: listing(),
                raw: source,
              };
            if (detail === 'short_forms' && short.success)
              return {
                registration_number: normalizeSourceId(short.data.REG_NUMBER),
                name: [short.data.SF_FIRST_NAME, short.data.SF_LAST_NAME]
                  .filter((value) => value !== undefined && value !== null && value !== '')
                  .join(' '),
                entity: 'short_forms' as const,
                status: statuses[index],
                ...dates(short.data.SHORTFORM_DATE),
                ...(short.data.SF_FIRST_NAME !== undefined && {
                  first_name: short.data.SF_FIRST_NAME,
                }),
                last_name: short.data.SF_LAST_NAME,
                ...(short.data.REGISTRANT_NAME !== undefined && {
                  registrant_name: short.data.REGISTRANT_NAME,
                }),
                listing_url: listing(),
                raw: source,
              };
            throw schemaFailure();
          });
        },
      );
      records.push(...result);
    }
    return {
      records,
      status,
      retrieved_at: new Date().toISOString(),
      source_urls: paths.map((path) => `${ORIGIN}${path}`),
      notices:
        records.length === 0
          ? [
              'An empty FARA detail collection does not establish that the registration never existed.',
            ]
          : [],
    };
  }
}

let service: FaraService | undefined;
/** Initialize once during application setup. */
export function initFaraService(fetcher: typeof fetch = fetch): void {
  service = new FaraService(fetcher);
}
/** Access the initialized FARA source adapter. */
export function getFaraService(): FaraService {
  if (!service) throw new Error('FaraService is not initialized.');
  return service;
}
/** Release queued FARA callers during application teardown. */
export function disposeFaraPacer(): void {
  pacer.dispose();
}
