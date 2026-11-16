/** @fileoverview Location and reference codes are checked against LDA constants before any filing request. @module tests/tools/lda/filter-codes */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getContributions } from '../../../src/mcp-server/tools/definitions/lda/get-contributions.tool.js';
import { getIssueSpending } from '../../../src/mcp-server/tools/definitions/lda/get-issue-spending.tool.js';
import { searchFilings } from '../../../src/mcp-server/tools/definitions/lda/search-filings.tool.js';
import { getLdaService, initLdaService } from '../../../src/services/lda/lda-service.js';
import { invoke, page, resetTenant, uuid } from './harness.js';

/** A subset of the LDA `general/states` and `general/countries` constants, in their published shape. */
const constants: Record<string, { value: string; name: string }[]> = {
  states: [
    { value: 'WA', name: 'Washington' },
    { value: 'CA', name: 'California' },
  ],
  countries: [
    { value: '00', name: '* Undetermined' },
    { value: 'CN', name: 'China' },
    { value: 'US', name: 'United States of America' },
    { value: 'XK', name: 'Kosovo' },
  ],
  lobbyingactivityissues: [{ value: 'TEC', name: 'Telecommunications' }],
  filingtypes: [{ value: 'Q1', name: '1st Quarter - Report' }],
  itemtypes: [{ value: 'feca', name: 'FECA' }],
};
let calls: URL[];
let constantsBody: (topic: string) => Response;
let sourceBody: () => Response;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01'));
  resetTenant();
  calls = [];
  constantsBody = (topic) => Response.json(constants[topic]);
  sourceBody = () => Response.json(page([]));
  // A fresh service per test: its constants cache starts empty.
  initLdaService({
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      const topic = url.pathname.match(/\/constants\/\w+\/(\w+)\/$/)?.[1];
      return topic ? constantsBody(topic) : sourceBody();
    },
  });
});
afterEach(() => {
  getLdaService().dispose();
  vi.useRealTimers();
});
const constantsCalls = (topic?: string) =>
  calls.filter((url) => url.pathname.includes(topic ? `/${topic}/` : '/constants/'));
const filingCalls = () => calls.filter((url) => url.pathname === '/api/v1/filings/');

describe('LDA filter codes', () => {
  it.each([
    { field: 'client_country', value: 'usa', topic: 'countries' },
    { field: 'client_state', value: 'Washington', topic: 'states' },
    { field: 'foreign_entity_country', value: 'CHN', topic: 'countries' },
  ])(
    'fails $field $value locally, naming the field and topic $topic',
    async ({ field, value, topic }) => {
      const output = await invoke(searchFilings, { filing_year: 2025, [field]: value });
      expect(output.result.isError).toBe(true);
      expect(output.data).toMatchObject({
        error: {
          message: `Unknown ${field} value; call uslobbying_list_reference with topic ${topic}.`,
          data: { reason: 'invalid_filter' },
        },
      });
      expect(output.text).toContain(`Unknown ${field} value`);
      // The recovery hint is the caller's next move, so it names the topic that holds the codes.
      expect(output.data).toMatchObject({
        error: {
          data: {
            recovery: {
              hint: `Call uslobbying_list_reference with topic ${topic} and retry ${field} with the value of an entry whose source is lda.`,
            },
          },
        },
      });
      expect(filingCalls()).toEqual([]);
    },
  );
  it('accepts LDA codes in either case and sends them uppercased', async () => {
    for (const [input, expected] of [
      [
        { client_state: 'wa', client_country: 'us', foreign_entity_country: 'xk' },
        { client_state: 'WA', client_country: 'US', foreign_entity_country: 'XK' },
      ],
      [
        { client_state: 'WA', client_country: 'US', foreign_entity_country: '00' },
        { client_state: 'WA', client_country: 'US', foreign_entity_country: '00' },
      ],
    ] as const) {
      calls.length = 0;
      const output = await invoke(searchFilings, { filing_year: 2025, ...input });
      expect(output.result.isError, output.text).not.toBe(true);
      expect(output.data.effective_filters).toMatchObject(expected);
      expect(Object.fromEntries(filingCalls()[0]!.searchParams)).toMatchObject(expected);
    }
  });
  it('fetches countries once for both country fields and no constants on a second call', async () => {
    const input = { filing_year: 2025, client_country: 'US', foreign_entity_country: 'CN' };
    expect((await invoke(searchFilings, input)).result.isError).not.toBe(true);
    expect(constantsCalls('countries')).toHaveLength(1);
    expect(constantsCalls()).toHaveLength(1);
    calls.length = 0;
    expect((await invoke(searchFilings, { ...input, client_state: 'CA' })).result.isError).not.toBe(
      true,
    );
    expect(constantsCalls().map((url) => url.pathname)).toEqual([
      '/api/v1/constants/general/states/',
    ]);
  });
  it('fails with the upstream error when constants are unreadable, and refetches on the next call', async () => {
    constantsBody = () => Response.json({ unexpected: true });
    const failed = await invoke(searchFilings, { filing_year: 2025, client_country: 'US' });
    expect(failed.result.isError).toBe(true);
    expect(failed.data).toMatchObject({ error: { data: { reason: 'source_schema_changed' } } });
    expect(filingCalls()).toEqual([]);
    constantsBody = (topic) => Response.json(constants[topic]);
    const retried = await invoke(searchFilings, { filing_year: 2025, client_country: 'US' });
    expect(retried.result.isError, retried.text).not.toBe(true);
    expect(constantsCalls('countries')).toHaveLength(2);
  });
  it.each([
    {
      tool: searchFilings,
      input: { filing_year: 2025, filing_type: 'ZZ' },
      message: 'Unknown filing_type value; call uslobbying_list_reference with topic filing_types.',
    },
    {
      tool: searchFilings,
      input: { filing_year: 2025, issue_code: 'ZZZ' },
      message: 'Unknown issue_code value; call uslobbying_list_reference with topic issue_codes.',
    },
    {
      tool: getContributions,
      input: { filing_year: 2025, contribution_type: 'zz' },
      message:
        'Unknown contribution_type value; call uslobbying_list_reference with topic contribution_types.',
    },
    {
      tool: getIssueSpending,
      input: { issue_code: 'ZZZ', years: [2025] },
      message: 'Unknown issue_code value; call uslobbying_list_reference with topic issue_codes.',
    },
  ])(
    'names the input field for every reference code check: $message',
    async ({ tool, input, message }) => {
      const output = await invoke(tool, input);
      expect(output.data).toMatchObject({
        error: { message, data: { reason: 'invalid_filter' } },
      });
      expect(filingCalls()).toEqual([]);
    },
  );
  it.each([
    { status: 404, code: JsonRpcErrorCode.NotFound, attempts: 1 },
    { status: 429, code: JsonRpcErrorCode.RateLimited, attempts: 2 },
    { status: 503, code: JsonRpcErrorCode.ServiceUnavailable, attempts: 2 },
  ])(
    'fails a location-filtered search with constants HTTP $status as that upstream error, before any filing request',
    async ({ status, code, attempts }) => {
      constantsBody = () => new Response('unavailable', { status });
      const failed = await invoke(searchFilings, { filing_year: 2025, client_state: 'WA' });
      expect(failed.result.isError).toBe(true);
      expect(failed.data).toMatchObject({ error: { code, data: { status } } });
      expect(failed.data).not.toMatchObject({ error: { data: { reason: 'invalid_filter' } } });
      expect(constantsCalls('states')).toHaveLength(attempts);
      expect(filingCalls()).toEqual([]);
    },
  );
  it.each([
    {
      tool: searchFilings,
      input: { filing_year: 2025, client_country: 'US', client_state: 'WA', filing_type: 'Q1' },
    },
    { tool: getContributions, input: { filing_year: 2025, contribution_type: 'feca' } },
  ])(
    'checks codes on the first call only, so a continuation never needs the constants (%#)',
    async ({ tool, input }) => {
      sourceBody = () =>
        Response.json(
          page(
            Array.from({ length: 12 }, (_, index) => ({
              filing_uuid: uuid(index + 1),
              filing_type: 'Q1',
              filing_year: 2025,
              filing_period: 'first_quarter',
              dt_posted: '2025-04-01T00:00:00Z',
              client: { id: '2', name: 'Synthetic client' },
              registrant: { id: '1', name: 'Synthetic firm' },
              income: null,
              expenses: null,
              lobbying_activities: [],
              contribution_items: [{ contribution_type: 'feca', amount: '1.00' }],
            })),
          ),
        );
      // Another call fills the 24-hour constants cache well before this scan starts.
      expect((await invoke(tool, input)).result.isError).not.toBe(true);
      vi.setSystemTime(new Date('2026-01-01T20:00:00Z'));
      const first = await invoke(tool, input);
      expect(first.result.isError, first.text).not.toBe(true);
      expect(first.data.records_returned).toBe(10);
      // The scan lives 24 hours from its start; the cache entry expired at 24 hours from its fetch.
      vi.setSystemTime(new Date('2026-01-02T01:00:00Z'));
      calls.length = 0;
      constantsBody = () => new Response('unavailable', { status: 503 });
      const next = await invoke(tool, { cursor: first.data.next_cursor });
      expect(next.result.isError, next.text).not.toBe(true);
      expect(next.data).toMatchObject({ records_returned: 2, offset: 10, output_complete: true });
      expect(constantsCalls()).toEqual([]);
    },
  );
});
