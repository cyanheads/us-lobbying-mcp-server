/** @fileoverview Reference vocabularies through runtime contracts with real source parsing. @module tests/tools/list-reference */
import { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_CACHE_TTL_MS } from '../../src/domain/contracts.js';
import { listReference } from '../../src/mcp-server/tools/definitions/list-reference.tool.js';
import { initFaraService } from '../../src/services/fara/fara-service.js';
import { getLdaService, initLdaService } from '../../src/services/lda/lda-service.js';
import { principal, snapshotResponse } from '../services/fara/fixtures.js';

let calls: URL[];
let body: unknown;
beforeEach(() => {
  vi.useFakeTimers();
  // Expire module-owned public vocabulary cache between tests without resetting source modules.
  vi.setSystemTime(new Date(2030, 0, 1 + 3 * testDay++));
  calls = [];
  body = [
    { value: 'TEC', name: 'Telecommunications' },
    { value: 'SCI', name: 'Science Technology' },
    { value: 'HCR', name: 'Health Issues' },
  ];
  initLdaService({
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://lda.gov') throw new Error('Unexpected source');
      calls.push(url);
      return Response.json(body);
    },
  });
});
let testDay = 0;
afterEach(() => {
  getLdaService().dispose();
  vi.useRealTimers();
});
async function invoke(input: Record<string, unknown>) {
  const definition: Parameters<typeof runToolContract>[0] = listReference;
  const pending = runToolContract(definition, input);
  await vi.runAllTimersAsync();
  const result = await pending;
  const data = z.record(z.string(), z.unknown()).parse(result.structuredContent);
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  if (!result.isError) {
    expect(listReference.output!.parse(data)).toEqual(data);
    const fence = text.slice(0, text.indexOf('json\n'));
    expect(
      JSON.parse(text.slice(fence.length + 5, text.indexOf(`\n${fence}`, fence.length + 5))),
    ).toEqual(data);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength + 512).toBeLessThanOrEqual(
      24_000,
    );
  }
  return { result, data, text };
}
describe('reference contracts', () => {
  it('shares one 45-second budget across LDA constants retries and the FARA country snapshot', async () => {
    const started = Date.now();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Synthetic timeout', 'TimeoutError')), ms);
      return controller.signal;
    });
    let constants = 0;
    const starts: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(['https://lda.gov', 'https://efile.fara.gov']).toContain(url.origin);
      starts.push(url.origin);
      const reference = url.origin === 'https://lda.gov';
      const attempt = reference ? ++constants : 0;
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        signal?.throwIfAborted();
        const timer = setTimeout(
          () => {
            signal?.removeEventListener('abort', abort);
            resolve(
              reference
                ? attempt === 1
                  ? new Response('temporary', { status: 503 })
                  : Response.json([{ value: 'CA', name: 'Canada' }])
                : snapshotResponse('foreign_principals', principal('001', 'Synthetic', 'Canada')),
            );
          },
          reference ? 17_000 : 19_000,
        );
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
    };
    getLdaService().dispose();
    initLdaService({ fetch: transport });
    initFaraService(transport);
    let settledAt: number | undefined;
    const pending = runToolContract(listReference, { topic: 'countries' }).then((result) => {
      settledAt = Date.now() - started;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(45_000);
      const settledByDeadline = settledAt;
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(starts).toEqual(['https://lda.gov', 'https://lda.gov', 'https://efile.fara.gov']);
      expect(settledByDeadline).toBeDefined();
      expect(settledAt).toBeLessThanOrEqual(45_000);
      expect(result.isError).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
  it.each(['issue_codes', 'filing_types', 'government_entities', 'contribution_types'])(
    'loads complete %s vocabulary and token-AND filters locally',
    async (topic) => {
      const result = await invoke({ topic, filter: ' science TECHNOLOGY ' });
      expect(result.result.isError, result.text).not.toBe(true);
      expect(result.data).toMatchObject({
        total_entries: 3,
        matched_entries: 1,
        entries: [{ value: 'SCI', name: 'Science Technology', source: 'lda' }],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.search).toBe('');
    },
  );
  it.each(['identifiers', 'methodology', 'fara_rules'])(
    'returns authored %s without network acquisition',
    async (topic) => {
      const output = await invoke({ topic });
      expect(output.result.isError).not.toBe(true);
      expect(z.array(z.unknown()).parse(output.data.entries).length).toBeGreaterThan(0);
      expect(calls).toEqual([]);
    },
  );
  it('caches complete arrays across different filters until absolute TTL', async () => {
    const first = await invoke({ topic: 'issue_codes', filter: 'TEC' });
    const second = await invoke({ topic: 'issue_codes', filter: 'health' });
    expect(second.data.entries).toEqual([{ value: 'HCR', name: 'Health Issues', source: 'lda' }]);
    expect(second.data.retrieved_at).toBe(first.data.retrieved_at);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SOURCE_CACHE_TTL_MS);
    body = [{ value: 'NEW', name: 'New vocabulary' }];
    const refreshed = await invoke({ topic: 'issue_codes' });
    expect(refreshed.data.entries).toEqual([
      { value: 'NEW', name: 'New vocabulary', source: 'lda' },
    ]);
    expect(calls).toHaveLength(2);
    expect(refreshed.data.retrieved_at).not.toBe(first.data.retrieved_at);
  });
  it('treats regex punctuation literally and supplies complete empty-result recovery', async () => {
    const output = await invoke({ topic: 'issue_codes', filter: '.*' });
    expect(output.data).toMatchObject({
      total_entries: 3,
      matched_entries: 0,
      entries: [],
      notices: [
        'No reference entries matched; call uslobbying_list_reference with the same topic and omit filter.',
      ],
    });
    expect(output.text).toContain('omit filter');
  });
  it('accepts an empty source vocabulary without inventing entries', async () => {
    body = [];
    const output = await invoke({ topic: 'government_entities' });
    expect(output.result.isError).not.toBe(true);
    expect(output.data).toMatchObject({ total_entries: 0, matched_entries: 0, entries: [] });
  });
  it('rejects unsupported topics before any request', async () => {
    const output = await invoke({ topic: 'covered_positions' });
    expect(output.result.isError).toBe(true);
    expect(output.data).toMatchObject({ error: { code: -32602 } });
    expect(output.text).toContain('topic');
    expect(calls).toEqual([]);
  });
  it('preserves source-schema failure reason and recovery in both consumption paths', async () => {
    body = [{ value: 'TEC' }];
    const output = await invoke({ topic: 'contribution_types' });
    expect(output.result.isError).toBe(true);
    expect(output.data).toMatchObject({
      error: {
        data: {
          reason: 'source_schema_changed',
          recovery: { hint: expect.stringContaining('methodology') },
        },
      },
    });
    expect(output.text).toContain('source_schema_changed');
    expect(output.text).toContain('methodology');
  });
  it('combines separately attributed LDA codes and exact FARA source country labels', async () => {
    body = [{ value: 'CA', name: 'Canada' }];
    const faraCalls: string[] = [];
    initFaraService(async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://efile.fara.gov');
      faraCalls.push(url.pathname);
      return snapshotResponse(
        'foreign_principals',
        principal('001', 'Synthetic', "Côte d'Ivoire") +
          principal('002', 'Synthetic two', 'Canada'),
      );
    });
    const output = await invoke({ topic: 'countries' });
    expect(output.result.isError, output.text).not.toBe(true);
    expect(output.data.entries).toEqual(
      expect.arrayContaining([
        { value: 'CA', name: 'Canada', source: 'lda' },
        { value: "Côte d'Ivoire", name: "Côte d'Ivoire", source: 'fara' },
        { value: 'Canada', name: 'Canada', source: 'fara' },
      ]),
    );
    expect(output.data).toMatchObject({ total_entries: 3, matched_entries: 3 });
    expect(faraCalls).toHaveLength(1);
    expect(output.text).toContain('https://efile.fara.gov');
  });
});
