/** @fileoverview Recursive retained-record reconstruction and cursor-independent lifetime tests. @module tests/services/acquisition/record-window */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordWindowSchema } from '../../../src/domain/contracts.js';
import { formatResult } from '../../../src/domain/format.js';
import { type JsonValue, JsonValueSchema } from '../../../src/domain/json.js';
import { serveResults } from '../../../src/services/acquisition/acquisition-service.js';
import { readRecordWindow } from '../../../src/services/acquisition/record-window.js';
import type { DeliveryWindow } from '../../../src/services/acquisition/types.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const tool = 'uslobbying_search_filings';
const options = {
  tool,
  scanKind: 'test',
  provenance: { source: 'lda', document: 'https://lda.gov/a.pdf' },
  identify: () => 'parent',
  buildResponse: (window: DeliveryWindow) => ({ ...window }),
};

describe('deferred records', () => {
  it('retains complete coverage and expiry in a finalized deferred parent', async () => {
    const ctx = createMockContext();
    const result = await serveResults(ctx, { ...options, records: [{ huge: 'x'.repeat(20_000) }] });
    const record_handle =
      (result.response as DeliveryWindow).record_handles[0]?.record_handle ?? '';
    const response = await readRecordWindow(ctx, { tool, record_handle });
    expect(response).toMatchObject({
      coverage: { complete: true, records_fetched: 1, unique_records: 1 },
      cursor_expires_at: result.checkpoint.expiresAt,
    });
  });
  it('reconstructs oversized recursive objects, arrays, escaped keys and Unicode exactly on both surfaces', async () => {
    const ctx = createMockContext();
    const record = {
      id: 'parent',
      'a/b~c': {
        constructor: { future: true },
        nested: Array.from({ length: 70 }, (_, id) => ({
          id,
          unknown: '漢🌲é'.repeat(1000),
          list: [null, false, 0, '', [], {}],
        })),
      },
      trailing: 'tail',
      oversized_text: '🌲漢'.repeat(4000),
      document: 'https://lda.gov/a.pdf',
    };
    const result = await serveResults(ctx, {
      ...options,
      records: [record, ...Array.from({ length: 30 }, (_, id) => ({ id }))],
    });
    const first = result.response as DeliveryWindow;
    expect(first.records).not.toContainEqual(record);
    expect(first.records_deferred).toBe(1);
    const handle = first.record_handles[0]?.record_handle ?? '';
    expect(first.record_handles[0]?.record_bytes).toBe(
      Buffer.byteLength(JSON.stringify(record), 'utf8'),
    );
    await serveResults(ctx, { ...options, cursor: result.checkpoint.cursor });
    let calls = 0;
    async function reconstruct(path: string): Promise<JsonValue> {
      let offset = 0;
      let text = '';
      let container: JsonValue[] | Record<string, JsonValue> | undefined;
      do {
        const response = await readRecordWindow(ctx, {
          tool,
          record_handle: handle,
          record_path: path,
          record_offset: offset,
        });
        const content = formatResult(response);
        const rendered = content[0]?.text ?? '';
        const fence = rendered.slice(0, rendered.indexOf('json\n'));
        expect(
          JSON.parse(rendered.slice(fence.length + 5, rendered.lastIndexOf(`\n${fence}`))),
        ).toEqual(response);
        expect(
          Buffer.byteLength(JSON.stringify({ content, structuredContent: response }), 'utf8') + 512,
        ).toBeLessThanOrEqual(24_000);
        const parsed = JsonValueSchema.parse(response);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('Expected record envelope');
        const window = RecordWindowSchema.parse(parsed.record_window);
        calls++;
        if (window.kind === 'scalar') return window.value;
        if (window.kind === 'string') {
          text += window.text;
          if (window.next_offset === undefined) return text;
        } else {
          container ??= window.kind === 'array' ? [] : Object.create(null);
          if (window.kind === 'array') {
            for (const item of window.items) {
              const value = Object.hasOwn(item, 'value')
                ? JsonValueSchema.parse(item.value)
                : await reconstruct(item.path);
              (container as JsonValue[])[item.index] = value;
            }
          } else {
            for (const entry of window.entries) {
              const value = Object.hasOwn(entry, 'value')
                ? JsonValueSchema.parse(entry.value)
                : await reconstruct(entry.path);
              (container as Record<string, JsonValue>)[entry.key] = value;
            }
          }
          if (window.next_offset === undefined) return container ?? null;
        }
        if (window.next_offset === undefined || window.next_offset <= offset)
          throw new Error('Window did not advance');
        offset = window.next_offset;
      } while (offset > 0);
      throw new Error('Record window ended without a value');
    }
    expect(await reconstruct('')).toEqual(record);
    expect(calls).toBeGreaterThan(10);
    for (const path of [
      'not-pointer',
      '/a~2b',
      '/a~',
      '/missing',
      '/__proto__',
      '/a~1b~0c/nested/01',
      '/a~1b~0c/nested/-1',
    ]) {
      await expect(
        readRecordWindow(ctx, { tool, record_handle: handle, record_path: path }),
      ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
    }
    await expect(
      readRecordWindow(ctx, { tool: 'wrong', record_handle: handle }),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
    await expect(
      readRecordWindow(createMockContext({ tenantId: 'foreign' }), { tool, record_handle: handle }),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
    await expect(
      readRecordWindow(ctx, {
        tool,
        record_handle: handle,
        record_path: '/trailing',
        record_offset: 4,
      }),
    ).resolves.toMatchObject({
      record_window: { kind: 'string', text: '', returned: 0, complete: true },
    });
    await expect(
      readRecordWindow(ctx, {
        tool,
        record_handle: handle,
        record_path: '/trailing',
        record_offset: 6,
      }),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
  });
  it('delivers empty collections and refuses an envelope that leaves no room', async () => {
    const ctx = createMockContext();
    const result = await serveResults(ctx, {
      ...options,
      records: [{ huge: 'x'.repeat(20_000), empty: [], scalar: null }],
    });
    const record_handle =
      (result.response as DeliveryWindow).record_handles[0]?.record_handle ?? '';
    await expect(
      readRecordWindow(ctx, { tool, record_handle, record_path: '/empty' }),
    ).resolves.toMatchObject({
      record_window: { kind: 'array', total: 0, returned: 0, complete: true, items: [] },
    });
    await expect(
      readRecordWindow(ctx, { tool, record_handle, record_path: '/scalar', record_offset: 1 }),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
    await expect(
      readRecordWindow(ctx, {
        tool,
        record_handle,
        buildResponse: (window) => ({ window, metadata: 'x'.repeat(25_000) }),
      }),
    ).rejects.toMatchObject({ data: { reason: 'result_too_large' } });
  });
});
