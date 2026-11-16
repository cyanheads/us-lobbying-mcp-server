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
import { SingleFlight } from '@/services/single-flight.js';
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
type SnapshotKind = 'registrants' | 'foreign_principals' | 'short_forms';
type XmlRow = z.infer<typeof xmlRow>;
interface Snapshot {
  lastModified?: string;
  records: FaraRecord[];
  retrievedAt: string;
  url: string;
}
const snapshots = new Map<SnapshotKind, Snapshot>();
const flights = new SingleFlight<SnapshotKind, Snapshot>();

function schemaFailure(cause?: unknown): McpError {
  return new McpError(
    JsonRpcErrorCode.SerializationError,
    'FARA returned an incompatible source record or envelope.',
    { reason: 'source_schema_changed', retryable: false },
    { cause },
  );
}
/** Parse source data, converting any violation into the typed schema failure. */
function sourceParse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw schemaFailure(parsed.error);
  return parsed.data;
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
function field(raw: XmlRow, key: string): string | undefined {
  const value = raw[key];
  if (value !== undefined && typeof value !== 'string') throw schemaFailure();
  return value;
}
/** A non-blank termination date ends the selected entity, whatever its registrant's status. */
function statusOf(termination: string | null | undefined): NonNullable<FaraRecord['status']> {
  return termination?.trim() ? 'terminated' : 'active';
}
/** A blank or absent name part is undisclosed; a row with neither keeps an empty name. */
function person(first: string | null | undefined, last: string | null | undefined) {
  return {
    name: [first, last].filter(Boolean).join(' '),
    ...(first ? { first_name: first } : {}),
    ...(last ? { last_name: last } : {}),
  };
}
/** Daily bulk archives: ZIP noun, XML root element, and each row's normalized record. */
const ARCHIVES: Record<
  SnapshotKind,
  { noun: string; root: string; record: (raw: XmlRow) => FaraRecord }
> = {
  registrants: {
    noun: 'Registrants',
    root: 'REGISTRANTS',
    record(raw) {
      const name = field(raw, 'Name');
      if (name === undefined) throw schemaFailure();
      const termination = field(raw, 'Termination_Date');
      const status = statusOf(termination);
      return {
        registration_number: sourceParse(IdSchema, raw.Registration_Number),
        name,
        entity: 'registrants',
        status,
        ...dates(field(raw, 'Registration_Date'), termination),
        listing_url: listing(status),
        raw,
      };
    },
  },
  foreign_principals: {
    noun: 'ForeignPrincipals',
    root: 'FOREIGNPRINCIPALS',
    record(raw) {
      const name = field(raw, 'Foreign_principal');
      if (name === undefined) throw schemaFailure();
      const termination = field(raw, 'FP_termination_date');
      const status = statusOf(termination);
      const registrantName = field(raw, 'Registrant_name');
      const country = field(raw, 'Country_location_represented');
      return {
        registration_number: sourceParse(IdSchema, raw.Registration_number),
        name,
        entity: 'foreign_principals',
        status,
        ...dates(field(raw, 'FP_registration_date'), termination),
        ...(registrantName !== undefined && { registrant_name: registrantName }),
        ...(country !== undefined && { country }),
        listing_url: listing(status),
        raw,
      };
    },
  },
  short_forms: {
    noun: 'ShortForms',
    root: 'SHORTFORM_REGISTRANTS',
    record(raw) {
      const termination = field(raw, 'Short_form_termination_date');
      const status = statusOf(termination);
      const registrantName = field(raw, 'Registrant_name');
      return {
        registration_number: sourceParse(IdSchema, raw.Registration_number),
        ...person(field(raw, 'Short_form_first_name'), field(raw, 'Short_form_last_name')),
        entity: 'short_forms',
        status,
        ...dates(field(raw, 'Short_form_date'), termination),
        ...(registrantName !== undefined && { registrant_name: registrantName }),
        listing_url: listing(status),
        raw,
      };
    },
  },
};
function callSignal(signal: AbortSignal, deadlineAtMs: number): AbortSignal {
  signal.throwIfAborted();
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
    parse: (
      bytes: Uint8Array,
      response: Response,
      signal: AbortSignal,
      acquiredUrl: string,
    ) => T | Promise<T>,
    documentsRegistration?: string,
  ): Promise<T> {
    const deadlineAtMs = Date.now() + deadlineMs;
    return withRetry(
      async ({ signal: attemptSignal }) => {
        let url = `${ORIGIN}${path}`;
        for (let hop = 0; ; hop++) {
          const remainingMs = deadlineAtMs - Date.now();
          const result = await pacer.run<{ redirect: string } | { value: T }>(
            async () => {
              const exchangeRemainingMs = deadlineAtMs - Date.now();
              if (exchangeRemainingMs <= 0)
                throw new McpError(JsonRpcErrorCode.Timeout, 'FARA call deadline expired.', {
                  retryable: false,
                });
              const exchange = AbortSignal.any([
                attemptSignal,
                AbortSignal.timeout(Math.min(EXCHANGE_DEADLINE_MS, exchangeRemainingMs)),
              ]);
              let response: Response;
              let bytes: Uint8Array;
              try {
                response = await this.fetcher(url, {
                  signal: exchange,
                  redirect: 'manual',
                  headers: {
                    Accept: path.endsWith('.zip') ? 'application/zip' : 'application/json',
                  },
                });
                if (response.status >= 300 && response.status < 400) {
                  let target: URL;
                  try {
                    target = new URL(response.headers.get('location') ?? '', url);
                  } catch (cause) {
                    throw schemaFailure(cause);
                  }
                  const expected = `f?p=API:REGISTRANTDOCS-F_XML:::::F_XML_REG_NUM,F_XML_CC,F_XML_DOC_TYPE:${documentsRegistration},,`;
                  if (
                    documentsRegistration === undefined ||
                    hop !== 0 ||
                    response.status !== 302 ||
                    target.origin !== ORIGIN ||
                    target.username !== '' ||
                    target.password !== '' ||
                    target.href.includes('#') ||
                    target.pathname !== '/CallAPI/GetJSON' ||
                    target.searchParams.size !== 1 ||
                    target.searchParams.get('a') !== expected
                  )
                    throw schemaFailure();
                  await response.body?.cancel();
                  exchange.throwIfAborted();
                  return { redirect: target.href };
                }
                if (!response.ok)
                  throw await httpErrorFromResponse(response, {
                    service: 'FARA',
                    captureBody: false,
                    data: {
                      reason:
                        response.status === 429 ? 'source_rate_limited' : 'upstream_unavailable',
                      retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
                    },
                  });
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
              exchange.throwIfAborted();
              return { value: await parse(bytes, response, exchange, url) };
            },
            { signal: attemptSignal, maxWaitMs: remainingMs },
          );
          if ('value' in result) return result.value;
          url = result.redirect;
        }
      },
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
    const { noun, root, record } = ARCHIVES[kind];
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
        const json = sourceParse(JsonValueSchema, parsed);
        const envelope = sourceParse(
          z.object({ [root]: z.object({ ROW: z.union([xmlRow, z.array(xmlRow)]) }) }),
          json,
        );
        const collection = envelope[root];
        if (!collection) throw schemaFailure();
        const rows = Array.isArray(collection.ROW) ? collection.ROW : [collection.ROW];
        const records: FaraRecord[] = [];
        for (const row of rows) {
          parseSignal.throwIfAborted();
          const { '#text': layout, ...raw } = row;
          if (layout !== undefined && (typeof layout !== 'string' || layout.trim() !== ''))
            throw schemaFailure();
          records.push(record(raw));
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
    signal.throwIfAborted();
    const cached = snapshots.get(kind);
    if (cached && Date.now() - Date.parse(cached.retrievedAt) < SOURCE_CACHE_TTL_MS) return cached;
    return await flights.join(kind, signal, async (flightSignal) => {
      const loaded = await this.loadSnapshot(kind, flightSignal);
      snapshots.set(kind, loaded);
      return loaded;
    });
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
      entity === 'registrants' ? undefined : await this.snapshot('registrants', scope);
    const byId = new Map(registrants?.records.map((row) => [row.registration_number, row.status]));
    // Distinct tokens: every row is checked against each token once.
    const tokens = [
      ...new Set(
        input.name_contains?.trim().toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean),
      ),
    ];
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
      scope.throwIfAborted();
      if (status !== 'all' && row.status !== status) continue;
      if (country && row.country?.toLocaleLowerCase('en-US') !== country) continue;
      if (tokens.length > 0) {
        const name = row.name.toLocaleLowerCase('en-US');
        if (!tokens.every((token) => name.includes(token))) continue;
      }
      const registrantStatus = byId.get(row.registration_number);
      records.push(
        registrantStatus
          ? { ...row, registrant_status: registrantStatus, listing_url: listing(registrantStatus) }
          : row,
      );
    }
    const urls = (registrants ? [selected, registrants] : [selected]).map((value) => value.url);
    return {
      records,
      status,
      retrieved_at: new Date().toISOString(),
      source_urls: urls,
      snapshot_retrieved_at: selected.retrievedAt,
      snapshot_source_urls: [...urls],
      ...(selected.lastModified !== undefined && { snapshot_last_modified: selected.lastModified }),
      notices: [
        entity === 'short_forms'
          ? 'FARA search uses complete daily snapshots; short-form status is independent of registrant status. Short-form matches are name matches and establish no identity across registrations or with LDA lobbyists.'
          : 'FARA search uses complete daily snapshots; principal status is independent of registrant status.',
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
    const sourceUrls = paths.map((path) => `${ORIGIN}${path}`);
    for (const [index, path] of paths.entries()) {
      scope.throwIfAborted();
      const result = await this.request(
        path,
        scope,
        Math.max(1, deadlineAtMs - Date.now()),
        (bytes, _response, parseSignal, acquiredUrl): FaraRecord[] => {
          if (!sourceUrls.includes(acquiredUrl)) sourceUrls.push(acquiredUrl);
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
          const json = sourceParse(JsonValueSchema, value);
          // Each row parsed by its wire schema, beside the source row exactly as FARA sent it.
          const rows = <T>(wire: z.ZodType<T>): [T, XmlRow][] => {
            const rowset = sourceParse(faraDetailEnvelopeSchema(xmlRow), json).ROWSET;
            const list = rowset === '' ? [] : Array.isArray(rowset.ROW) ? rowset.ROW : [rowset.ROW];
            return list.map((source) => {
              parseSignal.throwIfAborted();
              return [sourceParse(wire, source), source];
            });
          };
          switch (detail) {
            case 'documents':
              return rows(FaraDocumentWireSchema).map(([doc, raw]) => {
                const stamped = calendar(doc.DATE_STAMPED);
                return {
                  registration_number: normalizeSourceId(doc.REGISTRATION_NUMBER),
                  name: doc.DOCUMENT_TYPE,
                  entity: 'documents',
                  document_type: doc.DOCUMENT_TYPE,
                  ...(doc.DATE_STAMPED !== undefined && { date_stamped_raw: doc.DATE_STAMPED }),
                  ...(stamped && { date_stamped: stamped }),
                  ...(doc.FOREIGN_PRINCIPAL_NAME !== undefined && {
                    foreign_principal_name: doc.FOREIGN_PRINCIPAL_NAME,
                  }),
                  ...(doc.SHORT_FORM_NAME !== undefined && {
                    short_form_name: doc.SHORT_FORM_NAME,
                  }),
                  ...(doc.FOREIGN_PRINCIPAL_COUNTRY !== undefined && {
                    country: doc.FOREIGN_PRINCIPAL_COUNTRY,
                  }),
                  ...(doc.REGISTRANT_NAME !== undefined && {
                    registrant_name: doc.REGISTRANT_NAME,
                  }),
                  document_url: doc.URL,
                  listing_url: listing(),
                  raw,
                };
              });
            case 'foreign_principals':
              return rows(FaraPrincipalWireSchema).map(([principal, raw]) => ({
                registration_number: normalizeSourceId(principal.REG_NUMBER),
                name: principal.FP_NAME,
                entity: 'foreign_principals',
                status: statuses[index],
                ...dates(principal.FP_REG_DATE, principal.TERMINATION_DATE),
                ...(principal.REGISTRANT_NAME !== undefined && {
                  registrant_name: principal.REGISTRANT_NAME,
                }),
                ...(principal.COUNTRY_NAME !== undefined && { country: principal.COUNTRY_NAME }),
                listing_url: listing(),
                raw,
              }));
            case 'short_forms':
              return rows(FaraShortFormWireSchema).map(([short, raw]) => ({
                registration_number: normalizeSourceId(short.REG_NUMBER),
                ...person(short.SF_FIRST_NAME, short.SF_LAST_NAME),
                entity: 'short_forms',
                status: statuses[index],
                ...dates(short.SHORTFORM_DATE, short.SF_TERM_DATE),
                ...(short.REGISTRANT_NAME !== undefined && {
                  registrant_name: short.REGISTRANT_NAME,
                }),
                listing_url: listing(),
                raw,
              }));
          }
        },
        detail === 'documents' ? id : undefined,
      );
      records.push(...result);
    }
    return {
      records,
      status,
      retrieved_at: new Date().toISOString(),
      source_urls: sourceUrls,
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
