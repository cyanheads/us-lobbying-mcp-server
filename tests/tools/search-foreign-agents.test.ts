/** @fileoverview FARA invocation schema, pinned continuation and complete deferred retrieval contracts. @module tests/tools/search-foreign-agents */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '../../src/domain/json.js';
import {
  latin1,
  principal,
  registrant,
  settle,
  snapshotResponse,
} from '../services/fara/fixtures.js';

let fara: typeof import('../../src/services/fara/fara-service.js');
let definition: typeof import('../../src/mcp-server/tools/definitions/search-foreign-agents.tool.js');
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  fara = await import('../../src/services/fara/fara-service.js');
  definition = await import('../../src/mcp-server/tools/definitions/search-foreign-agents.tool.js');
});
afterEach(() => {
  fara.disposeFaraPacer();
  vi.useRealTimers();
});
function install(respond: (url: URL) => Response) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://efile.fara.gov') throw new Error('Unexpected origin');
    calls.push(url.pathname);
    return respond(url);
  };
  fara.initFaraService(fetcher);
  return calls;
}
function context() {
  return createMockContext({ errors: definition.searchForeignAgentsTool.errors });
}
type Input = Parameters<typeof runToolContract<typeof definition.searchForeignAgentsTool>>[1];
async function invoke(input: Input, ctx?: ReturnType<typeof context>) {
  // runToolContract creates fresh storage per invocation; retained calls share the real mock facade.
  const response = ctx
    ? await settle(
        (async () => {
          const output = await definition.searchForeignAgentsTool.handler(
            definition.searchForeignAgentsTool.input.parse(input),
            ctx,
          );
          return {
            structuredContent: output,
            content: definition.searchForeignAgentsTool.format?.(output) ?? [],
            isError: false,
          };
        })(),
      )
    : await settle(runToolContract(definition.searchForeignAgentsTool, input));
  expect(response.isError).not.toBe(true);
  const output = definition.searchForeignAgentsTool.output.parse(response.structuredContent);
  const block = response.content.find((part) => part.type === 'text');
  if (block?.type !== 'text') throw new Error('Expected formatted JSON');
  const fence = block.text.slice(0, block.text.indexOf('json\n'));
  expect(
    JSON.parse(
      block.text.slice(fence.length + 5, block.text.indexOf(`\n${fence}`, fence.length + 5)),
    ),
  ).toEqual(output);
  expect(Buffer.byteLength(JSON.stringify(response), 'utf8') + 512).toBeLessThanOrEqual(24_000);
  return { output, text: block.text };
}
async function failure(
  input: Record<string, unknown>,
  reason: string,
  code = JsonRpcErrorCode.ValidationError,
) {
  const response = await settle(runToolContract(definition.searchForeignAgentsTool, input));
  expect(response.isError).toBe(true);
  expect(response.structuredContent).toMatchObject({ error: { code, data: { reason } } });
  const text = response.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  expect(text).toContain(reason);
  return text;
}

describe('FARA tool invocation', () => {
  it('filters all rows before local page_size, pins provenance, replays and completes without refetch', async () => {
    let revision = 'Original';
    const calls = install(() =>
      snapshotResponse(
        'registrants',
        registrant('0', 'Other') +
          Array.from({ length: 7 }, (_, index) =>
            registrant(String(index + 1), `${revision} Match ${index}`),
          ).join(''),
      ),
    );
    await settle(fara.getFaraService().search({}, new AbortController().signal));
    vi.advanceTimersByTime(3_600_000);
    const ctx = context();
    const first = await invoke({ name_contains: 'Match', page_size: 2 }, ctx);
    expect(first.output).toMatchObject({
      mode: 'search',
      entity: 'registrants',
      status: 'active',
      total_matches: 7,
      records_returned: 2,
      output_complete: false,
    });
    revision = 'Changed';
    // Refresh an older source snapshot while the later acquisition remains valid.
    vi.setSystemTime(Date.parse(first.output.snapshot_retrieved_at ?? '') + 86_400_000);
    expect(
      (await settle(fara.getFaraService().search({}, new AbortController().signal))).records[1]
        ?.name,
    ).toBe('Changed Match 0');
    const ids = first.output.records?.map((row) => row.registration_number) ?? [];
    let cursor = first.output.next_cursor;
    let final = first.output;
    while (cursor) {
      const page = await invoke({ cursor }, ctx);
      const replay = await invoke({ cursor }, ctx);
      expect(replay.output).toEqual(page.output);
      expect(page.output.records_returned).toBeLessThanOrEqual(2);
      expect(page.output.snapshot_retrieved_at).toBe(first.output.snapshot_retrieved_at);
      expect(page.output.snapshot_source_urls).toEqual(first.output.snapshot_source_urls);
      expect(page.output.retrieved_at).toBe(first.output.retrieved_at);
      expect(page.output.effective_filters.page_size).toBe(2);
      expect(page.output.records?.every((record) => record.name.startsWith('Original'))).toBe(true);
      ids.push(...(page.output.records?.map((row) => row.registration_number) ?? []));
      cursor = page.output.next_cursor;
      final = page.output;
    }
    expect(ids).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(final.output_complete).toBe(true);
    expect(calls).toHaveLength(2);
  });
  it('pins complete principal country/status matches with independent registrant status', async () => {
    const calls = install((url) =>
      url.pathname.includes('ForeignPrincipals')
        ? snapshotResponse(
            'foreign_principals',
            principal('1', 'Outside', 'France') +
              principal('2', 'Selected A') +
              principal('3', 'Selected B') +
              principal('4', 'Selected terminated', 'Canada', '01/01/2025'),
          )
        : snapshotResponse(
            'registrants',
            registrant('2', 'Firm', '01/01/2025') + registrant('3', 'Firm'),
          ),
    );
    const ctx = context();
    const first = await invoke(
      { entity: 'foreign_principals', country: 'canada', name_contains: 'selected', page_size: 1 },
      ctx,
    );
    expect(first.output.total_matches).toBe(2);
    expect(first.output.records?.[0]).toMatchObject({
      registration_number: '2',
      status: 'active',
      registrant_status: 'terminated',
    });
    const next = await invoke({ cursor: first.output.next_cursor }, ctx);
    expect(next.output.records?.[0]?.registration_number).toBe('3');
    expect(calls).toHaveLength(2);
  });
  it('retains live detail documents and authoritative links on both surfaces', async () => {
    const calls = install(
      () =>
        new Response(
          latin1(
            JSON.stringify({
              ROWSET: {
                ROW: [1, 2, 3].map((id) => ({
                  REGISTRATION_NUMBER: '0001',
                  DOCUMENT_TYPE: `Caf\u00e9 \u0080 ${id}`,
                  URL: `https://efile.fara.gov/docs/source-${id}.pdf`,
                  extra: { nested: [false, null, '```\r\n'] },
                })),
              },
            }),
          ),
        ),
    );
    const ctx = context();
    const first = await invoke(
      { mode: ' DETAIL ', detail: ' DOCUMENTS ', registration_number: '0001', page_size: 1 },
      ctx,
    );
    expect(first.output.status).toBe('all');
    expect(first.output.records?.[0]).not.toHaveProperty('status');
    expect(first.text).toContain('[Official source');
    expect(first.text).toContain('https://efile.fara.gov/docs/source-1.pdf');
    const second = await invoke({ cursor: first.output.next_cursor }, ctx);
    expect(second.output.effective_filters.page_size).toBe(1);
    expect(second.output.records?.[0]?.name).toBe('Caf\u00e9 \u0080 2');
    expect(calls).toEqual(['/api/v1/RegDocs/json/0001']);
  });
  it('reports empty detail and no-match snapshot honestly on both surfaces', async () => {
    install((url) =>
      url.pathname.endsWith('.zip')
        ? snapshotResponse('registrants', registrant('1', 'Other'))
        : Response.json({ ROWSET: '' }),
    );
    const detail = await invoke({ mode: 'detail', registration_number: '1' });
    expect(detail.output.records).toEqual([]);
    expect(detail.text).toContain('does not establish');
    const search = await invoke({ name_contains: 'No match' });
    expect(search.output).toMatchObject({ records: [], total_matches: 0, output_complete: true });
    expect(search.text).toContain('No FARA records matched');
  });
  it.each([
    { mode: 'detail' },
    { registration_number: '1' },
    { detail: 'documents' },
    { country: 'Canada' },
    { mode: 'detail', registration_number: '1', entity: 'registrants' },
    { mode: 'detail', registration_number: '1', name_contains: 'x' },
    { mode: 'detail', registration_number: '1', detail: 'documents', status: 'active' },
    { record_path: '/raw' },
    { record_offset: 1 },
    { record_limit: 2 },
    { record_handle: 'unknown', mode: 'search' },
  ])('rejects conflicting selectors before fetch %j', async (input) => {
    const calls = install(() => {
      throw new Error('Unexpected I/O');
    });
    const text = await failure(input, 'invalid_filter');
    expect(text).toContain('uslobbying_list_reference');
    expect(calls).toEqual([]);
  });
  it.each([
    { page_size: 0 },
    { page_size: 26 },
    { page_size: '' },
    { mode: 'invalid' },
    { registration_number: '../1' },
    { unexpected: true },
  ])('rejects schema-invalid invocation %j', async (input) => {
    const calls = install(() => {
      throw new Error('Unexpected I/O');
    });
    await failure(input, 'invalid_arguments', JsonRpcErrorCode.InvalidParams);
    expect(calls).toEqual([]);
  });
  it('accepts blank form selectors as absent and rejects unknown country', async () => {
    install((url) =>
      url.pathname.includes('ForeignPrincipals')
        ? snapshotResponse('foreign_principals', principal('1', 'Synthetic'))
        : snapshotResponse('registrants', registrant('1', 'Synthetic')),
    );
    const blank = await invoke({
      mode: '',
      entity: '',
      name_contains: '',
      country: '',
      status: '',
      registration_number: '',
      detail: '',
      cursor: '',
      record_handle: '',
    });
    expect(blank.output.mode).toBe('search');
    await failure({ entity: 'foreign_principals', country: 'CA' }, 'invalid_filter');
  });
  it('rejects changed continuation page_size and foreign-tenant cursors', async () => {
    install(() => snapshotResponse('registrants', registrant('1', 'One') + registrant('2', 'Two')));
    const ctx = context();
    const first = await invoke({ page_size: 1 }, ctx);
    await expect(
      invoke({ cursor: first.output.next_cursor, page_size: 2 }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
    const foreign = await settle(
      runToolContract(
        definition.searchForeignAgentsTool,
        { cursor: first.output.next_cursor },
        { context: { tenantId: 'foreign' } },
      ),
    );
    expect(foreign.structuredContent).toMatchObject({
      error: { data: { reason: 'cursor_invalid' } },
    });
  });
  it.each([
    {
      body: 'not json',
      status: 200,
      reason: 'source_schema_changed',
      code: JsonRpcErrorCode.SerializationError,
    },
    {
      body: 'Request rate too high',
      status: 429,
      reason: 'source_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
    },
  ])(
    'renders $reason and recovery on both invocation surfaces',
    async ({ body, status, reason, code }) => {
      install(() => new Response(body, { status }));
      const text = await failure({ mode: 'detail', registration_number: '1' }, reason, code);
      expect(text).toContain(
        reason === 'source_rate_limited' ? 'Wait for retryAfter' : 'uslobbying_list_reference',
      );
    },
  );
  it('renders required snapshot failure with its detail-mode recovery', async () => {
    install(() => new Response('missing', { status: 404 }));
    const text = await failure({}, 'snapshot_unavailable', JsonRpcErrorCode.ServiceUnavailable);
    expect(text).toContain('mode detail');
    expect(text).toContain('registration_number');
  });
  it('cancels an active source exchange and renders cancellation on both surfaces', async () => {
    const controller = new AbortController();
    let started = false;
    let exchange: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      started = true;
      exchange = init?.signal ?? undefined;
      return new Promise((_resolve, reject) =>
        exchange?.addEventListener('abort', () => reject(exchange?.reason), { once: true }),
      );
    };
    fara.initFaraService(fetcher);
    const pending = runToolContract(
      definition.searchForeignAgentsTool,
      { mode: 'detail', registration_number: '1' },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(true);
    controller.abort(new DOMException('Synthetic cancelled', 'AbortError'));
    const response = await settle(pending);
    expect(exchange?.aborted).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(
      response.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    ).toMatch(/cancel/i);
  });
});

describe('FARA deferred parent retrieval', () => {
  it('reconstructs complete nested source records through the same tool after cursor advancement', async () => {
    const raw = {
      REGISTRATION_NUMBER: '0001',
      DOCUMENT_TYPE: 'Synthetic',
      URL: 'https://efile.fara.gov/docs/source.pdf',
      unknown: {
        'a/b~c': Array.from({ length: 28 }, (_, id) => ({
          id,
          text: 'Caf\u00e9 '.repeat(300),
          values: [null, false, 0],
        })),
      },
    };
    const calls = install(
      () =>
        new Response(
          latin1(
            JSON.stringify({
              ROWSET: {
                ROW: [
                  raw,
                  {
                    REGISTRATION_NUMBER: 2,
                    DOCUMENT_TYPE: 'Second',
                    URL: 'https://efile.fara.gov/docs/second.pdf',
                  },
                ],
              },
            }),
          ),
        ),
    );
    const ctx = context();
    const first = await invoke(
      { mode: 'detail', detail: 'documents', registration_number: '0001', page_size: 1 },
      ctx,
    );
    expect(first.output.records_deferred).toBe(1);
    expect(first.output.records_returned).toBe(0);
    const handle = first.output.record_handles?.[0]?.record_handle;
    expect(handle).toBeTypeOf('string');
    expect(first.output.record_handles?.[0]?.retrieval_tool).toBe(
      'uslobbying_search_foreign_agents',
    );
    await invoke({ cursor: first.output.next_cursor }, ctx);
    async function reconstruct(path: string): Promise<JsonValue> {
      let offset = 0;
      let string = '';
      let container: JsonValue[] | Record<string, JsonValue> | undefined;
      for (;;) {
        const response = await invoke(
          { record_handle: handle, record_path: path, record_offset: offset },
          ctx,
        );
        const window = response.output.record_window;
        if (!window) throw new Error('Missing retained window');
        if (window.kind === 'scalar') return window.value ?? null;
        if (window.kind === 'string') {
          string += window.text;
          if (window.next_offset === undefined) return string;
        } else {
          container ??= window.kind === 'array' ? [] : Object.create(null);
          if (window.kind === 'array')
            for (const item of window.items ?? [])
              (container as JsonValue[])[item.index] = Object.hasOwn(item, 'value')
                ? (item.value ?? null)
                : await reconstruct(item.path);
          else
            for (const entry of window.entries ?? [])
              (container as Record<string, JsonValue>)[entry.key] = Object.hasOwn(entry, 'value')
                ? (entry.value ?? null)
                : await reconstruct(entry.path);
          if (window.next_offset === undefined) return container ?? null;
        }
        if (window.next_offset === undefined || window.next_offset <= offset)
          throw new Error('Nonprogressing window');
        offset = window.next_offset;
      }
    }
    const reconstructed = await reconstruct('');
    expect(reconstructed).toMatchObject({ registration_number: '0001', entity: 'documents', raw });
    await expect(
      invoke(
        { record_handle: handle, record_path: '/raw/unknown/a~1b~0c', record_offset: 29 },
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
    expect(calls).toHaveLength(1);
  });
});
