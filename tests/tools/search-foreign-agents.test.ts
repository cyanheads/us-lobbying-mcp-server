/** @fileoverview FARA invocation schema, count-bounded pinned windows and short-form search contracts. @module tests/tools/search-foreign-agents */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  latin1,
  principal,
  registrant,
  settle,
  shortForm,
  snapshotResponse,
} from '../services/fara/fixtures.js';

const NAME = 'uslobbying_search_foreign_agents';
const CLAMP_LOG = 'Clamped a count control to its served ceiling.';
let fara: typeof import('../../src/services/fara/fara-service.js');
let definition: typeof import('../../src/mcp-server/tools/definitions/search-foreign-agents.tool.js');
/** Fresh module graph, so server config and module-owned snapshot caches start empty. */
async function load() {
  vi.resetModules();
  fara = await import('../../src/services/fara/fara-service.js');
  definition = await import('../../src/mcp-server/tools/definitions/search-foreign-agents.tool.js');
}
beforeEach(async () => {
  vi.stubEnv('USLOBBYING_CLAMP_LIMITS', undefined);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  await load();
});
afterEach(() => {
  fara.disposeFaraPacer();
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
/** Registrant rows numbered from `start + 1`, each named `${name} ${id}`. */
function registrants(count: number, name: string, start = 0): string {
  return Array.from({ length: count }, (_, index) =>
    registrant(String(start + index + 1), `${name} ${start + index + 1}`),
  ).join('');
}
function ids(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => String(from + index));
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
          // The framework parses the handler's return against `output` before format() sees it.
          const output = definition.searchForeignAgentsTool.output.parse(
            await definition.searchForeignAgentsTool.handler(
              definition.searchForeignAgentsTool.input.parse(input),
              ctx,
            ),
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

describe('FARA delivery counts', () => {
  it('delivers 25 records by default and clamps an over-cap page_size to 1,000, disclosed and logged once', async () => {
    install(() => snapshotResponse('registrants', registrants(1030, 'Synthetic')));
    const ctx = context();
    const info = vi.spyOn(ctx.log, 'info');
    const clamps = () => info.mock.calls.filter(([message]) => message === CLAMP_LOG);
    const defaults = await invoke({}, ctx);
    expect(defaults.output).toMatchObject({
      records_returned: 25,
      delivery_limits: {},
      effective_filters: { page_size: 25 },
      output_complete: false,
    });
    const first = await invoke({ page_size: 1e20 }, ctx);
    expect(first.output.delivery_limits).toEqual({
      page_size: { requested: 1e20, effective: 1000 },
    });
    expect(first.output.records.map((row) => row.registration_number)).toEqual(ids(1, 1000));
    expect(first.output.effective_filters.page_size).toBe(1000);
    expect(clamps()).toEqual([
      [CLAMP_LOG, { tool: NAME, control: 'page_size', requested: 1e20, effective: 1000 }],
    ]);
    const rest = await invoke({ cursor: first.output.next_cursor!, page_size: 5000 }, ctx);
    expect(rest.output).toMatchObject({
      offset: 1000,
      records_returned: 30,
      output_complete: true,
      delivery_limits: { page_size: { requested: 5000, effective: 1000 } },
    });
    expect(rest.output).not.toHaveProperty('next_cursor');
    expect(clamps()).toHaveLength(1);
    await expect(
      invoke({ cursor: first.output.next_cursor!, page_size: 999 }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
  });
  it('rejects an over-cap page_size before any download when clamping is disabled', async () => {
    fara.disposeFaraPacer();
    vi.stubEnv('USLOBBYING_CLAMP_LIMITS', 'false');
    await load();
    const calls = install(() => snapshotResponse('registrants', registrants(2, 'Synthetic')));
    const response = await settle(
      runToolContract(definition.searchForeignAgentsTool, { page_size: 1001 }),
    );
    expect(response.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_filter', field: 'page_size', maximum: 1000 } },
    });
    const text = response.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    expect(text).toContain('page_size cannot exceed 1000.');
    expect(calls).toEqual([]);
    expect((await invoke({ page_size: 1000 })).output.delivery_limits).toEqual({});
  });
  it('reads float noise in page_size as the integer it denotes', async () => {
    install(() => snapshotResponse('registrants', registrants(30, 'Synthetic')));
    const ctx = context();
    const first = await invoke({ page_size: 20.000000000000004 }, ctx);
    expect(first.output).toMatchObject({
      records_returned: 20,
      effective_filters: { page_size: 20 },
    });
    const rest = await invoke({ cursor: first.output.next_cursor!, page_size: 20 }, ctx);
    expect(rest.output).toMatchObject({ offset: 20, records_returned: 10, output_complete: true });
  });
  it('re-slices pinned windows across 125-row storage chunks and ends exact multiples without an empty window', async () => {
    const calls = install(() =>
      snapshotResponse('registrants', registrants(260, 'Alpha') + registrants(40, 'Beta', 260)),
    );
    const ctx = context();
    async function walk(input: Input) {
      let page = await invoke(input, ctx);
      const windows = [[page.output.offset, page.output.records_returned]];
      const delivered = [...page.output.records];
      let last: string | undefined;
      while (page.output.next_cursor) {
        last = page.output.next_cursor;
        page = await invoke({ cursor: last }, ctx);
        windows.push([page.output.offset, page.output.records_returned]);
        delivered.push(...page.output.records);
      }
      return { windows, delivered, final: page.output, last };
    }
    // 300 matches at 130: windows cross the storage chunks at 125 and 250; the tail continuation ends it.
    const all = await walk({ page_size: 130 });
    expect(all.windows).toEqual([
      [0, 130],
      [130, 130],
      [260, 40],
    ]);
    expect(all.delivered.map((row) => row.registration_number)).toEqual(ids(1, 300));
    expect(all.final).toMatchObject({
      total_matches: 300,
      output_complete: true,
      truncated: false,
    });
    expect((await invoke({ cursor: all.last }, ctx)).output).toEqual(all.final);
    // 260 matches at 130 end on their second full window with no trailing cursor.
    const alpha = await walk({ name_contains: 'alpha', page_size: 130 });
    expect(alpha.windows).toEqual([
      [0, 130],
      [130, 130],
    ]);
    expect(alpha.delivered.map((row) => row.registration_number)).toEqual(ids(1, 260));
    expect(alpha.final).toMatchObject({ total_matches: 260, output_complete: true });
    expect(alpha.final).not.toHaveProperty('next_cursor');
    expect(calls).toHaveLength(1);
  });
  it('delivers records far over 24,000 bytes whole within page_size', async () => {
    const rows = [1, 2, 3].map((id) => ({
      REGISTRATION_NUMBER: '0001',
      DOCUMENT_TYPE: `Synthetic ${id}`,
      URL: `https://efile.fara.gov/docs/source-${id}.pdf`,
      ...(id === 1 && { extra: { text: 'Café '.repeat(8000), values: [null, false, 0] } }),
    }));
    install(() => new Response(latin1(JSON.stringify({ ROWSET: { ROW: rows } }))));
    const ctx = context();
    const first = await invoke(
      { mode: 'detail', detail: 'documents', registration_number: '0001', page_size: 2 },
      ctx,
    );
    expect(first.output.records.map((row) => row.raw)).toEqual(rows.slice(0, 2));
    expect(first.output.records_returned).toBe(2);
    expect(Buffer.byteLength(first.text, 'utf8')).toBeGreaterThan(48_000);
    const rest = await invoke({ cursor: first.output.next_cursor }, ctx);
    expect(rest.output.records.map((row) => row.raw)).toEqual(rows.slice(2));
  });
  it('advertises no record-window inputs or outputs', () => {
    expect(Object.keys(definition.searchForeignAgentsTool.input.shape).sort()).toEqual([
      'country',
      'cursor',
      'detail',
      'entity',
      'mode',
      'name_contains',
      'page_size',
      'registration_number',
      'status',
    ]);
    const outputs = Object.keys(definition.searchForeignAgentsTool.output.shape);
    for (const removed of ['record_handles', 'records_deferred', 'record_window', 'retrieval_tool'])
      expect(outputs).not.toContain(removed);
  });
});

describe('FARA short-form search', () => {
  it('finds short-form registrants by name with independent registrant status, downloading their snapshot only for them', async () => {
    const calls = install((url) =>
      url.pathname.includes('ShortForms')
        ? snapshotResponse(
            'short_forms',
            shortForm('7108', { first: 'Anthony T', last: 'Podesta', date: '05/01/2016' }) +
              shortForm('6103', {
                first: 'Heather M.',
                last: 'Podesta',
                date: '01/02/2013',
                termination: '12/31/2019',
              }) +
              shortForm('4894', { last: 'Podesta' }) +
              shortForm('5000', { first: 'Someone', last: 'Else' }),
          )
        : snapshotResponse(
            'registrants',
            registrant('7108', 'Firm A', '01/01/2020') + registrant('6103', 'Firm B'),
          ),
    );
    await invoke({ name_contains: 'firm' });
    expect(calls).toEqual(['/bulk/zip/FARA_All_Registrants.xml.zip']);
    const all = await invoke({ entity: ' SHORT_FORMS ', name_contains: 'podesta', status: 'all' });
    expect(all.output).toMatchObject({
      mode: 'search',
      entity: 'short_forms',
      status: 'all',
      total_matches: 3,
      effective_filters: { entity: 'short_forms', name_contains: 'podesta', status: 'all' },
    });
    expect(all.output.records[0]).toMatchObject({
      registration_number: '7108',
      entity: 'short_forms',
      name: 'Anthony T Podesta',
      first_name: 'Anthony T',
      last_name: 'Podesta',
      status: 'active',
      registration_date: '2016-05-01',
      registrant_status: 'terminated',
    });
    expect(all.output.records[1]).toMatchObject({
      registration_number: '6103',
      status: 'terminated',
      termination_date: '2019-12-31',
      termination_date_raw: '12/31/2019',
      registrant_status: 'active',
    });
    expect(all.output.records[2]).toMatchObject({ registration_number: '4894', name: 'Podesta' });
    expect(all.output.records[2]).not.toHaveProperty('first_name');
    expect(all.output.records[2]).not.toHaveProperty('registrant_status');
    expect(all.output.notices).toEqual(
      expect.arrayContaining([expect.stringContaining('establish no identity')]),
    );
    expect(all.text).toContain('establish no identity across registrations or with LDA lobbyists');
    const active = await invoke({ entity: 'short_forms', name_contains: 'podesta' });
    expect(active.output.records.map((row) => row.registration_number)).toEqual(['7108', '4894']);
    expect(calls).toEqual([
      '/bulk/zip/FARA_All_Registrants.xml.zip',
      '/bulk/zip/FARA_All_ShortForms.xml.zip',
    ]);
  });
  it.each([
    [
      'foreign_principals',
      'ForeignPrincipals',
      'TERMINATION_DATE',
      { REG_NUMBER: 7108, FP_NAME: 'Synthetic principal', COUNTRY_NAME: 'Canada' },
    ],
    [
      'short_forms',
      'ShortFormRegistrants',
      'SF_TERM_DATE',
      { REG_NUMBER: 7108, SF_FIRST_NAME: 'Anthony T', SF_LAST_NAME: 'Podesta' },
    ],
  ] as const)(
    'carries detail %s termination dates from the terminated arm on both surfaces',
    async (detail, noun, field, row) => {
      const calls = install((url) =>
        Response.json({
          ROWSET: {
            ROW: url.pathname.includes('/Terminated/')
              ? { ...row, [field]: '2022-05-11T00:00:00' }
              : row,
          },
        }),
      );
      const result = await invoke({
        mode: 'detail',
        detail,
        registration_number: '7108',
        status: 'all',
      });
      expect(result.output.records).toHaveLength(2);
      expect(result.output.records[0]).toMatchObject({ entity: detail, status: 'active' });
      expect(result.output.records[0]).not.toHaveProperty('termination_date');
      expect(result.output.records[1]).toMatchObject({
        entity: detail,
        status: 'terminated',
        termination_date: '2022-05-11',
        termination_date_raw: '2022-05-11T00:00:00',
      });
      expect(result.text).toContain('"termination_date":"2022-05-11"');
      expect(result.text).toContain('"termination_date_raw":"2022-05-11T00:00:00"');
      expect(calls).toEqual([
        `/api/v1/${noun}/json/Active/7108`,
        `/api/v1/${noun}/json/Terminated/7108`,
      ]);
    },
  );
});

describe('FARA tool invocation', () => {
  it('delivers every redirected document through pinned windows with equal response surfaces', async () => {
    const target =
      'https://efile.fara.gov/CallAPI/GetJSON?a=f?p=API:REGISTRANTDOCS-F_XML:::::F_XML_REG_NUM,F_XML_CC,F_XML_DOC_TYPE:5931,,';
    const rows = Array.from({ length: 145 }, (_, index) => ({
      REGISTRATION_NUMBER: 5931,
      DATE_STAMPED: '2026-08-27T00:00:00',
      DOCUMENT_TYPE: 'Amendment',
      URL: `https://efile.fara.gov/docs/5931-Amendment-${index}.pdf`,
      SHORT_FORM_NAME: '',
      FOREIGN_PRINCIPAL_NAME: '',
      FOREIGN_PRINCIPAL_COUNTRY: '',
      REGISTRANT_NAME: 'Synthetic firm',
      future: { index, values: [null, false, 0] },
    }));
    const calls = install((url) =>
      url.pathname.startsWith('/api/')
        ? new Response(null, { status: 302, headers: { Location: target } })
        : new Response(latin1(JSON.stringify({ ROWSET: { ROW: rows } }))),
    );
    const ctx = context();
    let page = await invoke(
      { mode: 'detail', detail: 'documents', registration_number: '5931', page_size: 5 },
      ctx,
    );
    const delivered = [];
    for (;;) {
      expect(page.output.source_urls).toEqual([
        'https://efile.fara.gov/api/v1/RegDocs/json/5931',
        target,
      ]);
      expect(page.output.total_matches).toBe(145);
      delivered.push(...page.output.records);
      if (!page.output.next_cursor) break;
      page = await invoke({ cursor: page.output.next_cursor }, ctx);
    }
    expect(delivered.map((row) => row.raw)).toEqual(rows);
    expect(delivered.map((row) => row.document_url)).toEqual(rows.map((row) => row.URL));
    expect(calls).toEqual(['/api/v1/RegDocs/json/5931', '/CallAPI/GetJSON']);
  });
  it('renders unsupported redirect recovery and the nonretryable reason on both error surfaces', async () => {
    const calls = install(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://outside.example/documents' },
        }),
    );
    const response = await settle(
      runToolContract(definition.searchForeignAgentsTool, {
        mode: 'detail',
        detail: 'documents',
        registration_number: '5931',
      }),
    );
    expect(response.structuredContent).toMatchObject({
      error: { data: { reason: 'source_schema_changed', retryable: false } },
    });
    const text = response.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    expect(text).toContain('source_schema_changed');
    expect(text).toContain('redirect route is supported');
    expect(calls).toHaveLength(1);
  });
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
    const ids = first.output.records.map((row) => row.registration_number);
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
      expect(page.output.records.every((record) => record.name.startsWith('Original'))).toBe(true);
      ids.push(...page.output.records.map((row) => row.registration_number));
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
    expect(first.output.records[0]).toMatchObject({
      registration_number: '2',
      status: 'active',
      registrant_status: 'terminated',
    });
    const next = await invoke({ cursor: first.output.next_cursor }, ctx);
    expect(next.output.records[0]?.registration_number).toBe('3');
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
                  DOCUMENT_TYPE: `Café \u0080 ${id}`,
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
    expect(first.output.records[0]).not.toHaveProperty('status');
    expect(first.text).toContain('[Official source');
    expect(first.text).toContain('https://efile.fara.gov/docs/source-1.pdf');
    const second = await invoke({ cursor: first.output.next_cursor }, ctx);
    expect(second.output.effective_filters.page_size).toBe(1);
    expect(second.output.records[0]?.name).toBe('Café \u0080 2');
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
  it('preserves hostile source URLs as data without emitting unfenced instructions', async () => {
    const url = 'https://efile.fara.gov/\n\n# Injected heading\nSource paragraph.\n';
    install(() =>
      Response.json({
        ROWSET: { ROW: { REGISTRATION_NUMBER: '1', DOCUMENT_TYPE: 'Test', URL: url } },
      }),
    );
    const result = await invoke({ mode: 'detail', registration_number: '1', detail: 'documents' });
    expect(result.output.records[0]?.raw.URL).toBe(url);
    const links = result.text.slice(result.text.lastIndexOf('\n```') + 4);
    expect(links).not.toContain('\n# Injected heading');
    expect(links).not.toContain('\nSource paragraph.');
    expect(links).toContain('(<https://efile.fara.gov/#%20Injected%20headingSource%20paragraph.>)');
  });
  it.each([
    { mode: 'detail' },
    { registration_number: '1' },
    { detail: 'documents' },
    { country: 'Canada' },
    { entity: 'short_forms', country: 'Canada' },
    { mode: 'detail', registration_number: '1', entity: 'registrants' },
    { mode: 'detail', registration_number: '1', name_contains: 'x' },
    { mode: 'detail', registration_number: '1', detail: 'documents', status: 'active' },
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
    { page_size: 1.5 },
    { page_size: '' },
    { mode: 'invalid' },
    { entity: 'documents' },
    { registration_number: '../1' },
    { unexpected: true },
    { record_handle: 'unknown' },
    { record_path: '/raw' },
    { record_offset: 1 },
    { record_limit: 2 },
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
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
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
