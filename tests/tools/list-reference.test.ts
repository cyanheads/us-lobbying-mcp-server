/** @fileoverview Reference vocabularies through runtime contracts with real source parsing. @module tests/tools/list-reference */
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_CACHE_TTL_MS } from '../../src/domain/contracts.js';
import { listReference } from '../../src/mcp-server/tools/definitions/list-reference.tool.js';
import { initFaraService } from '../../src/services/fara/fara-service.js';
import { getLdaService, initLdaService } from '../../src/services/lda/lda-service.js';
import { principal, settle, snapshotResponse } from '../services/fara/fixtures.js';

let calls: URL[];
let body: unknown;
let state: ReturnType<typeof createMockContext>['state'];
beforeEach(() => {
  vi.useFakeTimers();
  // Expire the module-owned FARA snapshot cache between tests without resetting source modules.
  vi.setSystemTime(new Date(2030, 0, 1 + 3 * testDay++));
  calls = [];
  state = createMockContext().state;
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
async function invoke(input: Record<string, unknown>, tenantId = 'default') {
  const tenantState = tenantId === 'default' ? state : createMockContext({ tenantId }).state;
  const handler: typeof listReference.handler = (input, ctx) =>
    listReference.handler(input, { ...ctx, state: tenantState });
  const definition: Parameters<typeof runToolContract>[0] = { ...listReference, handler };
  const pending = runToolContract(definition, input, { context: { tenantId } });
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
  }
  return { result, data, text };
}
const entriesOf = (data: Record<string, unknown>) =>
  z.array(z.object({ value: z.string(), description: z.string().optional() })).parse(data.entries);
describe('reference contracts', () => {
  it('identifies the candidate record field to select on both response surfaces', async () => {
    const result = await invoke({ topic: 'identifiers', filter: 'client_id' });
    expect(result.result.isError, result.text).not.toBe(true);
    expect(result.text).toContain('candidates[].id');
    expect(result.text).toContain('candidates[].client_id');
    expect(result.data.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'client_id',
          description: expect.stringContaining('candidates[].id'),
        }),
      ]),
    );
  });
  it('delivers entries far over 24,000 bytes whole in their window', async () => {
    const name = 'é🌲'.repeat(5000);
    body = [
      { value: 'HUGE', name },
      { value: 'SMALL', name: 'Small entry' },
    ];
    const first = await invoke({ topic: 'issue_codes' });
    expect(first.result.isError, first.text).not.toBe(true);
    expect(first.data).toMatchObject({
      total_entries: 2,
      matched_entries: 2,
      records_returned: 2,
      entries: [
        { value: 'HUGE', name, source: 'lda' },
        { value: 'SMALL', name: 'Small entry', source: 'lda' },
      ],
      output_complete: true,
      truncated: false,
    });
    expect(new TextEncoder().encode(first.text).byteLength).toBeGreaterThan(24_000);
    expect(calls).toHaveLength(1);
  });
  it('rejects foreign tenant and expired vocabulary cursors without reacquiring', async () => {
    body = Array.from({ length: 140 }, (_, index) => ({
      value: String(index),
      name: 'Tiny entry',
    }));
    const first = await invoke({ topic: 'issue_codes' });
    expect(first.result.isError, first.text).not.toBe(true);
    expect(first.data.records_returned).toBe(125);
    const foreign = await invoke({ cursor: first.data.next_cursor }, 'foreign');
    expect(foreign.data).toMatchObject({ error: { data: { reason: 'cursor_invalid' } } });
    expect(foreign.text).toContain('cursor_invalid');
    const expires = Date.parse(z.string().parse(first.data.cursor_expires_at));
    await vi.advanceTimersByTimeAsync(expires - Date.now() + 1);
    const expired = await invoke({ cursor: first.data.next_cursor });
    expect(expired.data).toMatchObject({ error: { data: { reason: 'cursor_invalid' } } });
    expect(expired.text).toContain('cursor_invalid');
    expect(calls).toHaveLength(1);
  });
  it('delivers a vocabulary past its first 125-entry window losslessly, with replay', async () => {
    const entries = Array.from({ length: 180 }, (_, index) => ({
      value: String(index).padStart(3, '0'),
      name: `Synthetic vocabulary ${index} ${'é🌲'.repeat(90)}`,
    }));
    body = entries;
    const first = await invoke({ topic: 'issue_codes', filter: 'synthetic' });
    expect(first.result.isError, first.text).not.toBe(true);
    expect(first.data).toMatchObject({
      total_entries: 180,
      matched_entries: 180,
      output_complete: false,
      truncated: true,
      offset: 0,
      records_returned: 125,
    });
    expect(first.data.next_cursor).toEqual(expect.any(String));
    const second = await invoke({
      cursor: first.data.next_cursor,
      topic: 'issue_codes',
      filter: 'synthetic',
    });
    expect(second.result.isError, second.text).not.toBe(true);
    expect(second.data).toMatchObject({
      total_entries: 180,
      matched_entries: 180,
      offset: 125,
      records_returned: 55,
      output_complete: true,
      truncated: false,
    });
    expect(second.data).not.toHaveProperty('next_cursor');
    const replay = await invoke({ cursor: first.data.next_cursor });
    expect(replay.data).toEqual(second.data);
    const changed = await invoke({ cursor: first.data.next_cursor, filter: 'different' });
    expect(changed.result.isError).toBe(true);
    expect(changed.data).toMatchObject({ error: { data: { reason: 'cursor_invalid' } } });
    expect(changed.text).toContain('cursor_invalid');
    expect([
      ...z.array(z.unknown()).parse(first.data.entries),
      ...z.array(z.unknown()).parse(second.data.entries),
    ]).toEqual(entries.map((entry) => ({ ...entry, source: 'lda' })));
    expect(calls).toHaveLength(1);
  });
  it('ends an exact multiple of the 125-entry window without an empty trailing window', async () => {
    const values = Array.from({ length: 250 }, (_, index) => String(index).padStart(3, '0'));
    body = values.map((value) => ({ value, name: 'Tiny entry' }));
    const first = await invoke({ topic: 'issue_codes' });
    expect(first.data).toMatchObject({ offset: 0, records_returned: 125, output_complete: false });
    const second = await invoke({ cursor: first.data.next_cursor });
    expect(second.data).toMatchObject({
      offset: 125,
      records_returned: 125,
      output_complete: true,
      truncated: false,
    });
    expect(second.data).not.toHaveProperty('next_cursor');
    expect([...entriesOf(first.data), ...entriesOf(second.data)].map((e) => e.value)).toEqual(
      values,
    );
  });
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
  it.each([
    ['issue_codes', 'filing/lobbyingactivityissues'],
    ['filing_types', 'filing/filingtypes'],
    ['government_entities', 'filing/governmententities'],
    ['contribution_types', 'contribution/itemtypes'],
    ['states', 'general/states'],
  ])('loads complete %s vocabulary and token-AND filters locally', async (topic, path) => {
    if (topic === 'government_entities')
      body = [
        { id: 1, name: 'Telecommunications' },
        { id: 2, name: 'Science Technology' },
        { id: 3, name: 'Health Issues' },
      ];
    const result = await invoke({ topic, filter: ' science TECHNOLOGY ' });
    expect(result.result.isError, result.text).not.toBe(true);
    expect(result.data).toMatchObject({
      topic,
      total_entries: 3,
      matched_entries: 1,
      entries: [
        {
          value: topic === 'government_entities' ? '2' : 'SCI',
          name: 'Science Technology',
          source: 'lda',
        },
      ],
    });
    expect(calls.map((url) => url.pathname)).toEqual([`/api/v1/constants/${path}/`]);
    expect(calls[0]?.search).toBe('');
  });
  it.each(['identifiers', 'methodology', 'fara_rules'])(
    'returns authored %s without network acquisition',
    async (topic) => {
      const output = await invoke({ topic });
      expect(output.result.isError).not.toBe(true);
      expect(z.array(z.unknown()).parse(output.data.entries).length).toBeGreaterThan(0);
      expect(calls).toEqual([]);
    },
  );
  it('explains current identifiers, the period-selection grammar and short-form FARA rules', async () => {
    const identifiers = await invoke({ topic: 'identifiers' });
    expect(entriesOf(identifiers.data).map((entry) => entry.value)).not.toContain('record_handle');
    expect(identifiers.text).not.toContain('record_');
    const methodology = await invoke({ topic: 'methodology' });
    const selection = entriesOf(methodology.data).find((entry) => entry.value === 'selection');
    expect(selection?.description).toContain('MM, MMY, MT, MTY, MA, MAY, M@, M@Y');
    expect(selection?.description).toContain('YY, YYY, YT, YTY, YA, YAY, Y@, Y@Y');
    expect(selection?.description).toContain('semiannual through 2007 and quarterly from 2008');
    expect(selection?.description).toContain('off_cycle_period');
    expect(selection?.description).toContain('neither quarterly nor semiannual (non_quarterly)');
    const rules = await invoke({ topic: 'fara_rules' });
    const byValue = new Map(entriesOf(rules.data).map((entry) => [entry.value, entry.description]));
    expect(byValue.get('status')).toContain('short form');
    expect(byValue.get('snapshots')).toContain('short-form snapshots');
    expect(byValue.get('interpretation')).toContain('no identity across registrations');
  });
  it('reports the shared constants fetch time as retrieved_at without refetching', async () => {
    const warmed = await settle(getLdaService().constants('issue_codes'));
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    const output = await invoke({ topic: 'issue_codes' });
    expect(output.data.retrieved_at).toBe(warmed.retrieved_at);
    expect(Date.now() - Date.parse(z.string().parse(output.data.retrieved_at))).toBeGreaterThan(
      3_600_000 - 1,
    );
    expect(calls).toHaveLength(1);
  });
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
  it('leaves the shared cached constants unchanged after combining and filtering countries', async () => {
    body = [
      { value: 'CA', name: 'Canada' },
      { value: 'US', name: 'United States' },
    ];
    initFaraService(async () =>
      snapshotResponse('foreign_principals', principal('001', 'Synthetic', 'Canada')),
    );
    const cached = await settle(getLdaService().constants('countries'));
    const before = structuredClone(cached.entries);
    await vi.advanceTimersByTimeAsync(3_600_000);
    const all = await invoke({ topic: 'countries' });
    expect(all.data).toMatchObject({ total_entries: 3, matched_entries: 3 });
    // The FARA snapshot is an hour newer; the combined vocabulary reports the older LDA fetch.
    expect(all.data.retrieved_at).toBe(cached.retrieved_at);
    const filtered = await invoke({ topic: 'countries', filter: 'canada' });
    expect(filtered.data).toMatchObject({ total_entries: 3, matched_entries: 2 });
    const after = await settle(getLdaService().constants('countries'));
    expect(after.entries).toBe(cached.entries);
    expect(after.entries).toEqual(before);
    expect(calls).toHaveLength(1);
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
  it('requires a topic on the first call', async () => {
    const output = await invoke({});
    expect(output.data).toMatchObject({ error: { data: { reason: 'invalid_filter' } } });
    expect(output.text).toContain('continuation calls need only cursor');
    expect(calls).toEqual([]);
  });
  it('rejects unsupported topics before any request', async () => {
    const output = await invoke({ topic: 'covered_positions' });
    expect(output.result.isError).toBe(true);
    expect(output.data).toMatchObject({ error: { code: -32602 } });
    expect(output.text).toContain('topic');
    expect(calls).toEqual([]);
  });
  it.each([
    { record_handle: 'unknown' },
    { record_path: '/name' },
    { record_offset: 1 },
    { record_limit: 26 },
    { page_size: 10 },
  ])('rejects removed and absent count inputs %j as unknown arguments', async (extra) => {
    const output = await invoke({ topic: 'issue_codes', ...extra });
    expect(output.result.isError).toBe(true);
    expect(output.data).toMatchObject({ error: { code: -32602 } });
    expect(calls).toEqual([]);
  });
  it('advertises no count or record-window inputs and no record outputs', () => {
    expect(Object.keys(listReference.input.shape).sort()).toEqual(['cursor', 'filter', 'topic']);
    const outputs = Object.keys(listReference.output!.shape);
    for (const removed of [
      'record_handles',
      'records_deferred',
      'record_window',
      'retrieval_tool',
      'delivery_limits',
    ])
      expect(outputs).not.toContain(removed);
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
