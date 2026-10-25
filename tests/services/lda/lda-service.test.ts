/** @fileoverview Real LDA transport contracts with a strict network boundary. @module tests/services/lda/lda-service */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatResult } from '../../../src/domain/format.js';
import { LdaService } from '../../../src/services/lda/lda-service.js';

const uuid = '00000000-0000-4000-8000-000000000001';
const filing = {
  filing_uuid: uuid,
  filing_type: 'Q1',
  filing_year: 2024,
  filing_period: 'first_quarter',
  dt_posted: '2024-04-01T00:00:00Z',
  registrant: { id: 1, name: 'Synthetic firm' },
  client: { id: '0002', name: 'Synthetic client' },
  income: null,
  expenses: '0.00',
  lobbying_activities: [
    {
      general_issue_code: 'TEC',
      description: 'Synthetic\r\n``` record',
      government_entities: [{ id: 3, name: null }],
      lobbyists: [{ lobbyist: { id: 4 }, covered_position: null }],
      future: { values: [null, false, 0] },
    },
  ],
  future: { nested: [{ text: 'é🌲' }] },
};
const page = (records: unknown[] = []) => ({
  count: records.length,
  next: null,
  previous: null,
  results: records,
});
let services: LdaService[] = [];
function source(
  respond: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const calls: { url: URL; init: RequestInit | undefined; at: number }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init, at: Date.now() });
    if (url.origin !== 'https://lda.gov') throw new Error(`Unexpected host ${url.origin}`);
    return respond(url, init);
  };
  const service = new LdaService({ fetch: fetcher });
  services.push(service);
  return { service, calls, fetcher };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  for (const service of services) service.dispose();
  services = [];
  vi.useRealTimers();
});
async function settle<T>(pending: Promise<T>): Promise<T> {
  const observed = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await observed;
  if ('error' in result) throw result.error;
  return result.value;
}

describe('LDA noun wiring', () => {
  it.each(['filings', 'contributions', 'clients', 'registrants', 'lobbyists'] as const)(
    'fetches %s pages and details through their schema',
    async (noun) => {
      const record =
        noun === 'filings'
          ? filing
          : noun === 'contributions'
            ? {
                ...filing,
                contribution_items: [{ contributor_name: null, amount: '1.01' }],
                pacs: [],
              }
            : noun === 'clients'
              ? { id: 2, name: 'Synthetic client', registrant: filing.registrant }
              : noun === 'registrants'
                ? filing.registrant
                : { id: 4, first_name: null, registrant: filing.registrant };
      const id = noun === 'filings' || noun === 'contributions' ? uuid : '0002';
      const { service, calls } = source((url) => {
        if (url.pathname === `/api/v1/${noun}/`) return Response.json(page([record]));
        if (url.pathname === `/api/v1/${noun}/${id}/`) return Response.json(record);
        throw new Error(`Unmatched ${url}`);
      });
      const lists = {
        filings: service.listFilings.bind(service),
        contributions: service.listContributions.bind(service),
        clients: service.listClients.bind(service),
        registrants: service.listRegistrants.bind(service),
        lobbyists: service.listLobbyists.bind(service),
      };
      const details = {
        filings: service.getFiling.bind(service),
        contributions: service.getContribution.bind(service),
        clients: service.getClient.bind(service),
        registrants: service.getRegistrant.bind(service),
        lobbyists: service.getLobbyist.bind(service),
      };
      const result = await settle<{ results: unknown[] }>(lists[noun]({ page_size: 25 }));
      expect(result.results).toHaveLength(1);
      expect(await settle<unknown>(details[noun](id))).toEqual(result.results[0]);
      expect(calls.map((x) => x.url.pathname)).toEqual([
        `/api/v1/${noun}/`,
        `/api/v1/${noun}/${id}/`,
      ]);
      expect(calls[0]?.init).toMatchObject({
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      expect(result.results[0]).toHaveProperty(
        noun === 'filings' || noun === 'contributions' ? 'registrant.id' : 'id',
        noun === 'filings' || noun === 'contributions' || noun === 'registrants'
          ? '1'
          : noun === 'clients'
            ? '2'
            : '4',
      );
      const text = formatResult(result)[0]?.text ?? '';
      const start = text.indexOf('\n');
      const fence = text.slice(0, start - 4);
      expect(JSON.parse(text.slice(start + 1, text.indexOf(`\n${fence}`, start)))).toEqual(result);
    },
  );
  it('fetches every official constants path', async () => {
    const { service, calls } = source((url) =>
      Response.json([
        url.pathname === '/api/v1/constants/filing/governmententities/'
          ? { id: 211, name: 'Synthetic board', extra: null }
          : { value: 'TEC', name: 'Synthetic label', extra: null },
      ]),
    );
    const paths = {
      issue_codes: 'filing/lobbyingactivityissues',
      filing_types: 'filing/filingtypes',
      government_entities: 'filing/governmententities',
      countries: 'general/countries',
      states: 'general/states',
      prefixes: 'lobbyist/prefixes',
      suffixes: 'lobbyist/suffixes',
      contribution_types: 'contribution/itemtypes',
    } as const;
    for (const topic of Object.keys(paths) as (keyof typeof paths)[])
      expect(await settle(service.constants(topic))).toEqual([
        topic === 'government_entities'
          ? { id: '211', value: '211', name: 'Synthetic board', extra: null }
          : { value: 'TEC', name: 'Synthetic label', extra: null },
      ]);
    expect(calls.map((x) => x.url.pathname)).toEqual(
      Object.values(paths).map((path) => `/api/v1/constants/${path}/`),
    );
  });
  it.each([211, '000211', '900719925474099312345'])(
    'normalizes government entity constant identity %s without dropping source fields',
    async (id) => {
      const { service, calls } = source((url) => {
        if (url.pathname !== '/api/v1/constants/filing/governmententities/')
          throw new Error(`Unmatched ${url}`);
        return Response.json([{ id, name: 'Synthetic board', future: { nested: [null, false] } }]);
      });
      expect(await settle(service.constants('government_entities'))).toEqual([
        {
          id: String(id),
          value: String(id),
          name: 'Synthetic board',
          future: { nested: [null, false] },
        },
      ]);
      expect(calls).toHaveLength(1);
    },
  );
  it('rejects unsafe numeric government entity constants without retry', async () => {
    const { service, calls } = source(() =>
      Response.json([{ id: Number.MAX_SAFE_INTEGER + 1, name: 'Synthetic board' }]),
    );
    await expect(settle(service.constants('government_entities'))).rejects.toMatchObject({
      data: { reason: 'source_schema_changed', retryable: false },
    });
    expect(calls).toHaveLength(1);
  });
  it('returns genuine empty pages and preserves huge string and safe integer identities', async () => {
    const { service } = source((url) =>
      Response.json(
        url.pathname.includes('/clients/')
          ? page([{ id: '000900719925474099312345', name: 'Synthetic' }])
          : page(),
      ),
    );
    expect(await settle(service.listFilings({}))).toEqual(page());
    expect((await settle(service.listClients({}))).results[0]?.id).toBe('000900719925474099312345');
  });
  it.each([{ issue_code: 'TEC' }, { page_size: 26 }, { page: 0 }, { page_size: '' }])(
    'rejects invalid filters %j before fetch',
    (filters) => {
      const { service, calls } = source(() => {
        throw new Error('Unexpected fetch');
      });
      expect(() => service.listFilings(filters)).toThrow();
      expect(calls).toEqual([]);
    },
  );
  it.each(['../1', 'https://evil.test', '1?x=2', ''])(
    'rejects unsafe detail ID %s before fetch',
    (id) => {
      const { service, calls } = source(() => {
        throw new Error('Unexpected fetch');
      });
      expect(() => service.getClient(id)).toThrow();
      expect(calls).toEqual([]);
    },
  );
});

describe('validated pagination', () => {
  it.each(['filings', 'contributions', 'clients', 'registrants', 'lobbyists'] as const)(
    'binds %s links to exact host, path, filters and next page',
    (noun) => {
      const { service, calls } = source(() => {
        throw new Error('Unexpected fetch');
      });
      const base = `https://lda.gov/api/v1/${noun}/?page_size=25&page=2`;
      expect(service.validateNext(noun, base, { page_size: 25 }, 1)).toBe(2);
      expect(service.validateNext(noun, null, {}, 1)).toBeNull();
      for (const bad of [
        base.replace('lda.gov', 'lda.gov.evil.test'),
        base.replace('https:', 'http:'),
        base.replace(`/${noun}/`, '/other/'),
        base.replace('page=2', 'page=1'),
        base.replace('page=2', 'page=3'),
        `${base}&page=2`,
        `${base}&unknown=1`,
        base.replace('25', '24'),
        `${base}#fragment`,
        base.replace('https://', 'https://user:secret@'),
        'not a url',
      ])
        expect(() => service.validateNext(noun, bad, { page_size: 25 }, 1)).toThrow(
          expect.objectContaining({
            data: expect.objectContaining({ reason: 'pagination_invalid' }),
          }),
        );
      expect(calls).toEqual([]);
    },
  );
});

describe('transport failures and shared budget', () => {
  it.each([400, 401, 403, 404])('does not retry HTTP %s', async (status) => {
    const { service, calls } = source(() => new Response('plain failure', { status }));
    await expect(settle(service.listClients({}))).rejects.toMatchObject({
      data: { status, retryable: false },
    });
    expect(calls).toHaveLength(1);
  });
  it.each([408, 429, 500, 502, 503, 504])('retries HTTP %s exactly once', async (status) => {
    const { service, calls } = source(() => new Response('plain failure', { status }));
    await expect(settle(service.listClients({}))).rejects.toMatchObject({
      data: { status, retryable: true },
    });
    expect(calls).toHaveLength(2);
  });
  it.each([
    '{}',
    'not json',
    JSON.stringify(page([{ id: Number.MAX_SAFE_INTEGER + 1, name: 'Synthetic' }])),
    '{"count":0,"next":null,"results":[],"__proto__":{"x":1}}',
  ])('fails closed without retry on malformed source %s', async (body) => {
    const { service, calls } = source(() => new Response(body));
    await expect(settle(service.listClients({}))).rejects.toMatchObject({
      data: { reason: 'source_schema_changed', retryable: false },
    });
    expect(calls).toHaveLength(1);
  });
  it('retries network and HTML failures but never an arbitrary programmer error', async () => {
    for (const failure of [new TypeError('Synthetic network'), '<html>unavailable</html>']) {
      const { service, calls } = source(() => {
        if (failure instanceof Error) throw failure;
        return new Response(failure);
      });
      await expect(settle(service.listClients({}))).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
      expect(calls).toHaveLength(2);
      service.dispose();
    }
    const error = new Error('Synthetic programmer failure');
    const { service, calls } = source(() => {
      throw error;
    });
    await expect(settle(service.listClients({}))).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  });
  it('shares starts across simultaneous instances and endpoint methods', async () => {
    const first = source(() => Response.json(page()));
    const second = new LdaService({ fetch: first.fetcher });
    services.push(second);
    const pending = Promise.all([
      first.service.listClients({}),
      second.listRegistrants({}),
      first.service.listLobbyists({}),
    ]);
    await settle(pending);
    expect(first.calls.map((x) => x.at - first.calls[0]!.at)).toEqual([0, 4100, 8200]);
  });
  it('uses the authenticated shared budget and token header', async () => {
    const boundary = source(() => Response.json(page()));
    boundary.service.dispose();
    const authenticated = new LdaService({
      apiKey: 'synthetic-test-token',
      fetch: boundary.fetcher,
    });
    services.push(authenticated);
    await settle(Promise.all([authenticated.listClients({}), authenticated.listRegistrants({})]));
    expect(boundary.calls.map((call) => call.at - boundary.calls[0]!.at)).toEqual([0, 510]);
    expect(boundary.calls[0]?.init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Token synthetic-test-token',
    });
  });
  it('does not fetch queued work whose absolute deadline expires before its paced start', async () => {
    const { service, calls } = source(() => Response.json(page()));
    const first = service.listClients({});
    const queued = service.listRegistrants({}, { deadlineMs: Date.now() + 1000 });
    const observed = queued.catch((error: unknown) => error);
    await settle(first);
    expect(await observed).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
  });
  it('refuses a Retry-After beyond the retry cap without retrying before upstream permits', async () => {
    const { service, calls } = source(
      () => new Response('rate limit', { status: 429, headers: { 'Retry-After': '999999' } }),
    );
    await expect(
      settle(service.listClients({}, { deadlineMs: Date.now() + 44000 })),
    ).rejects.toMatchObject({ data: { status: 429, retryAfter: '999999' } });
    expect(calls).toHaveLength(1);
  });
  it('honors an accepted Retry-After and returns the successful second response', async () => {
    let attempt = 0;
    const { service, calls } = source(() =>
      ++attempt === 1
        ? new Response('rate limit', { status: 429, headers: { 'Retry-After': '10' } })
        : Response.json(page()),
    );
    expect(await settle(service.listClients({}))).toEqual(page());
    expect(calls.map((call) => call.at - calls[0]!.at)).toEqual([0, 10000]);
  });
  it('rejects an over-deadline Retry-After without another attempt', async () => {
    const { service, calls } = source(
      () => new Response('rate limit', { status: 429, headers: { 'Retry-After': '10' } }),
    );
    await expect(
      settle(service.listClients({}, { deadlineMs: Date.now() + 5000 })),
    ).rejects.toMatchObject({ data: { status: 429 } });
    expect(calls).toHaveLength(1);
  });
  it('preserves complete 25-record pages including unknown nested disclosures', async () => {
    const records = Array.from({ length: 25 }, (_, index) => ({
      ...filing,
      filing_uuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    }));
    const { service } = source(() => Response.json(page(records)));
    const result = await settle(service.listFilings({ page_size: 25 }));
    expect(result.results).toHaveLength(25);
    expect(result.results[24]).toMatchObject({
      registrant: { id: '1' },
      client: { id: '0002' },
      future: { nested: [{ text: 'é🌲' }] },
      lobbying_activities: [
        { government_entities: [{ id: '3', name: null }], future: { values: [null, false, 0] } },
      ],
    });
  });
  it('fails closed on nested own prototype keys', async () => {
    const body =
      '{"count":1,"next":null,"results":[{"id":1,"name":"Synthetic","future":{"__proto__":null}}]}';
    const { service, calls } = source(() => new Response(body));
    await expect(settle(service.listClients({}))).rejects.toMatchObject({
      data: { reason: 'source_schema_changed', retryable: false },
    });
    expect(calls).toHaveLength(1);
  });
  it('does not start after an expired deadline or retry beyond the remaining budget', async () => {
    const { service, calls } = source(() => new Response('unavailable', { status: 503 }));
    expect(() => service.listClients({}, { deadlineMs: Date.now() })).toThrow();
    expect(calls).toEqual([]);
    await expect(
      settle(service.listClients({}, { deadlineMs: Date.now() + 100 })),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });
  it('preserves cancellation during exchange and removes queued work without fetching', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Synthetic caller cancellation', 'AbortError');
    const { service, calls } = source(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = service.listClients({}, { signal: controller.signal });
    const observed = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    expect(await observed).toBe(reason);
    expect(calls).toHaveLength(1);
    service.dispose();
    const next = source(() => Response.json(page()));
    await settle(next.service.listClients({}));
    const queuedController = new AbortController();
    const queued = next.service
      .listClients({}, { signal: queuedController.signal })
      .catch((error) => error);
    queuedController.abort(reason);
    expect(await queued).toBe(reason);
    expect(next.calls).toHaveLength(1);
  });
});
