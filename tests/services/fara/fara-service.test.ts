/** @fileoverview Real FARA parsing, transport, cache and cancellation contracts at the fetch seam. @module tests/services/fara/fara-service */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FaraRecordSchema } from '../../../src/domain/fara.js';
import {
  latin1,
  principal,
  registrant,
  settle,
  shortForm,
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
      redirect: 'manual',
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
  it('normalizes every principal snapshot field and keeps its own listing when unjoined', async () => {
    const { service, calls } = boundary((url) =>
      url.pathname.includes('ForeignPrincipals')
        ? snapshotResponse(
            'foreign_principals',
            principal('04', 'Synthetic principal', 'France', '01/01/2025'),
          )
        : snapshotResponse('registrants', registrant('05', 'Unrelated firm')),
    );
    const result = await settle(
      service.search({ entity: 'foreign_principals', status: 'all' }, signal()),
    );
    expect(result.records).toEqual([
      {
        registration_number: '04',
        name: 'Synthetic principal',
        entity: 'foreign_principals',
        status: 'terminated',
        registration_date_raw: '2024-02-29T00:00:00',
        termination_date_raw: '01/01/2025',
        registration_date: '2024-02-29',
        termination_date: '2025-01-01',
        registrant_name: 'Synthetic firm',
        country: 'France',
        listing_url: 'https://efile.fara.gov/api/v1/Registrants/html/Terminated',
        raw: {
          Registration_number: '04',
          Foreign_principal: 'Synthetic principal',
          Registrant_name: 'Synthetic firm',
          Country_location_represented: 'France',
          FP_registration_date: '2024-02-29T00:00:00',
          FP_termination_date: '01/01/2025',
        },
      },
    ]);
    expect(result.source_urls).toEqual([
      'https://efile.fara.gov/bulk/zip/FARA_All_ForeignPrincipals.xml.zip',
      'https://efile.fara.gov/bulk/zip/FARA_All_Registrants.xml.zip',
    ]);
    expect(calls).toHaveLength(2);
  });
  it.each([
    [
      'registrants',
      '<ROW><Registration_Number>1</Registration_Number><Termination_Date></Termination_Date></ROW>',
    ],
    [
      'foreign_principals',
      '<ROW><Registration_number>1</Registration_number><FP_termination_date></FP_termination_date></ROW>',
    ],
  ] as const)('fails closed on a nameless %s row', async (entity, row) => {
    const { service, calls } = boundary(() => snapshotResponse(entity, row));
    await expect(settle(service.search({ entity }, signal()))).rejects.toMatchObject({
      data: { reason: 'source_schema_changed' },
    });
    expect(calls).toHaveLength(1);
  });
  it('does not fabricate normalized dates for invalid calendar days', async () => {
    const { service } = boundary(() =>
      snapshotResponse('registrants', registrant('1', 'Synthetic', '02/30/2024')),
    );
    const result = await settle(service.search({ status: 'all' }, signal()));
    expect(result.records[0]?.termination_date_raw).toBe('02/30/2024');
    expect(result.records[0]).not.toHaveProperty('termination_date');
  });
});

type Archive = 'registrants' | 'foreign_principals' | 'short_forms';
const ZIP = (noun: string) => `https://efile.fara.gov/bulk/zip/FARA_All_${noun}.xml.zip`;
function archive(url: URL): Archive {
  return url.pathname.includes('ShortForms')
    ? 'short_forms'
    : url.pathname.includes('ForeignPrincipals')
      ? 'foreign_principals'
      : 'registrants';
}
/** Serve only the named snapshots; any other download is a test failure. */
function snapshots(rows: Partial<Record<Archive, string>>) {
  return boundary((url) => {
    const kind = archive(url);
    const selected = rows[kind];
    if (selected === undefined) throw new Error(`Unexpected snapshot ${url.pathname}`);
    return snapshotResponse(kind, selected);
  });
}
const people =
  shortForm('7108', {
    first: 'Avery T',
    last: 'Synthetica',
    date: '04/15/2022',
    termination: '05/11/2022',
  }) +
  shortForm('6103', {
    first: 'Blair M.',
    last: 'Synthetica',
    date: '05/15/2012',
    termination: '12/01/2014',
  }) +
  shortForm('5926', {
    first: 'Avery T.',
    last: 'Synthetica',
    date: '04/01/2009',
    termination: '12/31/2017',
  }) +
  shortForm('7795', { first: 'Casey', last: 'Othername', date: '11/12/2026' });
const firms =
  registrant('7108', 'Firm A', '05/11/2022') +
  registrant('6103', 'Firm B', '12/01/2014') +
  registrant('5926', 'Firm C', '12/31/2017') +
  registrant('7795', 'Firm D');

describe('short-form snapshot search', () => {
  it('matches first and last names token-AND under the selected short-form status', async () => {
    const { service, calls } = snapshots({ short_forms: people, registrants: firms });
    const all = await settle(
      service.search(
        { entity: 'short_forms', name_contains: 'synthetica', status: 'all' },
        signal(),
      ),
    );
    expect(all.records.map((row) => row.registration_number)).toEqual(['7108', '6103', '5926']);
    expect(all.records[0]).toEqual({
      registration_number: '7108',
      name: 'Avery T Synthetica',
      first_name: 'Avery T',
      last_name: 'Synthetica',
      entity: 'short_forms',
      status: 'terminated',
      registration_date_raw: '04/15/2022',
      termination_date_raw: '05/11/2022',
      registration_date: '2022-04-15',
      termination_date: '2022-05-11',
      registrant_name: 'Synthetic firm 7108',
      registrant_status: 'terminated',
      listing_url: 'https://efile.fara.gov/api/v1/Registrants/html/Terminated',
      raw: {
        Short_form_termination_date: '05/11/2022',
        Short_form_date: '04/15/2022',
        Short_form_last_name: 'Synthetica',
        Short_form_first_name: 'Avery T',
        Registration_number: '7108',
        Registration_date: '01/02/2020',
        Registrant_name: 'Synthetic firm 7108',
        Address_1: '1 Synthetic Way',
      },
    });
    expect(all.records.every((row) => FaraRecordSchema.safeParse(row).success)).toBe(true);
    expect(all.status).toBe('all');
    expect(all.source_urls).toEqual([ZIP('ShortForms'), ZIP('Registrants')]);
    expect(all.snapshot_source_urls).toEqual([ZIP('ShortForms'), ZIP('Registrants')]);
    expect(all.notices).toEqual([
      'FARA search uses complete daily snapshots; short-form status is independent of registrant status. Short-form matches are name matches and establish no identity across registrations or with LDA lobbyists.',
    ]);
    const active = await settle(
      service.search({ entity: 'short_forms', name_contains: 'synthetica' }, signal()),
    );
    expect(active.status).toBe('active');
    expect(active.records).toEqual([]);
    for (const [query, expected] of [
      ['avery synthetica', ['7108', '5926']],
      ['  SYNTHETICA   Avery ', ['7108', '5926']],
      ['bob synthetica', []],
    ] as const)
      expect(
        (
          await settle(
            service.search(
              { entity: 'short_forms', name_contains: query, status: 'all' },
              signal(),
            ),
          )
        ).records.map((row) => row.registration_number),
      ).toEqual(expected);
    expect(calls.map((call) => call.url.href)).toEqual([ZIP('ShortForms'), ZIP('Registrants')]);
  });
  it('never downloads the short-form snapshot for registrant or principal searches', async () => {
    const { service, calls } = snapshots({
      registrants: firms,
      foreign_principals: principal('7108', 'Synthetic principal'),
    });
    await settle(service.search({ status: 'all' }, signal()));
    await settle(service.search({ entity: 'foreign_principals', status: 'all' }, signal()));
    expect(calls.map((call) => call.url.href)).toEqual([
      ZIP('Registrants'),
      ZIP('ForeignPrincipals'),
    ]);
  });
  it('keeps nameless, partially named and duplicate rows as separate source rows', async () => {
    const twin = shortForm('7267', { first: 'Dup', last: 'Twin', date: '05/05/2023' });
    const { service } = snapshots({
      short_forms:
        shortForm('7426') +
        shortForm('1676', { first: 'G.Example', date: '02/08/1967', termination: '12/31/1966' }) +
        twin +
        twin,
      registrants: registrant('7426', 'Firm') + registrant('1676', 'Old firm', '01/01/1990'),
    });
    const all = await settle(service.search({ entity: 'short_forms', status: 'all' }, signal()));
    expect(all.records.map((row) => row.registration_number)).toEqual([
      '7426',
      '1676',
      '7267',
      '7267',
    ]);
    const [nameless, partial, first, second] = all.records;
    expect(nameless).toMatchObject({ name: '', status: 'active', registrant_status: 'active' });
    expect(nameless).not.toHaveProperty('first_name');
    expect(nameless).not.toHaveProperty('last_name');
    expect(nameless).not.toHaveProperty('registration_date');
    expect(partial).toMatchObject({
      name: 'G.Example',
      first_name: 'G.Example',
      status: 'terminated',
      registration_date: '1967-02-08',
      termination_date: '1966-12-31',
    });
    expect(partial).not.toHaveProperty('last_name');
    expect(second).toEqual(first);
    for (const [query, expected] of [
      ['twin', ['7267', '7267']],
      ['example', ['1676']],
    ] as const)
      expect(
        (
          await settle(
            service.search(
              { entity: 'short_forms', name_contains: query, status: 'all' },
              signal(),
            ),
          )
        ).records.map((row) => row.registration_number),
      ).toEqual(expected);
  });
  it('joins registrant status independently and omits it for an unjoined registration', async () => {
    const { service } = snapshots({
      short_forms:
        shortForm('100', { first: 'Active', last: 'Person', date: '01/01/2020' }) +
        shortForm('200', { first: 'Unjoined', last: 'Person', date: '01/01/2020' }),
      registrants: registrant('100', 'Terminated firm', '01/01/2025'),
    });
    const [joined, unjoined] = (
      await settle(service.search({ entity: 'short_forms', name_contains: 'person' }, signal()))
    ).records;
    expect(joined).toMatchObject({
      status: 'active',
      registrant_status: 'terminated',
      listing_url: 'https://efile.fara.gov/api/v1/Registrants/html/Terminated',
    });
    expect(unjoined).toMatchObject({
      status: 'active',
      listing_url: 'https://efile.fara.gov/api/v1/Registrants/html/Active',
    });
    expect(unjoined).not.toHaveProperty('registrant_status');
  });
  it('rejects a country filter on short forms before any download', async () => {
    const { service, calls } = snapshots({});
    await expect(
      service.search({ entity: 'short_forms', country: 'Canada' }, signal()),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter' } });
    expect(calls).toEqual([]);
  });
  it('agrees with detail mode on the normalized short-form fields', async () => {
    const live: Record<string, { arm: string; row: Record<string, unknown> }> = {
      '7108': {
        arm: 'Terminated',
        row: {
          REG_NUMBER: 7108,
          SF_FIRST_NAME: 'Avery T',
          SF_LAST_NAME: 'Synthetica',
          SHORTFORM_DATE: '2022-04-15T00:00:00',
          SF_TERM_DATE: '2022-05-11T00:00:00',
          REGISTRANT_NAME: 'Synthetic firm 7108',
          ZIP: 20008,
        },
      },
      '1676': {
        arm: 'Terminated',
        row: {
          REG_NUMBER: 1676,
          SF_FIRST_NAME: 'G.Example',
          SF_LAST_NAME: '',
          SHORTFORM_DATE: '1967-02-08T00:00:00',
          SF_TERM_DATE: '1966-12-31T00:00:00',
        },
      },
      '7426': {
        arm: 'Active',
        row: { REG_NUMBER: 7426, SF_FIRST_NAME: '', SF_LAST_NAME: '', SHORTFORM_DATE: '' },
      },
    };
    const { service } = boundary((url) => {
      if (url.pathname.startsWith('/bulk/'))
        return archive(url) === 'short_forms'
          ? snapshotResponse(
              'short_forms',
              shortForm('7108', {
                first: 'Avery T',
                last: 'Synthetica',
                date: '04/15/2022',
                termination: '05/11/2022',
              }) +
                shortForm('1676', {
                  first: 'G.Example',
                  date: '02/08/1967',
                  termination: '12/31/1966',
                }) +
                shortForm('7426'),
            )
          : snapshotResponse('registrants', registrant('7108', 'Firm', '05/11/2022'));
      const [, , , , , arm, id] = url.pathname.split('/');
      const entry = live[id ?? ''];
      return Response.json({ ROWSET: entry && entry.arm === arm ? { ROW: entry.row } : '' });
    });
    const fields = [
      'registration_number',
      'name',
      'first_name',
      'last_name',
      'status',
      'registration_date',
      'termination_date',
    ] as const;
    const pick = (row: Record<string, unknown> | undefined) =>
      Object.fromEntries(fields.flatMap((key) => (row && key in row ? [[key, row[key]]] : [])));
    const hits = (await settle(service.search({ entity: 'short_forms', status: 'all' }, signal())))
      .records;
    for (const hit of hits) {
      const detail = await settle(
        service.detail(
          { detail: 'short_forms', registration_number: hit.registration_number, status: 'all' },
          signal(),
        ),
      );
      expect(detail.records).toHaveLength(1);
      expect(pick(detail.records[0])).toEqual(pick(hit));
      expect(detail.records[0]?.raw).toEqual(live[hit.registration_number]?.row);
    }
    expect(pick(hits[0])).toEqual({
      registration_number: '7108',
      name: 'Avery T Synthetica',
      first_name: 'Avery T',
      last_name: 'Synthetica',
      status: 'terminated',
      registration_date: '2022-04-15',
      termination_date: '2022-05-11',
    });
  });
});

describe('live detail shapes', () => {
  const target =
    'https://efile.fara.gov/CallAPI/GetJSON?a=f?p=API:REGISTRANTDOCS-F_XML:::::F_XML_REG_NUM,F_XML_CC,F_XML_DOC_TYPE:5931,,';
  it('follows one paced registrant-documents redirect and retains both source URLs', async () => {
    const raw = {
      REGISTRATION_NUMBER: '5931',
      DOCUMENT_TYPE: 'Supplement',
      URL: 'https://efile.fara.gov/docs/source.pdf',
      future: { retained: [null, false, 0] },
    };
    const { service, calls } = boundary((url) =>
      url.pathname.startsWith('/api/')
        ? new Response(null, { status: 302, headers: { Location: target } })
        : Response.json({ ROWSET: { ROW: raw } }),
    );
    const result = await settle(
      service.detail({ detail: 'documents', registration_number: '5931' }, signal()),
    );
    expect(result.records[0]?.raw).toEqual(raw);
    expect(result.source_urls).toEqual(['https://efile.fara.gov/api/v1/RegDocs/json/5931', target]);
    expect(calls.map((call) => call.url.href)).toEqual(result.source_urls);
    expect(calls.map((call) => call.at - calls[0]!.at)).toEqual([0, 4100]);
    expect(calls.every((call) => call.init?.redirect === 'manual')).toBe(true);
  });
  it.each([
    target.replace('efile.fara.gov', 'outside.example'),
    target.replace('https:', 'http:'),
    target.replace('efile.fara.gov', 'user@efile.fara.gov'),
    `${target}#fragment`,
    `${target}#`,
    `${target}&extra=1`,
    `${target}&a=duplicate`,
    target.replace('5931,,', '5932,,'),
    target.replace('/CallAPI/GetJSON', '/other'),
    '',
  ])('rejects unsupported document redirect without contacting target: %s', async (location) => {
    const { service, calls } = boundary(
      () => new Response(null, { status: 302, headers: { Location: location } }),
    );
    await expect(
      settle(service.detail({ detail: 'documents', registration_number: '5931' }, signal())),
    ).rejects.toMatchObject({ data: { reason: 'source_schema_changed', retryable: false } });
    expect(calls).toHaveLength(1);
  });
  it('rejects a second redirect without retrying the chain', async () => {
    const { service, calls } = boundary(
      () => new Response(null, { status: 302, headers: { Location: target } }),
    );
    await expect(
      settle(service.detail({ detail: 'documents', registration_number: '5931' }, signal())),
    ).rejects.toMatchObject({ data: { reason: 'source_schema_changed', retryable: false } });
    expect(calls).toHaveLength(2);
  });
  it('retains the empty-collection caveat after a redirect for a lossless fabricated ID', async () => {
    const id = '987654321987654321';
    const location = target.replace('5931,,', `${id},,`);
    const { service, calls } = boundary((url) =>
      url.pathname.startsWith('/api/')
        ? new Response(null, { status: 302, headers: { Location: location } })
        : Response.json({ ROWSET: '' }),
    );
    const result = await settle(
      service.detail({ detail: 'documents', registration_number: id }, signal()),
    );
    expect(result.records).toEqual([]);
    expect(result.notices.join(' ')).toContain('does not establish');
    expect(result.source_urls).toEqual([
      `https://efile.fara.gov/api/v1/RegDocs/json/${id}`,
      location,
    ]);
    expect(calls).toHaveLength(2);
  });
  it.each([429, 500, 502, 503, 504])(
    'retries a redirected HTTP %s once, pacing every exchange',
    async (status) => {
      let targets = 0;
      const { service, calls } = boundary((url) => {
        if (url.pathname.startsWith('/api/'))
          return new Response(null, { status: 302, headers: { Location: target } });
        targets++;
        return targets === 1
          ? new Response('temporary', { status })
          : Response.json({ ROWSET: '' });
      });
      expect(
        (
          await settle(
            service.detail({ detail: 'documents', registration_number: '5931' }, signal()),
          )
        ).records,
      ).toEqual([]);
      expect(calls.map((call) => call.url.pathname)).toEqual([
        '/api/v1/RegDocs/json/5931',
        '/CallAPI/GetJSON',
        '/api/v1/RegDocs/json/5931',
        '/CallAPI/GetJSON',
      ]);
      expect(calls.slice(1).every((call, index) => call.at - calls[index]!.at >= 4100)).toBe(true);
    },
  );
  it('does not retry a fully read incompatible response after the supported redirect', async () => {
    const { service, calls } = boundary((url) =>
      url.pathname.startsWith('/api/')
        ? new Response(null, { status: 302, headers: { Location: target } })
        : Response.json({ unsupported: [] }),
    );
    await expect(
      settle(service.detail({ detail: 'documents', registration_number: '5931' }, signal())),
    ).rejects.toMatchObject({ data: { reason: 'source_schema_changed', retryable: false } });
    expect(calls).toHaveLength(2);
  });
  it('retries a failed redirected body read with the complete two-exchange request', async () => {
    let targets = 0;
    const { service, calls } = boundary((url) => {
      if (url.pathname.startsWith('/api/'))
        return new Response(null, { status: 302, headers: { Location: target } });
      if (++targets > 1) return Response.json({ ROWSET: '' });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('Synthetic body read failure'));
          },
        }),
      );
    });
    expect(
      (await settle(service.detail({ detail: 'documents', registration_number: '5931' }, signal())))
        .records,
    ).toEqual([]);
    expect(calls).toHaveLength(4);
  });
  it('keeps the original deadline while waiting for the second exchange', async () => {
    const { service, calls } = boundary(
      () => new Response(null, { status: 302, headers: { Location: target } }),
    );
    await expect(
      settle(
        service.detail(
          { detail: 'documents', registration_number: '5931' },
          signal(),
          Date.now() + 1000,
        ),
      ),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });
  it.each(['foreign_principals', 'short_forms'] as const)(
    'never follows a %s redirect',
    async (detail) => {
      const { service, calls } = boundary(
        () => new Response(null, { status: 302, headers: { Location: target } }),
      );
      await expect(
        settle(service.detail({ detail, registration_number: '5931' }, signal())),
      ).rejects.toMatchObject({ data: { reason: 'source_schema_changed', retryable: false } });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init?.redirect).toBe('manual');
    },
  );
  it('preserves cancellation while the redirect waits for its own pacer slot', async () => {
    const controller = new AbortController();
    const { service, calls } = boundary(
      () => new Response(null, { status: 302, headers: { Location: target } }),
    );
    const pending = service
      .detail({ detail: 'documents', registration_number: '5931' }, controller.signal)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    controller.abort(new DOMException('Synthetic cancelled', 'AbortError'));
    expect(await settle(pending)).toBe(controller.signal.reason);
    expect(calls).toHaveLength(1);
  });
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
  it.each(['foreign_principals', 'short_forms', 'documents'] as const)(
    'reads %s text fields FARA sends as JSON numbers as their digits, keeping the numbers in raw',
    async (detail) => {
      // FARA's JSON writes an all-digit value as a number; registration 5926's documents carry REGISTRANT_NAME 5926.
      const row =
        detail === 'foreign_principals'
          ? { REG_NUMBER: 5926, FP_NAME: 1234, REGISTRANT_NAME: 5926, COUNTRY_NAME: 7 }
          : detail === 'short_forms'
            ? { REG_NUMBER: 5926, SF_FIRST_NAME: 12, SF_LAST_NAME: 34, REGISTRANT_NAME: 5926 }
            : {
                REGISTRATION_NUMBER: 5926,
                DOCUMENT_TYPE: 'Short-Form',
                URL: 'https://efile.fara.gov/docs/numeric.pdf',
                REGISTRANT_NAME: 5926,
                SHORT_FORM_NAME: 56,
              };
      const { service } = boundary(() => Response.json({ ROWSET: { ROW: row } }));
      const result = await settle(
        service.detail({ detail, registration_number: '5926' }, signal()),
      );
      const [record] = result.records;
      expect(record?.registrant_name).toBe('5926');
      expect(record?.raw).toEqual(row);
      expect(FaraRecordSchema.safeParse(record).success).toBe(true);
      if (detail === 'foreign_principals')
        expect(record).toMatchObject({ name: '1234', country: '7' });
      if (detail === 'short_forms')
        expect(record).toMatchObject({ first_name: '12', last_name: '34' });
      if (detail === 'documents') expect(record?.short_form_name).toBe('56');
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
  it('normalizes a principal arm termination date only where the arm carries one', async () => {
    const terminated = {
      REG_NUMBER: 7108,
      FP_NAME: 'Synthetic principal',
      FP_REG_DATE: '2022-04-15T00:00:00',
      TERMINATION_DATE: '2022-05-11T00:00:00',
      COUNTRY_NAME: 'SYNTHETICA',
    };
    const active = { REG_NUMBER: 7108, FP_NAME: 'Synthetic active principal' };
    const { service } = boundary((url) =>
      Response.json({
        ROWSET: { ROW: url.pathname.includes('/Terminated/') ? terminated : active },
      }),
    );
    const result = await settle(
      service.detail({ registration_number: '7108', status: 'all' }, signal()),
    );
    expect(result.records[1]).toMatchObject({
      status: 'terminated',
      registration_date: '2022-04-15',
      termination_date: '2022-05-11',
      termination_date_raw: '2022-05-11T00:00:00',
      raw: terminated,
    });
    expect(result.records[0]?.status).toBe('active');
    expect(result.records[0]).not.toHaveProperty('termination_date');
    expect(result.records[0]).not.toHaveProperty('termination_date_raw');
  });
  it('normalizes short-form SF_TERM_DATE and treats blank detail names as undisclosed', async () => {
    const rows = [
      {
        REG_NUMBER: 7108,
        SF_FIRST_NAME: 'Avery T',
        SF_LAST_NAME: 'Synthetica',
        SHORTFORM_DATE: '2022-04-15T00:00:00',
        SF_TERM_DATE: '2022-05-11T00:00:00',
      },
      { REG_NUMBER: 7108, SF_FIRST_NAME: 'Mononym', SF_LAST_NAME: '', SHORTFORM_DATE: '' },
      { REG_NUMBER: 7108, SF_FIRST_NAME: '', SF_LAST_NAME: '', SHORTFORM_DATE: '' },
    ];
    const { service } = boundary(() => Response.json({ ROWSET: { ROW: rows } }));
    const result = await settle(
      service.detail(
        { detail: 'short_forms', registration_number: '7108', status: 'terminated' },
        signal(),
      ),
    );
    expect(result.records[0]).toMatchObject({
      name: 'Avery T Synthetica',
      first_name: 'Avery T',
      last_name: 'Synthetica',
      registration_date: '2022-04-15',
      termination_date: '2022-05-11',
      termination_date_raw: '2022-05-11T00:00:00',
    });
    expect(result.records[1]).toMatchObject({ name: 'Mononym', first_name: 'Mononym' });
    expect(result.records[1]).not.toHaveProperty('last_name');
    expect(result.records[2]).toMatchObject({ name: '', raw: rows[2] });
    expect(result.records[2]).not.toHaveProperty('first_name');
    expect(result.records[2]).not.toHaveProperty('last_name');
    expect(result.records[2]).not.toHaveProperty('registration_date');
    expect(result.records.every((row) => FaraRecordSchema.safeParse(row).success)).toBe(true);
  });
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
  it('refuses snapshot redirects once without contacting the supplied target', async () => {
    const { service, calls } = boundary(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://outside.example/snapshot.zip' },
        }),
    );
    await expect(settle(service.search({}, signal()))).rejects.toMatchObject({
      data: { reason: 'source_schema_changed', retryable: false },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.href).toBe('https://efile.fara.gov/bulk/zip/FARA_All_Registrants.xml.zip');
  });
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
    let hold = true;
    const { service, calls } = boundary((_url, init) => {
      if (!hold) return snapshotResponse('registrants', registrant('1', 'Fresh'));
      exchange = init?.signal ?? undefined;
      return new Promise((_resolve, reject) =>
        exchange?.addEventListener('abort', () => reject(exchange?.reason), { once: true }),
      );
    });
    const controller = new AbortController();
    const pending = service.search({}, controller.signal).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException('Synthetic cancelled', 'AbortError'));
    // No fake time passes, so only the cancellation, never an exchange or call deadline, can abort it.
    await vi.advanceTimersByTimeAsync(0);
    expect(exchange?.aborted).toBe(true);
    expect(await settle(pending)).toBe(controller.signal.reason);
    expect(calls).toHaveLength(1);
    hold = false;
    expect((await settle(service.search({}, signal()))).records).toMatchObject([{ name: 'Fresh' }]);
    expect(calls).toHaveLength(2);
  });
  it('caches the short-form snapshot for 24 hours and single-flights concurrent searches', async () => {
    let revision = 1;
    const { service, calls } = boundary((url) =>
      archive(url) === 'short_forms'
        ? snapshotResponse('short_forms', shortForm('1', { first: `Revision${revision}` }))
        : snapshotResponse('registrants', registrant('1', 'Firm')),
    );
    const downloads = () => calls.filter((call) => archive(call.url) === 'short_forms').length;
    const search = () => service.search({ entity: 'short_forms', status: 'all' }, signal());
    const [first, concurrent] = await settle(Promise.all([search(), search()]));
    expect(concurrent).toEqual(first);
    expect(calls).toHaveLength(2);
    revision = 2;
    const retrievedAt = Date.parse(first.snapshot_retrieved_at ?? '');
    vi.setSystemTime(retrievedAt + 86_400_000 - 1);
    expect((await settle(search())).records[0]?.name).toBe('Revision1');
    expect(downloads()).toBe(1);
    vi.setSystemTime(retrievedAt + 86_400_000);
    expect((await settle(search())).records[0]?.name).toBe('Revision2');
    expect(downloads()).toBe(2);
  });
  it.each([
    [
      'an unavailable download',
      () => new Response('missing', { status: 404 }),
      'snapshot_unavailable',
    ],
    [
      'a malformed archive',
      () => xmlResponse('ShortForms', '<SHORTFORM_REGISTRANTS><ROW></SHORTFORM_REGISTRANTS>'),
      'source_schema_changed',
    ],
    [
      'a wrong root element',
      () => xmlResponse('ShortForms', `<REGISTRANTS>${registrant('1', 'Firm')}</REGISTRANTS>`),
      'source_schema_changed',
    ],
  ] as const)('never caches %s of the short-form snapshot', async (_label, failure, reason) => {
    let failing = true;
    const { service, calls } = boundary((url) =>
      archive(url) !== 'short_forms'
        ? snapshotResponse('registrants', registrant('1', 'Firm'))
        : failing
          ? failure()
          : snapshotResponse('short_forms', shortForm('1', { first: 'Recovered' })),
    );
    await expect(
      settle(service.search({ entity: 'short_forms', status: 'all' }, signal())),
    ).rejects.toMatchObject({ data: { reason } });
    failing = false;
    expect(
      (await settle(service.search({ entity: 'short_forms', status: 'all' }, signal()))).records,
    ).toMatchObject([{ name: 'Recovered' }]);
    expect(calls.map((call) => archive(call.url))).toEqual([
      'short_forms',
      'short_forms',
      'registrants',
    ]);
  });
  it('does not let a cancelled short-form download poison the next search', async () => {
    let hold = true;
    const { service, calls } = boundary((url, init) => {
      if (archive(url) !== 'short_forms')
        return snapshotResponse('registrants', registrant('1', 'Firm'));
      if (!hold) return snapshotResponse('short_forms', shortForm('1', { first: 'Fresh' }));
      const exchange = init?.signal;
      return new Promise((_resolve, reject) =>
        exchange?.addEventListener('abort', () => reject(exchange.reason), { once: true }),
      );
    });
    const controller = new AbortController();
    const pending = service
      .search({ entity: 'short_forms' }, controller.signal)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException('Synthetic cancelled', 'AbortError'));
    // Checked before any fake time passes, so a deadline cannot stand in for the cancellation.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
    expect(await settle(pending)).toBe(controller.signal.reason);
    hold = false;
    expect(
      (await settle(service.search({ entity: 'short_forms', status: 'all' }, signal()))).records,
    ).toMatchObject([{ name: 'Fresh' }]);
    expect(calls.map((call) => archive(call.url))).toEqual([
      'short_forms',
      'short_forms',
      'registrants',
    ]);
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

describe('name scan cost over a cached snapshot', () => {
  const ROWS = 2000;
  const BASE_CHARS = 5_000;
  /** Thread CPU per search, independent of how long a loaded machine deschedules the worker. */
  const CPU_BUDGET_MS = 100;
  const cpuMs = async (run: () => Promise<unknown>) => {
    const start = process.threadCpuUsage();
    await run();
    const used = process.threadCpuUsage(start);
    return (used.user + used.system) / 1000;
  };
  const least = async (runs: number, run: () => Promise<unknown>) => {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < runs; attempt++) best = Math.min(best, await cpuMs(run));
    return best;
  };
  const shapes = [
    [
      'a multi-token query',
      (n: number) => 'synthetica '.repeat(Math.ceil(n / 11)).slice(0, n),
      320_000,
    ],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`, 320_000],
    ['line breaks throughout', (n: number) => '  \r\n'.repeat(n / 4), 320_000],
    ['a long digit run', (n: number) => '1'.repeat(n), 320_000],
  ] as const;
  describe.each(['registrants', 'short_forms'] as const)('%s', (entity) => {
    it.each(shapes)(
      'grows linearly in name_contains length for %s',
      async (_label, make, maxChars) => {
        const ids = Array.from({ length: ROWS }, (_, index) => String(index + 1));
        const { service } = snapshots({
          registrants: ids.map((id) => registrant(id, `Synthetica firm ${id}`)).join(''),
          short_forms: ids
            .map((id) => shortForm(id, { first: `Person${id}`, last: 'Synthetica' }))
            .join(''),
        });
        await settle(service.search({ entity, status: 'all' }, signal()));
        const measure = (text: string) =>
          least(5, () => service.search({ entity, status: 'all', name_contains: text }, signal()));
        const small = make(BASE_CHARS);
        for (let size = BASE_CHARS * 2; size <= maxChars; size *= 2) {
          const large = make(size);
          let growth = Number.POSITIVE_INFINITY;
          let largest = Number.POSITIVE_INFINITY;
          for (let pair = 0; pair < 3; pair++) {
            const smallMs = await measure(small);
            const largeMs = await measure(large);
            growth = Math.min(growth, largeMs / Math.max(smallMs, 0.05));
            largest = Math.min(largest, largeMs);
          }
          expect(largest, `${size} characters`).toBeLessThan(CPU_BUDGET_MS);
          expect(growth, `${size} characters`).toBeLessThan(4 * (size / BASE_CHARS));
        }
      },
      120_000,
    );
  });
});
