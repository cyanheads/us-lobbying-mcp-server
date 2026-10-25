/** @fileoverview Revisioned scans, immutable source chunks and bounded complete-record delivery. @module services/acquisition/acquisition-service */
import { createHash, randomUUID } from 'node:crypto';
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  ACQUISITION_TTL_MS,
  type AcquisitionCheckpoint,
  type AcquisitionSource,
  FULL_RESULT_TARGET_BYTES,
  TOOL_DEADLINE_MS,
} from '@/domain/contracts.js';
import { fullResultBytes } from '@/domain/format.js';
import { type JsonValue, JsonValueSchema } from '@/domain/json.js';
import { assertFits, deferRecord } from './record-window.js';
import { exclusive, invalidCursor, readJson, removeJson, writeJson } from './storage.js';
import {
  type DeliveryWindow,
  type Manifest,
  ManifestSchema,
  type ResponseBuilder,
} from './types.js';

const rowsSchema = z.array(JsonValueSchema);
const indexSchema = z.array(z.string());
const pageSchema = z.object({
  next: JsonValueSchema,
  records: rowsSchema,
  upstreamCount: z.number().int().nonnegative().optional(),
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
async function load(
  ctx: Context,
  cursor: string,
  tool: string,
  scanKind: string,
  filters?: Record<string, JsonValue>,
): Promise<Manifest> {
  if (!tokenSchema.safeParse(cursor).success) throw invalidCursor();
  const id = cursor.split('.')[0];
  const parsed = ManifestSchema.safeParse(await readJson(ctx, manifestKey(id ?? '')));
  if (
    !parsed.success ||
    parsed.data.tool !== tool ||
    parsed.data.scanKind !== scanKind ||
    parsed.data.expires <= Date.now()
  )
    throw invalidCursor();
  const manifest = parsed.data;
  if (filters) {
    const normalized = z.record(z.string(), JsonValueSchema).parse(filters);
    for (const [key, value] of Object.entries(normalized))
      if (
        !Object.hasOwn(manifest.filters, key) ||
        stable(value) !== stable(manifest.filters[key] ?? null)
      )
        throw validationError('Continuation filters must match the original normalized scope.', {
          reason: 'invalid_filter',
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
    filters: z.record(z.string(), JsonValueSchema).parse(options.filters ?? {}),
    provenance: z.record(z.string(), JsonValueSchema).parse(options.provenance),
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
  identifyFinal?: (record: JsonValue) => string;
  matches?: (record: JsonValue) => boolean;
  maxPages?: number;
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
async function windowRows(
  ctx: Context,
  manifest: Manifest,
  options: {
    records: JsonValue[];
    identify: (record: JsonValue) => string;
    provenance: Record<string, JsonValue>;
    buildResponse: ResponseBuilder;
    total?: number;
    offset?: number;
    forceCursor?: boolean;
  },
): Promise<{ response: object; consumed: number }> {
  const records: JsonValue[] = [];
  const handles: DeliveryWindow['record_handles'] = [];
  let consumed = 0;
  const make = (): object => {
    const more =
      options.forceCursor === true ||
      consumed < options.records.length ||
      !manifest.coverage.complete;
    const coverage = { ...manifest.coverage, ...(more ? { next_cursor: manifest.cursor } : {}) };
    const window: DeliveryWindow = {
      records,
      record_handles: handles,
      records_deferred: handles.length,
      records_returned: records.length,
      output_complete: !more,
      truncated: more || handles.length > 0,
      coverage,
      cursor_expires_at: new Date(manifest.expires).toISOString(),
      offset: options.offset ?? manifest.delivered,
      ...(more ? { next_cursor: manifest.cursor } : {}),
      ...(options.total === undefined ? {} : { total_records: options.total }),
    };
    return options.buildResponse(window, manifest.finalMetadata, manifest.provenance);
  };
  assertFits(make());
  for (const row of options.records) {
    records.push(row);
    consumed++;
    if (fullResultBytes(make()) <= FULL_RESULT_TARGET_BYTES) continue;
    records.pop();
    consumed--;
    if (records.length > 0 || handles.length > 0) break;
    const handle = await deferRecord(ctx, {
      scanId: manifest.id,
      tool: manifest.tool,
      identity: options.identify(row),
      value: row,
      expires: manifest.expires,
      provenance: options.provenance,
    });
    handles.push(handle);
    consumed++;
    assertFits(make());
  }
  const response = make();
  JsonValueSchema.parse(response);
  return { response, consumed };
}
/** Acquire bounded pages or drain a retained tail, publishing progress only after all writes succeed. */
export async function acquire(ctx: Context, options: AcquireOptions): Promise<AcquisitionResult> {
  const maxPages = z
    .number()
    .int()
    .min(1)
    .max(5)
    .parse(options.maxPages ?? 1);
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
    const affected = new Map<number, Set<string>>();
    const changedShards = new Set<number>();
    const replaced: string[] = [];
    const fetched: JsonValue[] = [];
    const identify = (row: JsonValue): string => options.source.identify(row);
    if (!next.pending.length && !next.coverage.complete) {
      for (let pageIndex = 0; pageIndex < maxPages && !next.coverage.complete; pageIndex++) {
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
          const id = z.string().min(1).parse(identify(row));
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
        if (page.upstreamCount !== undefined) next.coverage.upstream_count = page.upstreamCount;
        next.position = page.next;
        if (page.next === null) {
          next.coverage.complete = true;
          next.coverage.finished_at = new Date().toISOString();
        }
        // Once a response cannot deliver its entire tail, no more upstream work starts.
        if (
          !next.retainAll &&
          fullResultBytes(
            options.buildResponse(
              {
                records: next.pending,
                record_handles: [],
                records_deferred: 0,
                records_returned: next.pending.length,
                output_complete: false,
                truncated: true,
                coverage: { ...next.coverage, next_cursor: next.cursor },
                cursor_expires_at: new Date(next.expires).toISOString(),
                offset: next.delivered,
                next_cursor: next.cursor,
              },
              next.finalMetadata,
              next.provenance,
            ),
          ) > FULL_RESULT_TARGET_BYTES
        )
          break;
      }
    }
    if (next.retainAll && fetched.length) {
      for (let offset = 0; offset < fetched.length; offset += 125) {
        const key = `acquisition/chunk/${next.id}/${next.revision}/${offset / 125}`;
        await writeJson(ctx, key, fetched.slice(offset, offset + 125), next.expires);
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
      if (finalized.metadata)
        next.finalMetadata = z.record(z.string(), JsonValueSchema).parse(finalized.metadata);
    }
    const delivery = next.finalChunks
      ? await finalWindow(ctx, next, {
          identify:
            options.identifyFinal ??
            ((row) => createHash('sha256').update(stable(row)).digest('hex')),
          provenance: {
            ...next.provenance,
            coverage: JsonValueSchema.parse(next.coverage),
            cursor_expires_at: new Date(next.expires).toISOString(),
          },
          buildResponse: options.buildResponse,
        })
      : await windowRows(ctx, next, {
          records: next.pending,
          identify,
          provenance: {
            ...next.provenance,
            coverage: JsonValueSchema.parse(next.coverage),
            cursor_expires_at: new Date(next.expires).toISOString(),
          },
          buildResponse: options.buildResponse,
        });
    if (next.finalChunks) next.finalOffset = (next.finalOffset ?? 0) + delivery.consumed;
    else {
      next.pending = next.pending.slice(delivery.consumed);
      next.delivered += delivery.consumed;
    }
    next.replay = { cursor: incoming, response: JsonValueSchema.parse(delivery.response) };
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
    return { response: delivery.response, checkpoint: checkpoint(next) };
  });
}
/** Resolve original normalized filters/mode before constructing a source callback on continuation. */
export async function resolveCheckpoint(
  ctx: Context,
  options: { tool: string; cursor: string },
): Promise<AcquisitionCheckpoint> {
  if (!tokenSchema.safeParse(options.cursor).success) throw invalidCursor();
  const id = options.cursor.split('.')[0];
  const parsed = ManifestSchema.safeParse(await readJson(ctx, manifestKey(id ?? '')));
  if (!parsed.success) throw invalidCursor();
  const manifest = await load(ctx, options.cursor, options.tool, parsed.data.scanKind);
  return checkpoint(manifest);
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
    if (records.length === 125) await flush();
  }
  if (records.length) await flush();
  manifest.finalChunks = keys;
  manifest.finalCount = count;
  manifest.finalOffset = 0;
}
async function finalWindow(
  ctx: Context,
  manifest: Manifest,
  options: {
    identify: (record: JsonValue) => string;
    provenance: Record<string, JsonValue>;
    buildResponse: ResponseBuilder;
    maxRecords?: number;
  },
): Promise<{ response: object; consumed: number }> {
  const offset = manifest.finalOffset;
  const total = manifest.finalCount;
  if (offset === undefined || total === undefined || !manifest.finalChunks) throw invalidCursor();
  const key = manifest.finalChunks[Math.floor(offset / 125)];
  const chunk = key ? rowsSchema.safeParse(await readJson(ctx, key)) : undefined;
  if (chunk && !chunk.success) throw invalidCursor();
  if (!key && offset < total) throw invalidCursor();
  const remaining = (chunk?.data ?? []).slice(
    offset % 125,
    options.maxRecords === undefined ? undefined : (offset % 125) + options.maxRecords,
  );
  return windowRows(ctx, manifest, {
    records: remaining,
    identify: options.identify,
    provenance: options.provenance,
    buildResponse: options.buildResponse,
    total,
    offset,
    forceCursor: offset + remaining.length < total,
  });
}
/** Finalized arrays use the same bounded windows without acquiring or truncating more source data. */
export interface ServeResultsOptions {
  buildResponse: ResponseBuilder;
  cursor?: string;
  filters?: Record<string, JsonValue>;
  identify: (record: JsonValue) => string;
  maxRecords?: number;
  provenance: Record<string, JsonValue>;
  records?: JsonValue[];
  scanKind: string;
  tool: string;
}
/** Materialize immutable final chunks once, then page with exact totals and deferred-parent support. */
export async function serveResults(
  ctx: Context,
  options: ServeResultsOptions,
): Promise<AcquisitionResult> {
  const maxRecords = z
    .number()
    .int()
    .min(1)
    .max(125)
    .parse(options.maxRecords ?? 25);
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
    const delivery = await finalWindow(ctx, next, {
      ...options,
      maxRecords,
      provenance: {
        ...next.provenance,
        coverage: JsonValueSchema.parse(next.coverage),
        cursor_expires_at: new Date(next.expires).toISOString(),
      },
    });
    next.finalOffset = (next.finalOffset ?? 0) + delivery.consumed;
    next.replay = { cursor: incoming, response: JsonValueSchema.parse(delivery.response) };
    await writeJson(ctx, manifestKey(next.id), ManifestSchema.parse(next), next.expires);
    return { response: delivery.response, checkpoint: checkpoint(next) };
  });
}
