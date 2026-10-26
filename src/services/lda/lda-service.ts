/** @fileoverview Fixed-host, paced LDA source acquisition without cursor storage. @module services/lda/lda-service */
import { z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serializationError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer, type Pacer, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { EXCHANGE_DEADLINE_MS, TOOL_DEADLINE_MS } from '@/domain/contracts.js';
import { IdSchema, JsonValueSchema } from '@/domain/json.js';
import {
  ClientSchema,
  ContributionReportSchema,
  FilingSchema,
  LdaConstantSchema,
  LobbyistSchema,
  ldaPageSchema,
  normalizeLdaRecord,
  RegistrantSchema,
} from '@/domain/lda.js';

const BASE = 'https://lda.gov/api/v1/';
const common = ['page', 'page_size', 'ordering'] as const;
const allowed = {
  filings: [
    ...common,
    'filing_uuid',
    'registrant_id',
    'registrant_name',
    'registrant_country',
    'registrant_ppb_country',
    'client_id',
    'client_name',
    'client_state',
    'client_country',
    'client_ppb_state',
    'client_ppb_country',
    'lobbyist_id',
    'lobbyist_name',
    'lobbyist_covered_position',
    'lobbyist_covered_position_indicator',
    'lobbyist_conviction_disclosure',
    'lobbyist_conviction_disclosure_indicator',
    'lobbyist_conviction_date_range_after',
    'lobbyist_conviction_date_range_before',
    'filing_type',
    'filing_year',
    'filing_period',
    'filing_dt_posted_after',
    'filing_dt_posted_before',
    'filing_amount_reported_min',
    'filing_amount_reported_max',
    'filing_specific_lobbying_issues',
    'affiliated_organization_name',
    'affiliated_organization_country',
    'affiliated_organization_listed_indicator',
    'foreign_entity_name',
    'foreign_entity_country',
    'foreign_entity_listed_indicator',
    'foreign_entity_ppb_country',
    'foreign_entity_ownership_percentage_min',
    'foreign_entity_ownership_percentage_max',
  ],
  contributions: [
    ...common,
    'filing_uuid',
    'filing_type',
    'filing_year',
    'filing_period',
    'filing_dt_posted_after',
    'filing_dt_posted_before',
    'registrant_id',
    'registrant_name',
    'lobbyist_id',
    'lobbyist_name',
    'lobbyist_exclude',
    'contribution_date_after',
    'contribution_date_before',
    'contribution_amount_min',
    'contribution_amount_max',
    'contribution_type',
    'contribution_contributor',
    'contribution_payee',
    'contribution_honoree',
  ],
  clients: [
    ...common,
    'id',
    'client_name',
    'client_state',
    'client_country',
    'client_ppb_state',
    'client_ppb_country',
    'registrant_id',
    'registrant_name',
  ],
  registrants: [
    ...common,
    'id',
    'registrant_name',
    'state',
    'country',
    'ppb_country',
    'dt_updated_after',
    'dt_updated_before',
  ],
  lobbyists: [...common, 'id', 'lobbyist_name', 'registrant_id', 'registrant_name'],
} as const;
/** Endpoint names constrain both filters and continuation paths. */
export type LdaNoun = keyof typeof allowed;
function isAllowed(noun: LdaNoun, key: string): boolean {
  return (allowed[noun] as readonly string[]).includes(key);
}
/** Statuses outside this map classify as ServiceUnavailable (5xx) or ValidationError. */
const STATUS_CODES = new Map<number, JsonRpcErrorCode>([
  [401, JsonRpcErrorCode.Unauthorized],
  [403, JsonRpcErrorCode.Forbidden],
  [404, JsonRpcErrorCode.NotFound],
  [408, JsonRpcErrorCode.Timeout],
  [429, JsonRpcErrorCode.RateLimited],
]);
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
/** Only official endpoint parameters are representable. Runtime validation also rejects unknown keys. */
export type LdaFilters<N extends LdaNoun> = Partial<
  Record<(typeof allowed)[N][number], string | number | boolean>
>;
/** A deadline is an absolute epoch millisecond instant shared with acquisition. */
export interface LdaRequestOptions {
  deadlineMs?: number;
  signal?: AbortSignal;
}
/** Fetch-compatible seam for deterministic transport verification. */
export interface LdaServiceOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}
const constantPaths = {
  issue_codes: 'filing/lobbyingactivityissues',
  filing_types: 'filing/filingtypes',
  government_entities: 'filing/governmententities',
  countries: 'general/countries',
  states: 'general/states',
  prefixes: 'lobbyist/prefixes',
  suffixes: 'lobbyist/suffixes',
  contribution_types: 'contribution/itemtypes',
} as const;
/** Supported verified constant families. */
export type LdaConstantTopic = keyof typeof constantPaths;
let sharedPacer: Pacer | undefined;
let sharedAuthenticated: boolean | undefined;
function sourcePacer(authenticated: boolean): Pacer {
  if (sharedPacer && sharedAuthenticated !== authenticated)
    throw new Error('LDA authentication mode cannot change after service initialization.');
  sharedAuthenticated = authenticated;
  sharedPacer ??= createPacer({
    name: 'lda',
    limits: [{ requests: authenticated ? 120 : 15, perMs: 60_000 }],
    minStartGapMs: authenticated ? 510 : 4100,
    maxConcurrent: 1,
    maxQueueDepth: 32,
    cooldown: { baseMs: 4100, maxMs: 30_000 },
  });
  return sharedPacer;
}
/** One process-wide upstream gate spans all service instances and tools. */
export class LdaService {
  private readonly transport: typeof globalThis.fetch;
  private readonly apiKey: string | undefined;
  private readonly pacer: Pacer;
  constructor(options: LdaServiceOptions = {}) {
    this.apiKey = options.apiKey;
    this.transport = options.fetch ?? globalThis.fetch;
    this.pacer = sourcePacer(Boolean(options.apiKey));
  }
  /** Release queued work during application teardown. */
  dispose(): void {
    this.pacer.dispose();
    if (sharedPacer === this.pacer) {
      sharedPacer = undefined;
      sharedAuthenticated = undefined;
    }
  }
  private url<N extends LdaNoun>(noun: N, filters: LdaFilters<N>): URL {
    const url = new URL(`${noun}/`, BASE);
    for (const [key, value] of Object.entries(filters)) {
      if (!isAllowed(noun, key))
        throw validationError('Unsupported LDA endpoint filter.', {
          reason: 'invalid_filter',
          parameter: key,
        });
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const size = url.searchParams.get('page_size');
    const page = url.searchParams.get('page');
    if (
      (size !== null && (!/^\d+$/.test(size) || Number(size) < 1 || Number(size) > 25)) ||
      (page !== null && (!/^\d+$/.test(page) || Number(page) < 1))
    )
      throw validationError(
        'LDA page and page_size must be valid positive integers; page_size cannot exceed 25.',
        { reason: 'invalid_filter' },
      );
    return url;
  }
  /** Validate an untrusted source link and return only its advancing page number. Requests rebuild stored filters. */
  validateNext<N extends LdaNoun>(
    noun: N,
    next: string | null,
    filters: LdaFilters<N>,
    currentPage: number,
  ): number | null {
    if (next === null) return null;
    const invalid = () =>
      serviceUnavailable('LDA returned an invalid or nonprogressing pagination link.', {
        reason: 'pagination_invalid',
        retryable: false,
      });
    let link: URL;
    try {
      link = new URL(next);
    } catch {
      throw invalid();
    }
    const expected = this.url(noun, filters);
    if (
      link.origin !== expected.origin ||
      link.pathname !== expected.pathname ||
      link.username ||
      link.password ||
      link.hash
    )
      throw invalid();
    for (const key of link.searchParams.keys())
      if (!isAllowed(noun, key) || link.searchParams.getAll(key).length !== 1) throw invalid();
    const page = link.searchParams.get('page');
    if (!page || !/^\d+$/.test(page) || Number(page) !== currentPage + 1) throw invalid();
    expected.searchParams.delete('page');
    const actual = new URLSearchParams(link.searchParams);
    actual.delete('page');
    expected.searchParams.sort();
    actual.sort();
    if (expected.searchParams.toString() !== actual.toString()) throw invalid();
    return Number(page);
  }
  private request<T>(url: URL, schema: z.ZodType<T>, options: LdaRequestOptions): Promise<T> {
    const deadline = Math.min(
      options.deadlineMs ?? Date.now() + TOOL_DEADLINE_MS,
      Date.now() + TOOL_DEADLINE_MS,
    );
    if (deadline <= Date.now())
      throw timeout('The LDA acquisition deadline has elapsed.', { retryable: false });
    return withRetry(
      ({ signal, remainingMs }) =>
        this.pacer.run(
          async (queuedSignal) => {
            const exchange = AbortSignal.any([
              queuedSignal,
              AbortSignal.timeout(EXCHANGE_DEADLINE_MS),
            ]);
            let response: Response;
            let body: string;
            try {
              response = await this.transport(url, {
                signal: exchange,
                redirect: 'error',
                headers: {
                  Accept: 'application/json',
                  ...(this.apiKey ? { Authorization: `Token ${this.apiKey}` } : {}),
                },
              });
              if (!response.ok) {
                await response.body?.cancel();
                const { status } = response;
                const code =
                  STATUS_CODES.get(status) ??
                  (status >= 500
                    ? JsonRpcErrorCode.ServiceUnavailable
                    : JsonRpcErrorCode.ValidationError);
                const retryAfter = response.headers.get('retry-after');
                throw new McpError(code, 'The official LDA request failed.', {
                  status,
                  retryable: RETRYABLE_STATUSES.has(status),
                  ...(retryAfter ? { retryAfter } : {}),
                });
              }
              body = await response.text();
            } catch (error) {
              signal.throwIfAborted();
              if (error instanceof McpError) throw error;
              if (
                error instanceof TypeError ||
                exchange.aborted ||
                (error instanceof DOMException &&
                  ['NetworkError', 'AbortError', 'TimeoutError'].includes(error.name))
              )
                throw serviceUnavailable(
                  'The official LDA exchange could not complete.',
                  { retryable: true },
                  { cause: error },
                );
              throw error;
            }
            exchange.throwIfAborted();
            if (/^\s*<(?:!doctype\s+html|html[\s>])/i.test(body))
              throw serviceUnavailable('LDA returned HTML instead of JSON.', { retryable: true });
            let value: unknown;
            try {
              value = normalizeLdaRecord(JsonValueSchema.parse(JSON.parse(body)));
            } catch (error) {
              throw serializationError(
                'LDA returned an incompatible JSON response.',
                { reason: 'source_schema_changed', retryable: false },
                { cause: error },
              );
            }
            const parsed = schema.safeParse(value);
            if (!parsed.success)
              throw serializationError('LDA returned an incompatible source schema.', {
                reason: 'source_schema_changed',
                retryable: false,
              });
            signal.throwIfAborted();
            return parsed.data;
          },
          { signal, maxWaitMs: remainingMs },
        ),
      {
        ...(options.signal ? { signal: options.signal } : {}),
        deadlineMs: Math.max(1, deadline - Date.now()),
        maxRetries: 1,
        baseDelayMs: 1000,
        maxDelayMs: 30_000,
        operation: 'lda.request',
        isTransient: (error) => error instanceof McpError && error.data?.retryable === true,
      },
    );
  }
  /** Fetch one complete raw filing page, including every version. */
  listFilings(filters: LdaFilters<'filings'>, options: LdaRequestOptions = {}) {
    return this.request(this.url('filings', filters), ldaPageSchema(FilingSchema), options);
  }
  /** Fetch one LD-203 page, preserving complete child lists. */
  listContributions(filters: LdaFilters<'contributions'>, options: LdaRequestOptions = {}) {
    return this.request(
      this.url('contributions', filters),
      ldaPageSchema(ContributionReportSchema),
      options,
    );
  }
  /** Resolve relationship candidates without merging names. */
  listClients(filters: LdaFilters<'clients'>, options: LdaRequestOptions = {}) {
    return this.request(this.url('clients', filters), ldaPageSchema(ClientSchema), options);
  }
  /** Fetch one registrant page. */
  listRegistrants(filters: LdaFilters<'registrants'>, options: LdaRequestOptions = {}) {
    return this.request(this.url('registrants', filters), ldaPageSchema(RegistrantSchema), options);
  }
  /** Fetch identity records, not filing-scoped employment evidence. */
  listLobbyists(filters: LdaFilters<'lobbyists'>, options: LdaRequestOptions = {}) {
    return this.request(this.url('lobbyists', filters), ldaPageSchema(LobbyistSchema), options);
  }
  private detail<T>(noun: LdaNoun, id: string, schema: z.ZodType<T>, options: LdaRequestOptions) {
    if (
      !(noun === 'filings' || noun === 'contributions'
        ? z.string().uuid().safeParse(id).success
        : /^\d+$/.test(id))
    )
      throw validationError('Invalid LDA record identifier.', { reason: 'invalid_filter' });
    return this.request(new URL(`${noun}/${encodeURIComponent(id)}/`, BASE), schema, options);
  }
  /** Fetch a complete filing by UUID. */
  getFiling(id: string, options: LdaRequestOptions = {}) {
    return this.detail('filings', id, FilingSchema, options);
  }
  /** Fetch one complete LD-203 report. */
  getContribution(id: string, options: LdaRequestOptions = {}) {
    return this.detail('contributions', id, ContributionReportSchema, options);
  }
  /** Fetch one client relationship. */
  getClient(id: string, options: LdaRequestOptions = {}) {
    return this.detail('clients', id, ClientSchema, options);
  }
  /** Fetch one registrant. */
  getRegistrant(id: string, options: LdaRequestOptions = {}) {
    return this.detail('registrants', id, RegistrantSchema, options);
  }
  /** Fetch one lobbyist identity. */
  getLobbyist(id: string, options: LdaRequestOptions = {}) {
    return this.detail('lobbyists', id, LobbyistSchema, options);
  }
  /** Fetch an official reference family. */
  constants(topic: LdaConstantTopic, options: LdaRequestOptions = {}) {
    const record =
      topic === 'government_entities'
        ? LdaConstantSchema.omit({ value: true })
            .extend({ id: IdSchema })
            .transform((entry) => ({ ...entry, value: entry.id }))
        : LdaConstantSchema;
    return this.request(
      new URL(`constants/${constantPaths[topic]}/`, BASE),
      z.array(record),
      options,
    );
  }
}
let service: LdaService | undefined;
function configuredOptions(): LdaServiceOptions {
  const apiKey = getServerConfig().ldaApiKey;
  return apiKey ? { apiKey } : {};
}
/** Initialize once in application setup; transport injection is available to verification. */
export function initLdaService(options?: LdaServiceOptions): void {
  service = new LdaService(options ?? configuredOptions());
}
/** Lazily provide the configured source service for tools. */
export function getLdaService(): LdaService {
  service ??= new LdaService(configuredOptions());
  return service;
}
