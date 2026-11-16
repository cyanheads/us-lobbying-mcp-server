/** @fileoverview Revisioned scans, immutable source chunks and count-bounded whole-record delivery. @module services/acquisition/acquisition-service */
import { createHash, randomUUID } from 'node:crypto';
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  ACQUISITION_TTL_MS,
  type AcquisitionCheckpoint,
  type AcquisitionSource,
  TOOL_DEADLINE_MS,
} from '@/domain/contracts.js';
import { type JsonValue, JsonValueSchema } from '@/domain/json.js';
import { exclusive, invalidCursor, readJson, removeJson, writeJson } from './storage.js';
import { type Manifest, ManifestSchema, type ResponseBuilder } from './types.js';

/** Rows per stored retained or final chunk; delivery windows read across chunk boundaries. */
const CHUNK_ROWS = 125;
const pageSizeSchema = z.number().int().min(1);
const maxPagesSchema = z.number().int().min(1).max(5);
const rowsSchema = z.array(JsonValueSchema);
const objectSchema = z.record(z.string(), JsonValueSchema);
const indexSchema = z.array(z.string());
const pageSchema = z.object({
  next: JsonValueSchema,
  records: rowsSchema,
  upstreamCount: z.number().int().nonnegative().optional(),
  partition: z
    .object({
      index: z.number().int().nonnegative(),
      total: z.number().int().positive(),
      firstPage: z.boolean().optional(),
    })
    .refine((value) => value.index < value.total)
    .optional(),
});
const tokenSchema = z.string().regex(/^[a-f0-9-]{36}\.[a-f0-9-]{36}$/);
function token(id: string): string {
  return `${id}.${randomUUID()}`;
}
function manifestKey(id: string): string {
  return `acquisition/scan/${id}`;
}
function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key] ?? null)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function checkpoint(manifest: Manifest): AcquisitionCheckpoint {
  return {
    chunkKeys: [...manifest.chunks],
    coverage: { ...manifest.coverage },
    ...(manifest.partitions ? { partitions: manifest.partitions } : {}),
    cursor: manifest.cursor,
    expiresAt: new Date(manifest.expires).toISOString(),
    filters: manifest.filters,
    provenance: manifest.provenance,
    position: manifest.position,
    revision: manifest.revision,
    scanKind: manifest.scanKind,
    tool: manifest.tool,
  };
}
/** An undefined scanKind accepts the stored kind, for callers that resolve it from the cursor. */
async function load(
  ctx: Context,
  cursor: string,
  tool: string,
  scanKind: string | undefined,
  filters?: Record<string, JsonValue>,
): Promise<Manifest> {
  if (!tokenSchema.safeParse(cursor).success) throw invalidCursor();
  const id = cursor.split('.')[0];
  const parsed = ManifestSchema.safeParse(await readJson(ctx, manifestKey(id ?? '')));
  if (
    !parsed.success ||
    parsed.data.tool !== tool ||
    (scanKind !== undefined && parsed.data.scanKind !== scanKind) ||
    parsed.data.expires <= Date.now()
  )
    throw invalidCursor();
  const manifest = parsed.data;
  if (filters) {
    const normalized = objectSchema.parse(filters);
    for (const [key, value] of Object.entries(normalized))
      if (
        !Object.hasOwn(manifest.filters, key) ||
        stable(value) !== stable(manifest.filters[key] ?? null)
      )
        throw validationError('Continuation filters must match the original normalized scope.', {
          reason: 'cursor_invalid',
        });
  }
  if (cursor !== manifest.cursor && cursor !== manifest.replay?.cursor) throw invalidCursor();
  return manifest;
}
function initial(options: {
  tool: string;
  scanKind: string;
  filters?: Record<string, JsonValue>;
  retainAll?: boolean;
  provenance: Record<string, JsonValue>;
}): Manifest {
  const id = randomUUID();
  const started = Date.now();
  return {
    id,
    tool: options.tool,
    scanKind: options.scanKind,
    filters: objectSchema.parse(options.filters ?? {}),
    provenance: objectSchema.parse(options.provenance),
    revision: 0,
    cursor: token(id),
    expires: started + ACQUISITION_TTL_MS,
    coverage: {
      complete: false,
      pages_fetched: 0,
      records_fetched: 0,
      unique_records: 0,
      started_at: new Date(started).toISOString(),
    },
    position: null,
    positions: [],
    chunks: [],
    pending: [],
    indexes: Array.from({ length: 64 }, () => null),
    retainAll: options.retainAll ?? false,
    delivered: 0,
  };
}
/** Source adapters own all network validation, rate pacing and absolute deadlines. */
export interface AcquireOptions {
  buildResponse: ResponseBuilder;
  cursor?: string;
  filters?: Record<string, JsonValue>;
  finalize?: (input: {
    chunks: AsyncIterable<JsonValue[]>;
    coverage: Manifest['coverage'];
    checkpoint: AcquisitionCheckpoint;
  }) => Promise<{
    records: Iterable<JsonValue> | AsyncIterable<JsonValue>;
    metadata?: Record<string, JsonValue>;
  }>;
  matches?: (record: JsonValue) => boolean;
  /** Upstream pages one call may fetch, 1–5; default 1. */
  maxPages?: number;
  /** Whole records per delivered window; the caller clamps it to its served ceiling. */
  pageSize: number;
  provenance: Record<string, JsonValue>;
  retainAll?: boolean;
  scanKind: string;
  source: AcquisitionSource<JsonValue>;
  tool: string;
}
/** The response is the exact replayable full envelope; checkpoints support streaming finalization. */
export interface AcquisitionResult {
  checkpoint: AcquisitionCheckpoint;
  response: object;
}
/** Build one window of whole records; a continuation is offered while rows or acquisition remain. */
function respond(
  manifest: Manifest,
  buildResponse: ResponseBuilder,
  window: { records: JsonValue[]; offset: number; more: boolean; total?: number | undefined },
): object {
  const next = window.more ? { next_cursor: manifest.cursor } : {};
  return buildResponse(
    {
      records: window.records,
      records_returned: window.records.length,
      output_complete: !window.more,
      truncated: window.more,
      coverage: { ...manifest.coverage, ...next },
      cursor_expires_at: new Date(manifest.expires).toISOString(),
      offset: window.offset,
      ...next,
      ...(window.total === undefined ? {} : { total_records: window.total }),
    },
    manifest.finalMetadata,
    manifest.provenance,
  );
}
/** Deliver the first `pageSize` pending matches; the window is short only at the end or while collecting. */
function pendingWindow(manifest: Manifest, buildResponse: ResponseBuilder, pageSize: number) {
  const records = manifest.pending.slice(0, pageSize);
  const offset = manifest.delivered;
  manifest.pending = manifest.pending.slice(records.length);
  manifest.delivered += records.length;
  return respond(manifest, buildResponse, {
    records,
    offset,
    more: manifest.pending.length > 0 || !manifest.coverage.complete,
  });
}
/** Deliver `pageSize` final rows from the stored offset, reading across chunk boundaries. */
async function finalWindow(
  ctx: Context,
  manifest: Manifest,
  buildResponse: ResponseBuilder,
  pageSize: number,
): Promise<object> {
  const { finalChunks: chunks, finalCount: total, finalOffset: offset } = manifest;
  if (!chunks || total === undefined || offset === undefined) throw invalidCursor();
  const end = Math.min(offset + pageSize, total);
  const records: JsonValue[] = [];
  for (let index = Math.floor(offset / CHUNK_ROWS); offset + records.length < end; index++) {
    const key = chunks[index];
    const chunk = key === undefined ? undefined : rowsSchema.safeParse(await readJson(ctx, key));
    if (!chunk?.success) throw invalidCursor();
    const start = Math.max(offset - index * CHUNK_ROWS, 0);
    records.push(...chunk.data.slice(start, start + end - offset - records.length));
  }
  manifest.finalOffset = offset + records.length;
  return respond(manifest, buildResponse, {
    records,
    offset,
    total,
    more: manifest.finalOffset < total,
  });
}
/**
 * Top up pending matches to `pageSize` within `maxPages` and the call deadline, or drain a retained
 * tail, then deliver one count-bounded window. Progress publishes only after every write succeeds.
 */
export async function acquire(ctx: Context, options: AcquireOptions): Promise<AcquisitionResult> {
  const maxPages = maxPagesSchema.parse(options.maxPages ?? 1);
  const pageSize = pageSizeSchema.parse(options.pageSize);
  const deadline = Date.now() + TOOL_DEADLINE_MS;
  const manifest = options.cursor
    ? await load(ctx, options.cursor, options.tool, options.scanKind, options.filters)
    : initial(options);
  return exclusive(ctx, manifest.id, async () => {
    const current = options.cursor
      ? await load(ctx, options.cursor, options.tool, options.scanKind, options.filters)
      : manifest;
    if (current.replay && options.cursor === current.replay.cursor)
      return {
        response: Object(JsonValueSchema.parse(current.replay.response)),
        checkpoint: checkpoint(current),
      };
    const incoming = current.cursor;
    const next: Manifest = {
      ...current,
      revision: current.revision + 1,
      cursor: token(current.id),
      coverage: { ...current.coverage },
      chunks: [...current.chunks],
      pending: [...current.pending],
      indexes: [...current.indexes],
      positions: [...current.positions],
    };
    delete next.replay;
    // Older checkpoints contain only the last page's count; keep replay exact, but do not reuse it as a scope total.
    if (!next.partitions) delete next.coverage.upstream_count;
    if (next.partitions) next.partitions = structuredClone(next.partitions);
    const affected = new Map<number, Set<string>>();
    const changedShards = new Set<number>();
    const replaced: string[] = [];
    const fetched: JsonValue[] = [];
    // Retained scans hold nothing pending, so they always fetch up to maxPages while collecting.
    for (
      let pageIndex = 0;
      pageIndex < maxPages && !next.coverage.complete && next.pending.length < pageSize;
      pageIndex++
    ) {
      ctx.signal.throwIfAborted();
      if (Date.now() + 1000 >= deadline) break;
      const page = pageSchema.parse(
        await options.source.fetchPage(next.position, ctx.signal, deadline),
      );
      const signature = stable(next.position);
      if (next.positions.includes(signature))
        throw serviceUnavailable('The source repeated a page position.', {
          reason: 'pagination_invalid',
          retryable: false,
        });
      next.positions.push(signature);
      if (
        page.next !== null &&
        (stable(page.next) === signature || next.positions.includes(stable(page.next)))
      )
        throw serviceUnavailable('The source returned a repeated pagination position.', {
          reason: 'pagination_invalid',
          retryable: false,
        });
      for (const row of page.records) {
        const id = z.string().min(1).parse(options.source.identify(row));
        const shard = (createHash('sha256').update(id).digest()[0] ?? 0) % 64;
        let ids = affected.get(shard);
        if (!ids) {
          const key = next.indexes[shard];
          const stored = key ? indexSchema.safeParse(await readJson(ctx, key)) : undefined;
          if (stored && !stored.success) throw invalidCursor();
          ids = new Set(stored?.data ?? []);
          affected.set(shard, ids);
        }
        if (ids.has(id)) continue;
        ids.add(id);
        changedShards.add(shard);
        next.coverage.unique_records++;
        fetched.push(row);
        if (!next.retainAll && (!options.matches || options.matches(row))) next.pending.push(row);
      }
      next.coverage.pages_fetched++;
      next.coverage.records_fetched += page.records.length;
      const partition = page.partition ?? { index: 0, total: 1 };
      next.partitions ??= { total: partition.total, observed: Object.create(null) };
      if (next.partitions.total !== partition.total)
        throw serviceUnavailable('The source partition scope changed.', {
          reason: 'pagination_invalid',
          retryable: false,
        });
      const previous = next.partitions.observed[String(partition.index)];
      next.partitions.observed[String(partition.index)] = {
        ...(page.upstreamCount !== undefined ? { count: page.upstreamCount } : {}),
        recordsFetched: (previous?.recordsFetched ?? 0) + page.records.length,
        completeHistory:
          previous?.completeHistory ?? page.partition?.firstPage ?? next.position === null,
      };
      const observed = Object.values(next.partitions.observed);
      if (
        observed.length === partition.total &&
        observed.every((entry) => entry.count !== undefined)
      )
        next.coverage.upstream_count = observed.reduce((sum, entry) => sum + (entry.count ?? 0), 0);
      else delete next.coverage.upstream_count;
      next.position = page.next;
      if (page.next === null) {
        next.coverage.complete = true;
        next.coverage.finished_at = new Date().toISOString();
      }
    }
    if (next.retainAll && fetched.length) {
      for (let offset = 0; offset < fetched.length; offset += CHUNK_ROWS) {
        const key = `acquisition/chunk/${next.id}/${next.revision}/${offset / CHUNK_ROWS}`;
        await writeJson(ctx, key, fetched.slice(offset, offset + CHUNK_ROWS), next.expires);
        next.chunks.push(key);
      }
    }
    for (const [shard, ids] of affected) {
      if (!changedShards.has(shard)) continue;
      const previous = next.indexes[shard];
      const key = `acquisition/index/${next.id}/${shard}/${next.revision}`;
      await writeJson(ctx, key, [...ids], next.expires);
      next.indexes[shard] = key;
      if (previous) replaced.push(previous);
    }
    if (next.retainAll && next.coverage.complete && !next.finalChunks && options.finalize) {
      const finalized = await options.finalize({
        chunks: { [Symbol.asyncIterator]: () => streamChunks(ctx, next.chunks) },
        coverage: next.coverage,
        checkpoint: checkpoint(next),
      });
      await materializeFinal(ctx, next, finalized.records);
      if (finalized.metadata) next.finalMetadata = objectSchema.parse(finalized.metadata);
    }
    const response = next.finalChunks
      ? await finalWindow(ctx, next, options.buildResponse, pageSize)
      : pendingWindow(next, options.buildResponse, pageSize);
    next.replay = { cursor: incoming, response: JsonValueSchema.parse(response) };
    await writeJson(ctx, manifestKey(next.id), ManifestSchema.parse(next), next.expires);
    // Cleanup follows publication: failure must not turn a committed response into a failed advancement.
    for (const key of replaced) {
      try {
        await removeJson(ctx, key);
      } catch (error) {
        ctx.log.warning('Replaced acquisition index retained until expiry.', {
          key,
          cause: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    return { response, checkpoint: checkpoint(next) };
  });
}
/** Resolve original normalized filters/mode before constructing a source callback on continuation. */
export async function resolveCheckpoint(
  ctx: Context,
  options: { tool: string; cursor: string },
): Promise<AcquisitionCheckpoint> {
  return checkpoint(await load(ctx, options.cursor, options.tool, undefined));
}
/** Stream only complete analytical acquisitions; a missing chunk invalidates the scan. */
export async function* iterateChunks(
  ctx: Context,
  stored: AcquisitionCheckpoint,
): AsyncGenerator<JsonValue[]> {
  const manifest = await load(ctx, stored.cursor, stored.tool, stored.scanKind, stored.filters);
  if (!manifest.coverage.complete || !manifest.retainAll)
    throw validationError('Only complete retained scans can be finalized.', {
      reason: 'acquisition_incomplete',
    });
  yield* streamChunks(ctx, manifest.chunks);
}
async function* streamChunks(ctx: Context, keys: string[]): AsyncGenerator<JsonValue[]> {
  for (const key of keys) {
    ctx.signal.throwIfAborted();
    const parsed = rowsSchema.safeParse(await readJson(ctx, key));
    if (!parsed.success) throw invalidCursor();
    yield parsed.data;
  }
}
async function materializeFinal(
  ctx: Context,
  manifest: Manifest,
  rows: Iterable<JsonValue> | AsyncIterable<JsonValue>,
): Promise<void> {
  const keys: string[] = [];
  let records: JsonValue[] = [];
  let count = 0;
  async function flush() {
    const key = `acquisition/final/${manifest.id}/${manifest.revision}/${keys.length}`;
    await writeJson(ctx, key, records, manifest.expires);
    keys.push(key);
    records = [];
  }
  for await (const row of rows) {
    ctx.signal.throwIfAborted();
    records.push(JsonValueSchema.parse(row));
    count++;
    if (records.length === CHUNK_ROWS) await flush();
  }
  if (records.length) await flush();
  manifest.finalChunks = keys;
  manifest.finalCount = count;
  manifest.finalOffset = 0;
}
/** Finalized arrays use the same count-bounded windows without acquiring more source data. */
export interface ServeResultsOptions {
  buildResponse: ResponseBuilder;
  cursor?: string;
  filters?: Record<string, JsonValue>;
  /** Whole records per window; a fixed window passes the same constant on every call. */
  pageSize: number;
  provenance: Record<string, JsonValue>;
  records?: JsonValue[];
  scanKind: string;
  tool: string;
}
/** Materialize immutable final chunks once, then page whole records with exact totals. */
export async function serveResults(
  ctx: Context,
  options: ServeResultsOptions,
): Promise<AcquisitionResult> {
  const pageSize = pageSizeSchema.parse(options.pageSize);
  const manifest = options.cursor
    ? await load(ctx, options.cursor, options.tool, options.scanKind, options.filters)
    : initial(options);
  return exclusive(ctx, manifest.id, async () => {
    const current = options.cursor
      ? await load(ctx, options.cursor, options.tool, options.scanKind, options.filters)
      : manifest;
    if (current.replay && options.cursor === current.replay.cursor)
      return { response: Object(current.replay.response), checkpoint: checkpoint(current) };
    const incoming = current.cursor;
    const next: Manifest = {
      ...current,
      revision: current.revision + 1,
      cursor: token(current.id),
      coverage: { ...current.coverage },
    };
    delete next.replay;
    if (!next.finalChunks) {
      if (!options.records)
        throw validationError('Final rows are required on the first result-window request.', {
          reason: 'invalid_filter',
        });
      await materializeFinal(ctx, next, options.records);
      next.coverage = {
        ...next.coverage,
        complete: true,
        records_fetched: options.records.length,
        unique_records: options.records.length,
        finished_at: new Date().toISOString(),
      };
    }
    const response = await finalWindow(ctx, next, options.buildResponse, pageSize);
    next.replay = { cursor: incoming, response: JsonValueSchema.parse(response) };
    await writeJson(ctx, manifestKey(next.id), ManifestSchema.parse(next), next.expires);
    return { response, checkpoint: checkpoint(next) };
  });
}
