/** @fileoverview Real FARA parsing, transport, cache and cancellation contracts at the fetch seam. @module tests/services/fara/fara-service */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FaraRecordSchema } from '../../../src/domain/fara.js';
import {
  latin1,
  principal,
  registrant,
  settle,
  snapshotResponse,
  xmlResponse,
} from './fixtures.js';

let module: typeof import('../../../src/services/fara/fara-service.js');
const signal = () => new AbortController().signal;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  module = await import('../../../src/services/fara/fara-service.js');
});
afterEach(() => {
  module.disposeFaraPacer();
  vi.useRealTimers();
});
function boundary(respond: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init?: RequestInit; at: number }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://efile.fara.gov') throw new Error('Unexpected FARA origin');
    calls.push({ url, ...(init && { init }), at: Date.now() });
    return respond(url, init);
  };
  return { service: new module.FaraService(fetcher), calls, fetcher };
}

describe('complete XML snapshots', () => {
  it('preserves every row, Latin-1 C1 bytes, entities, multiline fields, raw unknowns and leading zeroes', async () => {
    const { service, calls } = boundary(() =>
      snapshotResponse(
        'registrants',
        registrant(
          '000123',
          'Caf\u00e9 \u0080 &amp; &quot;firm&quot;\nsecond line',
          '',
          '<ZIP>00120-0001</ZIP><future><value>raw</value></future>',
        ) + registrant('9', 'Terminated', '04/01/2024'),
      ),
    );
    const result = await settle(service.search({ status: 'all' }, signal()));
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      registration_number: '000123',
      name: 'Caf\u00e9 \u0080 & "firm"\nsecond line',
      status: 'active',
      registration_date: '2024-02-29',
      registration_date_raw: '02/29/2024',
      raw: { ZIP: '00120-0001', future: { value: 'raw' } },
    });
    expect(result.records[1]).toMatchObject({
      status: 'terminated',
      termination_date: '2024-04-01',
    });
    expect(result.snapshot_last_modified).toBe('Sat, 24 Oct 2026 12:00:00 GMT');
    expect(result.records.every((record) => FaraRecordSchema.safeParse(record).success)).toBe(true);
    expect(calls.map((call) => call.url.pathname)).toEqual([
      '/bulk/zip/FARA_All_Registrants.xml.zip',
    ]);
    expect(calls[0]?.init).toMatchObject({
      redirect: 'error',
      headers: { Accept: 'application/zip' },
    });
  });
  it('filters the complete principal snapshot and joins independent registrant status', async () => {
    const { service, calls } = boundary((url) =>
      url.pathname.includes('ForeignPrincipals')
        ? snapshotResponse(
            'foreign_principals',
            principal('01', 'Other') +
              principal('02', 'Caf\u00e9 Long Name', 'Canada') +
              principal('03', 'Long Caf\u00e9', 'France', '01/01/2025'),
          )
        : snapshotResponse(
            'registrants',
            registrant('02', 'Terminated firm', '01/01/2025') + registrant('03', 'Active firm'),
          ),
    );
    const result = await settle(
      service.search(
        {
          entity: 'foreign_principals',
          country: ' cAnAdA ',
          name_contains: ' LONG   CAF\u00c9 ',
          status: 'active',
        },
        signal(),
      ),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      registration_number: '02',
      status: 'active',
      registrant_status: 'terminated',
      listing_url: 'https://efile.fara.gov/api/v1/Registrants/html/Terminated',
    });
    expect(calls).toHaveLength(2);
    await expect(
      settle(service.search({ entity: 'foreign_principals', country: 'CA' }, signal())),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
    expect((await settle(service.countries(signal()))).countries).toEqual(['Canada', 'France']);
    expect(
      (
        await settle(
          service.search({ entity: 'foreign_principals', status: 'terminated' }, signal()),
        )
      ).records.map((record) => record.registration_number),
    ).toEqual(['03']);
    expect(calls).toHaveLength(2);
  });
  it.each([
    '<!DOCTYPE REGISTRANTS [<!ENTITY x "boom">]><REGISTRANTS/>',
    '<REGISTRANTS><ROW></REGISTRANTS>',
    '<REGISTRANTS><ROW><__proto__>x</__proto__></ROW></REGISTRANTS>',
    '<html>unavailable</html>',
  ])('rejects unsafe or malformed XML without retry: %s', async (xml) => {
    const { service, calls } = boundary(() => xmlResponse('Registrants', xml));
    await expect(settle(service.search({}, signal()))).rejects.toMatchObject({
      data: { reason: 'source_schema_changed' },
    });
    expect(calls).toHaveLength(1);
  });
  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'never silently renames unknown XML key %s',
    async (key) => {
      const { service } = boundary(() =>
        snapshotResponse(
          'registrants',
          registrant('1', 'Synthetic', '', `<${key}>retained</${key}>`),
        ),
      );
      const outcome = await settle(
        service.search({}, signal()).then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
      );
      if ('error' in outcome)
        expect(outcome.error).toMatchObject({ data: { reason: 'source_schema_changed' } });
      else
        expect(Object.getOwnPropertyDescriptor(outcome.value.records[0]?.raw, key)?.value).toBe(
          'retained',
        );
    },
  );
  it('does not fabricate normalized dates for invalid calendar days', async () => {
    const { service } = boundary(() =>
      snapshotResponse('registrants', registrant('1', 'Synthetic', '02/30/2024')),
    );
    const result = await settle(service.search({ status: 'all' }, signal()));
    expect(result.records[0]?.termination_date_raw).toBe('02/30/2024');
    expect(result.records[0]).not.toHaveProperty('termination_date');
  });
});

describe('live detail shapes', () => {
  it.each(['foreign_principals', 'short_forms', 'documents'] as const)(
    'accepts sparse singleton and array %s rows, with numeric and lossless string IDs',
    async (detail) => {
      const makeRow = (id: number | string) =>
        detail === 'foreign_principals'
          ? {
              REG_NUMBER: id,
              FP_NAME: 'Caf\u00e9 \u0081',
              ZIP: '00102',
              extra: { nested: [null, false, 0] },
            }
          : detail === 'short_forms'
            ? { REG_NUMBER: id, SF_LAST_NAME: 'Only surname', ZIP: 123 }
            : {
                REGISTRATION_NUMBER: id,
                DOCUMENT_TYPE: 'Supplement',
                URL: 'https://efile.fara.gov/docs/authoritative.pdf',
                DATE_STAMPED: '02/29/2024',
              };
      let array = false;
      const { service, calls } = boundary(
        () =>
          new Response(
            latin1(
              JSON.stringify({
                ROWSET: { ROW: array ? [makeRow(12), makeRow('00012')] : makeRow('00012') },
              }),
            ),
          ),
      );
      const singleton = await settle(
        service.detail({ detail, registration_number: '00012' }, signal()),
      );
      expect(singleton.records[0]?.registration_number).toBe('00012');
      expect(singleton.records[0]?.raw).toEqual(makeRow('00012'));
      expect(singleton.records[0]).not.toHaveProperty('raw.ADDRESS_1');
      if (detail === 'documents') {
        expect(singleton.status).toBe('all');
        expect(singleton.records[0]).not.toHaveProperty('status');
        expect(singleton.records[0]?.date_stamped).toBe('2024-02-29');
      }
      array = true;
      const rows = await settle(service.detail({ detail, registration_number: '00012' }, signal()));
      expect(rows.records.map((row) => row.registration_number)).toEqual(['12', '00012']);
      expect(rows.records.every((row) => FaraRecordSchema.safeParse(row).success)).toBe(true);
      expect(calls.every((call) => call.url.pathname.endsWith('/00012'))).toBe(true);
    },
  );
  it.each(['foreign_principals', 'short_forms'] as const)(
    'fetches both status arms for %s and records each arm accurately',
    async (detail) => {
      const { service, calls } = boundary(() =>
        Response.json({
          ROWSET: {
            ROW:
              detail === 'short_forms'
                ? { REG_NUMBER: 1, SF_LAST_NAME: 'Synthetic' }
                : { REG_NUMBER: 1, FP_NAME: 'Synthetic' },
          },
        }),
      );
      const result = await settle(
        service.detail({ detail, registration_number: '1', status: 'all' }, signal()),
      );
      expect(result.records.map((row) => row.status)).toEqual(['active', 'terminated']);
      const noun = detail === 'short_forms' ? 'ShortFormRegistrants' : 'ForeignPrincipals';
      expect(calls.map((call) => call.url.pathname)).toEqual([
        `/api/v1/${noun}/json/Active/1`,
        `/api/v1/${noun}/json/Terminated/1`,
      ]);
    },
  );
  it.each(['foreign_principals', 'short_forms', 'documents'] as const)(
    'accepts ROWSET-empty %s without asserting registration absence',
    async (detail) => {
      const { service } = boundary(() => Response.json({ ROWSET: '' }));
      const result = await settle(service.detail({ detail, registration_number: '1' }, signal()));
      expect(result.records).toEqual([]);
      expect(result.notices.join(' ')).toContain('does not establish');
    },
  );
  it.each(['active', 'terminated'] as const)(
    'rejects document status %s before I/O',
    async (status) => {
      const { service, calls } = boundary(() => Response.json({ ROWSET: '' }));
      await expect(
        service.detail({ detail: 'documents', registration_number: '1', status }, signal()),
      ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
      expect(calls).toEqual([]);
    },
  );
  it.each([
    '{}',
    'not json',
    '{"ROWSET":{"ROW":{"REG_NUMBER":9007199254740992,"FP_NAME":"bad"}}}',
    '{"ROWSET":{"ROW":{"REG_NUMBER":1,"FP_NAME":"bad","__proto__":{"polluted":true}}}}',
  ])('rejects fully-read malformed detail without retry: %s', async (body) => {
    const { service, calls } = boundary(() => new Response(body));
    await expect(
      settle(service.detail({ registration_number: '1' }, signal())),
    ).rejects.toMatchObject({ data: { reason: 'source_schema_changed' } });
    expect(calls).toHaveLength(1);
  });
});

describe('transport and shared snapshot lifetime', () => {
  it('classifies plain-text 404 without retry and plain-text 429 with one retry', async () => {
    for (const status of [404, 429]) {
      const { service, calls } = boundary(
        () => new Response('Request rate too high', { status, headers: { 'Retry-After': '1' } }),
      );
      await expect(
        settle(service.detail({ registration_number: '1' }, signal())),
      ).rejects.toMatchObject({
        data: { reason: status === 429 ? 'source_rate_limited' : 'upstream_unavailable' },
      });
      expect(calls).toHaveLength(status === 429 ? 2 : 1);
    }
  });
  it.each(['html', 'network'])('retries transient %s exchanges once', async (failure) => {
    const { service, calls } = boundary(() => {
      if (failure === 'network') throw new TypeError('Synthetic fetch failure');
      return new Response('<html>unavailable</html>');
    });
    await expect(
      settle(service.detail({ registration_number: '1' }, signal())),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(calls).toHaveLength(2);
  });
  it('does not wrap or retry programmer exceptions', async () => {
    const error = new Error('Synthetic programmer failure');
    const { service, calls } = boundary(() => {
      throw error;
    });
    await expect(settle(service.detail({ registration_number: '1' }, signal()))).rejects.toBe(
      error,
    );
    expect(calls).toHaveLength(1);
  });
  it('also preserves programmer exceptions on the bulk-snapshot path', async () => {
    const error = new Error('Synthetic snapshot programmer failure');
    const { service, calls } = boundary(() => {
      throw error;
    });
    await expect(settle(service.search({}, signal()))).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  });
  it('retries a failed body read together with its request', async () => {
    let attempts = 0;
    const { service, calls } = boundary(() => {
      attempts++;
      if (attempts > 1) return Response.json({ ROWSET: '' });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('Synthetic network body failure'));
          },
        }),
      );
    });
    expect((await settle(service.detail({ registration_number: '1' }, signal()))).records).toEqual(
      [],
    );
    expect(calls).toHaveLength(2);
  });
  it('shares paced starts across instances and detail collections', async () => {
    const first = boundary(() => Response.json({ ROWSET: '' }));
    const second = new module.FaraService(first.fetcher);
    await settle(
      Promise.all([
        first.service.detail({ registration_number: '1' }, signal()),
        second.detail({ registration_number: '2', detail: 'documents' }, signal()),
        first.service.detail({ registration_number: '3', detail: 'short_forms' }, signal()),
      ]),
    );
    expect(first.calls.map((call) => call.at - first.calls[0]!.at)).toEqual([0, 4100, 8200]);
  });
  it('does not extend a short total deadline to satisfy Retry-After', async () => {
    const { service, calls } = boundary(
      () =>
        new Response('Request rate too high', { status: 429, headers: { 'Retry-After': '30' } }),
    );
    await expect(
      settle(service.detail({ registration_number: '1' }, signal(), Date.now() + 5000)),
    ).rejects.toMatchObject({ data: { reason: 'source_rate_limited' } });
    expect(calls).toHaveLength(1);
  });
  it.each(['broken zip', 'wrong member'])(
    'fails closed for %s rather than inferring zero rows',
    async (failure) => {
      const { service, calls } = boundary(() =>
        failure === 'broken zip'
          ? new Response('not zip bytes')
          : xmlResponse('OtherDataset', '<REGISTRANTS/>'),
      );
      await expect(settle(service.search({}, signal()))).rejects.toMatchObject({
        data: { reason: 'source_schema_changed' },
      });
      expect(calls).toHaveLength(1);
    },
  );
  it('returns snapshot_unavailable instead of empty success when download fails', async () => {
    const { service, calls } = boundary(() => new Response('missing', { status: 404 }));
    await expect(settle(service.search({}, signal()))).rejects.toMatchObject({
      data: { reason: 'snapshot_unavailable' },
    });
    expect(calls).toHaveLength(1);
  });
  it('shares cache across instances and awaits refresh exactly at 24-hour TTL', async () => {
    let revision = 1;
    const first = boundary(() =>
      snapshotResponse('registrants', registrant('1', `Revision ${revision}`)),
    );
    const second = new module.FaraService(first.fetcher);
    const initial = await settle(first.service.search({}, signal()));
    revision = 2;
    vi.setSystemTime(Date.parse(initial.snapshot_retrieved_at ?? '') + 86_400_000 - 1);
    expect((await settle(second.search({}, signal()))).records[0]?.name).toBe('Revision 1');
    vi.setSystemTime(Date.parse(initial.snapshot_retrieved_at ?? '') + 86_400_000);
    expect((await settle(second.search({}, signal()))).records[0]?.name).toBe('Revision 2');
    expect(first.calls).toHaveLength(2);
  });
  it('single-flights a snapshot while allowing one waiter to cancel independently', async () => {
    let release!: (value: Response) => void;
    let exchange: AbortSignal | undefined;
    const { service, calls } = boundary((_url, init) => {
      exchange = init?.signal ?? undefined;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const controller = new AbortController();
    const cancelled = service.search({}, controller.signal).catch((error) => error);
    const retained = service.search({}, signal());
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException('Synthetic cancelled', 'AbortError'));
    expect(await cancelled).toBe(controller.signal.reason);
    expect(exchange?.aborted).toBe(false);
    release(snapshotResponse('registrants', registrant('1', 'Synthetic')));
    expect((await settle(retained)).records).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
  it('aborts the shared exchange when the final waiter cancels and leaves no cache', async () => {
    let exchange: AbortSignal | undefined;
    const { service, calls } = boundary((_url, init) => {
      exchange = init?.signal ?? undefined;
      return new Promise((_resolve, reject) =>
        exchange?.addEventListener('abort', () => reject(exchange?.reason), { once: true }),
      );
    });
    const controller = new AbortController();
    const pending = service.search({}, controller.signal).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException('Synthetic cancelled', 'AbortError'));
    expect(await settle(pending)).toBe(controller.signal.reason);
    expect(exchange?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
  it('does not start I/O for an exhausted total deadline', async () => {
    const { service, calls } = boundary(() => Response.json({ ROWSET: '' }));
    await expect(
      service.detail({ registration_number: '1' }, signal(), Date.now()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(calls).toEqual([]);
  });
  it('preserves cancellation before starting detail transport', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Synthetic cancelled', 'AbortError'));
    const { service, calls } = boundary(() => Response.json({ ROWSET: '' }));
    await expect(service.detail({ registration_number: '1' }, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
    expect(calls).toEqual([]);
  });
});
