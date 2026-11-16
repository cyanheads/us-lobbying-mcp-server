/** @fileoverview Acquisition persistence, replay, count-bounded delivery and failure-boundary tests. @module tests/services/acquisition/acquisition-service */
import { Buffer } from 'node:buffer';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACQUISITION_TTL_MS } from '../../../src/domain/contracts.js';
import { formatResult } from '../../../src/domain/format.js';
import type { JsonValue } from '../../../src/domain/json.js';
import {
  acquire,
  iterateChunks,
  resolveCheckpoint,
  serveResults,
} from '../../../src/services/acquisition/acquisition-service.js';
import { readJson, writeJson } from '../../../src/services/acquisition/storage.js';
import type { DeliveryWindow, ResponseBuilder } from '../../../src/services/acquisition/types.js';

const buildResponse: ResponseBuilder = (window, metadata) => ({ ...window, ...metadata });
const base = {
  tool: 'uslobbying_search_filings',
  scanKind: 'filings',
  filters: { year: 2025 },
  provenance: { source: 'lda' },
  pageSize: 25,
  buildResponse,
};
const identify = (row: JsonValue): string =>
  String(row !== null && typeof row === 'object' && !Array.isArray(row) ? row.id : row);
/** A stub source serving each page in order; `next` is the following page index. */
function source(pages: JsonValue[][]) {
  return {
    identify,
    fetchPage: vi.fn(async (position: JsonValue) => {
      const index = position === null ? 0 : Number(position);
      return { records: pages[index] ?? [], next: index + 1 < pages.length ? index + 1 : null };
    }),
  };
}
function windowOf(response: object): DeliveryWindow {
  return response as DeliveryWindow;
}
async function collect(chunks: AsyncIterable<JsonValue[]>): Promise<JsonValue[]> {
  const rows: JsonValue[] = [];
  for await (const chunk of chunks) rows.push(...chunk);
  return rows;
}
/** The text surface decodes to exactly the structured response. */
function surfaces(response: object): void {
  const text = formatResult(response)[0]?.text ?? '';
  const fence = text.slice(0, text.indexOf('json\n'));
  expect(JSON.parse(text.slice(fence.length + 5, text.lastIndexOf(`\n${fence}`)))).toEqual(
    response,
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('revisioned acquisition', () => {
  it('aggregates latest partition envelope counts only after every partition is known', async () => {
    const ctx = createMockContext();
    const pages = [
      {
        records: [{ id: 'a' }, { id: 'a' }],
        upstreamCount: 4,
        partition: { index: 0, total: 2 },
        next: 1,
      },
      { records: [{ id: 'b' }], upstreamCount: 3, partition: { index: 0, total: 2 }, next: 2 },
      { records: [], upstreamCount: 0, partition: { index: 1, total: 2 }, next: null },
    ];
    const upstream = {
      identify,
      fetchPage: vi.fn(
        async (position: JsonValue) => pages[position === null ? 0 : Number(position)]!,
      ),
    };
    const first = await acquire(ctx, { ...base, source: upstream });
    expect(first.checkpoint.coverage).not.toHaveProperty('upstream_count');
    const second = await acquire(ctx, {
      ...base,
      source: upstream,
      cursor: first.checkpoint.cursor,
    });
    expect(second.checkpoint.coverage).not.toHaveProperty('upstream_count');
    const final = await acquire(ctx, {
      ...base,
      source: upstream,
      cursor: second.checkpoint.cursor,
    });
    expect(final.checkpoint.coverage).toMatchObject({
      upstream_count: 3,
      records_fetched: 3,
      unique_records: 2,
      complete: true,
    });
    expect(
      (await acquire(ctx, { ...base, source: upstream, cursor: second.checkpoint.cursor }))
        .response,
    ).toEqual(final.response);
    expect(upstream.fetchPage).toHaveBeenCalledTimes(3);
    surfaces(final.response);
  });
  it('keeps unknown partition counts absent and advances legacy manifests without inventing earlier counts', async () => {
    const ctx = createMockContext();
    const pages = [
      { records: [1], upstreamCount: 7, partition: { index: 0, total: 2 }, next: 1 },
      { records: [1], partition: { index: 1, total: 2 }, next: null },
    ];
    const upstream = {
      identify,
      fetchPage: vi.fn(
        async (position: JsonValue) => pages[position === null ? 0 : Number(position)]!,
      ),
    };
    const first = await acquire(ctx, { ...base, source: upstream });
    const key = `acquisition/scan/${first.checkpoint.cursor.split('.')[0]}`;
    const stored = (await ctx.state.get(key)) as Record<string, unknown>;
    delete stored.partitions;
    await ctx.state.set(key, stored);
    const final = await acquire(ctx, {
      ...base,
      source: upstream,
      cursor: first.checkpoint.cursor,
    });
    expect(final.checkpoint.coverage).toMatchObject({
      complete: true,
      records_fetched: 2,
      unique_records: 1,
    });
    expect(final.checkpoint.coverage).not.toHaveProperty('upstream_count');
    expect(final.checkpoint.partitions).toEqual({
      total: 2,
      observed: { '1': { recordsFetched: 1, completeHistory: false } },
    });
    surfaces(final.response);
  });
  it('distinguishes unavailable state from unreadable values and provider failures', async () => {
    const ctx = createMockContext();
    await expect(readJson(ctx, 'missing')).rejects.toMatchObject({
      message: 'The continuation is unavailable; restart the original scoped request.',
      data: { reason: 'cursor_invalid' },
    });
    const get = vi.spyOn(ctx.state, 'get');
    get.mockResolvedValueOnce(Number.NaN);
    await expect(readJson(ctx, 'malformed')).rejects.toMatchObject({
      message: 'The stored acquisition is unreadable; restart the original scoped request.',
      data: { reason: 'cursor_invalid' },
    });
    get.mockRejectedValueOnce(new Error('provider failed'));
    await expect(readJson(ctx, 'broken')).rejects.toMatchObject({
      message: 'The stored acquisition is unreadable; restart the original scoped request.',
    });
    const controller = new AbortController();
    const cancellation = new DOMException('caller cancelled read', 'AbortError');
    get.mockImplementationOnce(async () => {
      controller.abort(cancellation);
      return null;
    });
    await expect(readJson({ ...ctx, signal: controller.signal }, 'cancelled')).rejects.toBe(
      cancellation,
    );
  });
  it('refuses default-provider entry exhaustion and admits work after absolute expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2090-01-01'));
    const ctx = createMockContext();
    const expires = Date.now() + 1000;
    for (let index = 0; index < 9900; index++)
      await writeJson(ctx, `capacity/${index}`, index, expires);
    const upstream = source([[1]]);
    await expect(acquire(ctx, { ...base, source: upstream })).rejects.toMatchObject({
      data: { reason: 'acquisition_storage_unavailable' },
    });
    vi.advanceTimersByTime(1001);
    expect(windowOf((await acquire(ctx, { ...base, source: upstream })).response).records).toEqual([
      1,
    ]);
  });
  it('honors the requested result page size', async () => {
    const ctx = createMockContext();
    const options = { ...base, pageSize: 2, records: [1, 2, 3, 4, 5] };
    const first = await serveResults(ctx, options);
    expect(windowOf(first.response).records).toEqual([1, 2]);
    const second = await serveResults(ctx, { ...options, cursor: first.checkpoint.cursor });
    expect(windowOf(second.response).records).toEqual([3, 4]);
    const third = await serveResults(ctx, { ...options, cursor: second.checkpoint.cursor });
    expect(windowOf(third.response).records).toEqual([5]);
    expect(windowOf(third.response).output_complete).toBe(true);
  });
  it('pins source snapshot provenance for a later result continuation', async () => {
    const ctx = createMockContext();
    const provenance = {
      source: 'fara',
      retrieved_at: '2026-01-01T00:00:00Z',
      snapshot_source_urls: ['https://efile.fara.gov/bulk/registrants.zip'],
    };
    const first = await serveResults(ctx, {
      ...base,
      provenance,
      records: Array.from({ length: 126 }, (_, id) => ({ id })),
    });
    const recovered = await resolveCheckpoint(ctx, {
      tool: base.tool,
      cursor: first.checkpoint.cursor,
    });
    expect(recovered).toMatchObject({ provenance });
    const continued = await serveResults(ctx, {
      ...base,
      cursor: first.checkpoint.cursor,
      provenance: { source: 'fara', retrieved_at: '2026-10-25T00:00:00Z' },
      buildResponse: (window, metadata, storedProvenance) => ({
        ...storedProvenance,
        ...window,
        ...metadata,
      }),
    });
    expect(continued.response).toMatchObject(provenance);
    surfaces(continued.response);
  });
  it('traverses four pages, deduplicates identities and replays without fetching', async () => {
    const ctx = createMockContext();
    const upstream = source([
      [{ id: 'a' }],
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'c' }],
      [{ id: 'd' }],
    ]);
    const first = await acquire(ctx, { ...base, source: upstream });
    const second = await acquire(ctx, {
      ...base,
      source: upstream,
      cursor: first.checkpoint.cursor,
    });
    const replay = await acquire(ctx, {
      ...base,
      source: upstream,
      cursor: first.checkpoint.cursor,
    });
    expect(replay.response).toEqual(second.response);
    expect(upstream.fetchPage).toHaveBeenCalledTimes(2);
    const third = await acquire(ctx, {
      ...base,
      source: upstream,
      cursor: second.checkpoint.cursor,
    });
    await expect(
      acquire(ctx, { ...base, source: upstream, cursor: first.checkpoint.cursor }),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
    const fourth = await acquire(ctx, {
      ...base,
      source: upstream,
      cursor: third.checkpoint.cursor,
    });
    expect(
      [first, second, third, fourth].flatMap((result) => windowOf(result.response).records),
    ).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    expect(fourth.checkpoint.coverage).toMatchObject({
      complete: true,
      pages_fetched: 4,
      records_fetched: 5,
      unique_records: 4,
    });
    for (const result of [first, second, third, fourth]) surfaces(result.response);
  });
  it('binds cursor to tool, normalized filters, scan kind and tenant', async () => {
    const ctx = createMockContext();
    const upstream = source([[1], [2]]);
    const first = await acquire(ctx, { ...base, source: upstream });
    const continuation = { ...base, source: upstream, cursor: first.checkpoint.cursor };
    await expect(acquire(ctx, { ...continuation, tool: 'another_tool' })).rejects.toMatchObject({
      data: { reason: 'cursor_invalid' },
    });
    await expect(acquire(ctx, { ...continuation, scanKind: 'another_scan' })).rejects.toMatchObject(
      { data: { reason: 'cursor_invalid' } },
    );
    await expect(acquire(ctx, { ...continuation, filters: { year: 2024 } })).rejects.toMatchObject({
      data: { reason: 'cursor_invalid' },
    });
    await expect(
      acquire(
        { ...ctx, tenantId: 'foreign', state: createMockContext({ tenantId: 'foreign' }).state },
        continuation,
      ),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
    expect(upstream.fetchPage).toHaveBeenCalledTimes(1);
  });
  it('rejects repeated source positions without publishing the failed page', async () => {
    const ctx = createMockContext();
    const upstream = source([[1], [2], [3]]);
    const first = await acquire(ctx, { ...base, source: upstream });
    const fetchPage = vi.fn(async () => ({ records: [2], next: 1 }));
    await expect(
      acquire(ctx, { ...base, source: { identify, fetchPage }, cursor: first.checkpoint.cursor }),
    ).rejects.toMatchObject({ data: { reason: 'pagination_invalid' } });
    expect(
      (await resolveCheckpoint(ctx, { tool: base.tool, cursor: first.checkpoint.cursor })).coverage
        .pages_fetched,
    ).toBe(1);
  });
  it('finalizes complete retained scans once and delivers every materialized row', async () => {
    const ctx = createMockContext();
    const upstream = source([[1], [2], [3]]);
    const rows = Array.from({ length: 280 }, (_, id) => ({
      id,
      document: 'https://lda.gov/a.pdf',
      text: '🌲'.repeat(70),
    }));
    const finalize = vi.fn(async ({ chunks }: { chunks: AsyncIterable<JsonValue[]> }) => {
      const acquired: JsonValue[] = [];
      for await (const chunk of chunks) acquired.push(...chunk);
      expect(acquired).toEqual([1, 2, 3]);
      return { records: rows, metadata: { total_usd: '123.45' } };
    });
    let result = await acquire(ctx, { ...base, source: upstream, retainAll: true, finalize });
    expect(result.response).not.toHaveProperty('total_usd');
    await expect(collect(iterateChunks(ctx, result.checkpoint))).rejects.toMatchObject({
      data: { reason: 'acquisition_incomplete' },
    });
    result = await acquire(ctx, {
      ...base,
      source: upstream,
      retainAll: true,
      finalize,
      cursor: result.checkpoint.cursor,
    });
    expect(result.response).not.toHaveProperty('total_usd');
    const delivered: JsonValue[] = [];
    for (let calls = 0; calls < 100; calls++) {
      result = await acquire(ctx, {
        ...base,
        source: upstream,
        retainAll: true,
        finalize,
        cursor: result.checkpoint.cursor,
      });
      surfaces(result.response);
      expect(result.response).toHaveProperty('total_usd', '123.45');
      delivered.push(...windowOf(result.response).records);
      if (windowOf(result.response).output_complete) break;
    }
    expect(delivered).toEqual(rows);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(upstream.fetchPage).toHaveBeenCalledTimes(3);
  });
  it('keeps the published checkpoint after provider write failure and permits retry', async () => {
    const ctx = createMockContext();
    const upstream = source([[1], [2]]);
    const first = await acquire(ctx, { ...base, source: upstream });
    const set = vi.spyOn(ctx.state, 'set').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(
      acquire(ctx, { ...base, source: upstream, cursor: first.checkpoint.cursor }),
    ).rejects.toMatchObject({ data: { reason: 'acquisition_storage_unavailable' } });
    set.mockRestore();
    expect(
      (await resolveCheckpoint(ctx, { tool: base.tool, cursor: first.checkpoint.cursor })).revision,
    ).toBe(1);
    expect(
      windowOf(
        (await acquire(ctx, { ...base, source: upstream, cursor: first.checkpoint.cursor }))
          .response,
      ).records,
    ).toEqual([2]);
  });
  it('preserves the previous manifest when publication fails after chunk writes', async () => {
    const ctx = createMockContext();
    const upstream = source([[1], [2], [3]]);
    const first = await acquire(ctx, { ...base, source: upstream, retainAll: true });
    const original = ctx.state.set.bind(ctx.state);
    const set = vi.spyOn(ctx.state, 'set').mockImplementation(async (key, value, opts) => {
      if (key.startsWith('acquisition/scan/')) throw new Error('publication failed');
      await original(key, value, opts);
    });
    await expect(
      acquire(ctx, { ...base, source: upstream, retainAll: true, cursor: first.checkpoint.cursor }),
    ).rejects.toMatchObject({ data: { reason: 'acquisition_storage_unavailable' } });
    set.mockRestore();
    const stored = await resolveCheckpoint(ctx, {
      tool: base.tool,
      cursor: first.checkpoint.cursor,
    });
    expect(stored.chunkKeys).toEqual(first.checkpoint.chunkKeys);
    expect(stored.coverage.pages_fetched).toBe(1);
    const retried = await acquire(ctx, {
      ...base,
      source: upstream,
      retainAll: true,
      cursor: first.checkpoint.cursor,
    });
    expect(retried.checkpoint.coverage).toMatchObject({
      pages_fetched: 2,
      records_fetched: 2,
      unique_records: 2,
    });
  });
  it('rejects a missing retained chunk and absolute expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01'));
    const ctx = createMockContext();
    const first = await acquire(ctx, { ...base, source: source([[1]]), retainAll: true });
    await ctx.state.delete(first.checkpoint.chunkKeys[0] ?? 'missing');
    await expect(collect(iterateChunks(ctx, first.checkpoint))).rejects.toMatchObject({
      data: { reason: 'cursor_invalid' },
    });
    vi.advanceTimersByTime(ACQUISITION_TTL_MS);
    await expect(
      resolveCheckpoint(ctx, { tool: base.tool, cursor: first.checkpoint.cursor }),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
  });
  it('stops on caller cancellation before fetching', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const upstream = source([[1]]);
    await expect(
      acquire(createMockContext({ signal: controller.signal }), { ...base, source: upstream }),
    ).rejects.toThrow('caller cancelled');
    expect(upstream.fetchPage).not.toHaveBeenCalled();
  });
  it('rejects simultaneous mutations of the same cursor and releases the lock', async () => {
    const ctx = createMockContext();
    const first = await acquire(ctx, { ...base, source: source([[1], [2]]) });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fetchPage = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return { records: [2], next: null };
    });
    const continuation = {
      ...base,
      source: { identify, fetchPage },
      cursor: first.checkpoint.cursor,
    };
    const pending = acquire(ctx, continuation);
    await entered.promise;
    await expect(acquire(ctx, continuation)).rejects.toMatchObject({
      data: { reason: 'acquisition_busy', retryable: true },
    });
    release.resolve();
    const done = await pending;
    expect((await acquire(ctx, continuation)).response).toEqual(done.response);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
  it('preserves the next page when the per-call deadline ends between exchanges', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01'));
    const ctx = createMockContext();
    const fetchPage = vi.fn(async (position: JsonValue) => {
      const index = position === null ? 0 : Number(position);
      vi.advanceTimersByTime(44_100);
      return { records: [index], next: index < 2 ? index + 1 : null };
    });
    const upstream = { identify, fetchPage };
    let result = await acquire(ctx, { ...base, source: upstream, maxPages: 5 });
    expect(result.checkpoint.coverage.pages_fetched).toBe(1);
    const rows = [...windowOf(result.response).records];
    for (let call = 0; call < 2; call++) {
      result = await acquire(ctx, {
        ...base,
        source: upstream,
        maxPages: 5,
        cursor: result.checkpoint.cursor,
      });
      rows.push(...windowOf(result.response).records);
    }
    expect(rows).toEqual([0, 1, 2]);
    expect(result.checkpoint.coverage.complete).toBe(true);
  });
  it('does not publish cancelled source work and retries its original position', async () => {
    const ctx = createMockContext();
    const first = await acquire(ctx, { ...base, source: source([[1], [2]]) });
    const controller = new AbortController();
    const fetchPage = vi.fn(async (_position: JsonValue, signal: AbortSignal) => {
      controller.abort(new Error('cancelled in exchange'));
      signal.throwIfAborted();
      return { records: [2], next: null };
    });
    await expect(
      acquire(
        { ...ctx, signal: controller.signal },
        { ...base, source: { identify, fetchPage }, cursor: first.checkpoint.cursor },
      ),
    ).rejects.toThrow('cancelled in exchange');
    expect(
      (await resolveCheckpoint(ctx, { tool: base.tool, cursor: first.checkpoint.cursor })).revision,
    ).toBe(1);
    expect(
      windowOf(
        (
          await acquire(ctx, {
            ...base,
            source: source([[1], [2]]),
            cursor: first.checkpoint.cursor,
          })
        ).response,
      ).records,
    ).toEqual([2]);
  });
});

/** A stub source serving `total` numbered rows in upstream pages of `perPage`. */
function numbered(total: number, perPage = 25) {
  const pages = Array.from({ length: Math.ceil(total / perPage) }, (_, page) =>
    Array.from({ length: Math.min(perPage, total - page * perPage) }, (_, row) => ({
      id: page * perPage + row,
    })),
  );
  return source(pages.length ? pages : [[]]);
}
const ids = (rows: JsonValue[]) => rows.map((row) => (row as { id: number }).id);
const range = (start: number, end: number) =>
  Array.from({ length: end - start }, (_, index) => start + index);

describe('count-bounded delivery', () => {
  it('delivers 30 matches at page size 10 as 10, 10, 10, topping up from upstream page 2 on the third call', async () => {
    const ctx = createMockContext();
    const upstream = numbered(30);
    const options = { ...base, pageSize: 10, source: upstream };
    const windows: DeliveryWindow[] = [];
    const fetches: number[] = [];
    let cursor: string | undefined;
    for (let call = 0; call < 3; call++) {
      const result = await acquire(ctx, { ...options, ...(cursor ? { cursor } : {}) });
      windows.push(windowOf(result.response));
      fetches.push(upstream.fetchPage.mock.calls.length);
      cursor = result.checkpoint.cursor;
    }
    expect(windows.map(({ records }) => records.length)).toEqual([10, 10, 10]);
    expect(fetches).toEqual([1, 1, 2]);
    expect(windows.flatMap(({ records }) => ids(records))).toEqual(range(0, 30));
    expect(windows.map(({ offset }) => offset)).toEqual([0, 10, 20]);
    expect(windows.map(({ output_complete }) => output_complete)).toEqual([false, false, true]);
    expect(windows[2]).not.toHaveProperty('next_cursor');
  });
  it('stops topping up once page size matches are pending', async () => {
    const ctx = createMockContext();
    const upstream = numbered(25, 5);
    const result = await acquire(ctx, {
      ...base,
      pageSize: 4,
      maxPages: 5,
      source: upstream,
      matches: (row) => (row as { id: number }).id % 5 < 2,
    });
    expect(upstream.fetchPage).toHaveBeenCalledTimes(2);
    expect(ids(windowOf(result.response).records)).toEqual([0, 1, 5, 6]);
    expect(windowOf(result.response).next_cursor).toBe(result.checkpoint.cursor);
  });
  it('bounds the top-up by max pages and returns the short page with a cursor while collecting', async () => {
    const ctx = createMockContext();
    const upstream = numbered(12, 3);
    const options = { ...base, pageSize: 10, maxPages: 2, source: upstream };
    const first = await acquire(ctx, options);
    expect(upstream.fetchPage).toHaveBeenCalledTimes(2);
    expect(windowOf(first.response)).toMatchObject({
      records_returned: 6,
      output_complete: false,
      next_cursor: first.checkpoint.cursor,
    });
    const second = await acquire(ctx, { ...options, cursor: first.checkpoint.cursor });
    expect(upstream.fetchPage).toHaveBeenCalledTimes(4);
    expect(ids(windowOf(second.response).records)).toEqual(range(6, 12));
    expect(windowOf(second.response).output_complete).toBe(true);
  });
  it('ends an exact multiple of page size without an empty trailing window', async () => {
    const ctx = createMockContext();
    const upstream = numbered(20);
    const first = await acquire(ctx, { ...base, pageSize: 10, source: upstream });
    const second = await acquire(ctx, {
      ...base,
      pageSize: 10,
      source: upstream,
      cursor: first.checkpoint.cursor,
    });
    expect([first, second].map((result) => windowOf(result.response).records.length)).toEqual([
      10, 10,
    ]);
    expect(windowOf(second.response).output_complete).toBe(true);
    expect(windowOf(second.response)).not.toHaveProperty('next_cursor');
    const served = { ...base, pageSize: 20, records: range(0, 40) };
    const head = await serveResults(ctx, served);
    const tail = await serveResults(ctx, { ...served, cursor: head.checkpoint.cursor });
    expect(windowOf(head.response).output_complete).toBe(false);
    expect(windowOf(tail.response)).toMatchObject({
      records: range(20, 40),
      output_complete: true,
    });
    expect(windowOf(tail.response)).not.toHaveProperty('next_cursor');
  });
  it('fails a continuation whose top-up fetch fails, keeping its pending rows for a retry of the same cursor', async () => {
    const ctx = createMockContext();
    const upstream = numbered(30, 12);
    const options = { ...base, pageSize: 10, source: upstream };
    const first = await acquire(ctx, options);
    expect(ids(windowOf(first.response).records)).toEqual(range(0, 10));
    // Two matches remain pending, fewer than page_size, so the continuation fetches upstream page 2.
    upstream.fetchPage.mockRejectedValueOnce(new Error('Synthetic upstream outage'));
    await expect(acquire(ctx, { ...options, cursor: first.checkpoint.cursor })).rejects.toThrow(
      'Synthetic upstream outage',
    );
    expect(
      (await resolveCheckpoint(ctx, { tool: base.tool, cursor: first.checkpoint.cursor })).revision,
    ).toBe(1);
    const retried = await acquire(ctx, { ...options, cursor: first.checkpoint.cursor });
    expect(ids(windowOf(retried.response).records)).toEqual(range(10, 20));
    expect(windowOf(retried.response).offset).toBe(10);
    expect(upstream.fetchPage).toHaveBeenCalledTimes(3);
  });
  it('reads retained windows across 125-row storage chunks and replays a crossing window', async () => {
    const ctx = createMockContext();
    const rows = range(0, 300).map((id) => ({ id }));
    const options = {
      ...base,
      pageSize: 20,
      source: source([[1]]),
      retainAll: true,
      finalize: async () => ({ records: rows }),
    };
    // One upstream page completes the scan, so the first call already delivers final rows.
    let result = await acquire(ctx, options);
    const windows: DeliveryWindow[] = [windowOf(result.response)];
    let replayed = 0;
    while (!windows.at(-1)?.output_complete) {
      const cursor = result.checkpoint.cursor;
      result = await acquire(ctx, { ...options, cursor });
      windows.push(windowOf(result.response));
      if (windowOf(result.response).offset !== 120) continue;
      const replay = await acquire(ctx, { ...options, cursor });
      expect(replay.response).toEqual(result.response);
      replayed++;
    }
    expect(replayed).toBe(1);
    expect(windows.map(({ records }) => records.length)).toEqual(Array(15).fill(20));
    expect(windows.map(({ offset }) => offset)).toEqual(range(0, 15).map((n) => n * 20));
    expect(windows.every(({ total_records }) => total_records === 300)).toBe(true);
    expect(windows.flatMap(({ records }) => records)).toEqual(rows);
    expect(ids(windows[6]?.records ?? [])).toEqual(range(120, 140));
  });
  it('serves fixed result windows across chunk boundaries', async () => {
    const ctx = createMockContext();
    const fixed = { ...base, pageSize: 125, records: range(0, 300) };
    const lengths: number[] = [];
    let result = await serveResults(ctx, fixed);
    lengths.push(windowOf(result.response).records.length);
    while (!windowOf(result.response).output_complete) {
      result = await serveResults(ctx, { ...fixed, cursor: result.checkpoint.cursor });
      lengths.push(windowOf(result.response).records.length);
    }
    expect(lengths).toEqual([125, 125, 50]);
    const small = { ...base, pageSize: 20, records: range(0, 300) };
    result = await serveResults(ctx, small);
    while (windowOf(result.response).offset < 120)
      result = await serveResults(ctx, { ...small, cursor: result.checkpoint.cursor });
    expect(windowOf(result.response)).toMatchObject({ offset: 120, records: range(120, 140) });
  });
  it('delivers records far over 24,000 bytes whole on both response surfaces', async () => {
    const ctx = createMockContext();
    const big = (id: number) => ({
      id,
      text: `${'漢字🌲'.repeat(4000)}${'x'.repeat(30_000)}`,
      document: 'https://lda.gov/a.pdf',
    });
    const sourced = await acquire(ctx, {
      ...base,
      pageSize: 3,
      source: source([[big(1), big(2), big(3), big(4)]]),
    });
    expect(windowOf(sourced.response).records).toEqual([big(1), big(2), big(3)]);
    expect(sourced.response).not.toHaveProperty('record_handles');
    surfaces(sourced.response);
    expect(Buffer.byteLength(JSON.stringify(sourced.response), 'utf8')).toBeGreaterThan(3 * 24_000);
    const retained = await acquire(ctx, {
      ...base,
      tool: 'uslobbying_get_issue_spending',
      pageSize: 2,
      source: source([[1]]),
      retainAll: true,
      finalize: async () => ({ records: [big(5), big(6)] }),
    });
    expect(windowOf(retained.response).records).toEqual([big(5), big(6)]);
    surfaces(retained.response);
  });
  it('rejects a page size that is not a positive integer', async () => {
    const ctx = createMockContext();
    for (const pageSize of [0, -1, 2.5])
      await expect(
        acquire(ctx, { ...base, pageSize, source: source([[1]]) }),
      ).rejects.toMatchObject({ name: 'ZodError' });
  });
});

describe('delivery window fields (characterization)', () => {
  it('reports result-window offsets, totals and continuation fields', async () => {
    const ctx = createMockContext();
    const options = { ...base, pageSize: 2, records: [1, 2, 3, 4, 5] };
    const first = await serveResults(ctx, options);
    const second = await serveResults(ctx, { ...options, cursor: first.checkpoint.cursor });
    const replay = await serveResults(ctx, { ...options, cursor: first.checkpoint.cursor });
    const third = await serveResults(ctx, { ...options, cursor: second.checkpoint.cursor });
    expect(replay.response).toEqual(second.response);
    const windows = [first, second, third].map((result) => windowOf(result.response));
    expect(windows.map(({ records }) => records)).toEqual([[1, 2], [3, 4], [5]]);
    expect(windows.map(({ offset }) => offset)).toEqual([0, 2, 4]);
    expect(windows.map(({ total_records }) => total_records)).toEqual([5, 5, 5]);
    expect(windows.map(({ records_returned }) => records_returned)).toEqual([2, 2, 1]);
    expect(windows.map(({ output_complete }) => output_complete)).toEqual([false, false, true]);
    expect(windows.map(({ truncated }) => truncated)).toEqual([true, true, false]);
    expect(windows[0]?.next_cursor).toBe(first.checkpoint.cursor);
    expect(windows[0]?.coverage.next_cursor).toBe(first.checkpoint.cursor);
    expect(windows[2]).not.toHaveProperty('next_cursor');
    expect(windows[2]?.coverage).not.toHaveProperty('next_cursor');
  });
  it('reports pending-path offsets without a total', async () => {
    const ctx = createMockContext();
    const upstream = source([[1], [2]]);
    const first = await acquire(ctx, { ...base, source: upstream });
    const second = await acquire(ctx, {
      ...base,
      source: upstream,
      cursor: first.checkpoint.cursor,
    });
    expect(windowOf(first.response)).toMatchObject({
      records: [1],
      offset: 0,
      records_returned: 1,
      output_complete: false,
      next_cursor: first.checkpoint.cursor,
    });
    expect(windowOf(second.response)).toMatchObject({
      records: [2],
      offset: 1,
      records_returned: 1,
      output_complete: true,
    });
    for (const result of [first, second])
      expect(windowOf(result.response)).not.toHaveProperty('total_records');
    expect(windowOf(second.response)).not.toHaveProperty('next_cursor');
  });
  it('returns an empty complete window for an empty scope', async () => {
    const ctx = createMockContext();
    const sourced = windowOf((await acquire(ctx, { ...base, source: source([[]]) })).response);
    expect(sourced).toMatchObject({ records: [], offset: 0, output_complete: true });
    expect(sourced).not.toHaveProperty('next_cursor');
    const served = windowOf((await serveResults(ctx, { ...base, records: [] })).response);
    expect(served).toMatchObject({
      records: [],
      offset: 0,
      total_records: 0,
      output_complete: true,
    });
  });
  it('returns an empty complete window when continuing past the delivered end', async () => {
    const ctx = createMockContext();
    const options = { ...base, pageSize: 3, records: [1, 2, 3] };
    const first = await serveResults(ctx, options);
    expect(windowOf(first.response).output_complete).toBe(true);
    const past = windowOf(
      (await serveResults(ctx, { ...options, cursor: first.checkpoint.cursor })).response,
    );
    expect(past).toMatchObject({ records: [], offset: 3, total_records: 3, output_complete: true });
    expect(past).not.toHaveProperty('next_cursor');
  });
});
