/** @fileoverview LDA delivery plumbing: count clamping through scope(), upstream page size and envelopes. @module tests/tools/lda/shared */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '../../../src/domain/json.js';
import type { DeliveryWindow } from '../../../src/services/acquisition/types.js';

const TOOL = 'uslobbying_search_lobbyists';
const CLAMP_LOG = 'Clamped a count control to its served ceiling.';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('USLOBBYING_CLAMP_LIMITS', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function load() {
  const shared = await import('../../../src/mcp-server/tools/definitions/lda/shared.js');
  const { CEILINGS } = await import('../../../src/domain/delivery-limits.js');
  const { acquire } = await import('../../../src/services/acquisition/acquisition-service.js');
  return { ...shared, CEILINGS, acquire };
}
/** Publish a scan whose stored filters are `filters`, returning its continuation cursor. */
async function stored(
  ctx: ReturnType<typeof createMockContext>,
  filters: Record<string, JsonValue>,
): Promise<string> {
  const { acquire } = await load();
  const result = await acquire(ctx, {
    tool: TOOL,
    scanKind: 'search',
    filters,
    pageSize: 25,
    provenance: {},
    buildResponse: (window) => window,
    source: {
      identify: (row) => String(row),
      fetchPage: async (position) =>
        position === null ? { records: ['1'], next: 2 } : { records: ['2'], next: null },
    },
  });
  return result.checkpoint.cursor;
}
function window(overrides: Partial<DeliveryWindow>): DeliveryWindow {
  return {
    coverage: {
      complete: true,
      pages_fetched: 1,
      records_fetched: 0,
      unique_records: 0,
      started_at: '2026-01-01T00:00:00Z',
    },
    cursor_expires_at: '2026-01-02T00:00:00Z',
    offset: 0,
    output_complete: true,
    records: [],
    records_returned: 0,
    truncated: false,
    ...overrides,
  };
}

describe('scope count clamping', () => {
  it('clamps an over-cap page size into the scope, discloses it and records the clamp once on a first call', async () => {
    const { scope, CEILINGS } = await load();
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    const resolved = await scope(
      { name: 'smith', page_size: 26, max_pages: 9 },
      ctx,
      TOOL,
      CEILINGS.source,
    );
    expect(resolved).toEqual({
      filters: { name: 'smith', page_size: 25 },
      delivery_limits: {
        page_size: { requested: 26, effective: 25 },
        max_pages: { requested: 9, effective: 5 },
      },
      max_pages: 5,
      page_size: 25,
    });
    expect(
      info.mock.calls.map(([message, data]) => [message, (data as { control: string }).control]),
    ).toEqual([
      [CLAMP_LOG, 'page_size'],
      [CLAMP_LOG, 'max_pages'],
    ]);
  });
  it('keeps values at the ceiling and omitted controls unclamped', async () => {
    const { scope, CEILINGS } = await load();
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    expect(
      await scope({ name: 'smith', page_size: 25, max_pages: 5 }, ctx, TOOL, CEILINGS.source),
    ).toEqual({
      filters: { name: 'smith', page_size: 25 },
      delivery_limits: {},
      max_pages: 5,
      page_size: 25,
    });
    expect(await scope({ name: 'smith', cursor: undefined }, ctx, TOOL, CEILINGS.source)).toEqual({
      filters: { name: 'smith' },
      delivery_limits: {},
      max_pages: undefined,
      page_size: undefined,
    });
    expect(info).not.toHaveBeenCalled();
  });
  it('discloses but does not record a clamp on a continuation, and resolves the stored scope', async () => {
    const { scope, CEILINGS } = await load();
    const ctx = createMockContext();
    const cursor = await stored(ctx, { name: 'smith', page_size: 25 });
    const info = vi.spyOn(ctx.log, 'info');
    const continued = await scope({ cursor, page_size: 26 }, ctx, TOOL, CEILINGS.source);
    expect(continued).toMatchObject({
      filters: { name: 'smith', page_size: 25 },
      delivery_limits: { page_size: { requested: 26, effective: 25 } },
      page_size: 25,
    });
    expect(await scope({ cursor }, ctx, TOOL, CEILINGS.source)).toMatchObject({
      filters: { name: 'smith', page_size: 25 },
      delivery_limits: {},
    });
    expect(info).not.toHaveBeenCalled();
  });
  it('rejects a continuation whose page size changes the stored scope', async () => {
    const { scope, CEILINGS } = await load();
    const ctx = createMockContext();
    const cursor = await stored(ctx, { name: 'smith', page_size: 25 });
    await expect(
      scope({ cursor, page_size: 20 }, ctx, TOOL, CEILINGS.source),
    ).rejects.toMatchObject({
      data: { reason: 'cursor_invalid' },
    });
    const unsized = await stored(ctx, { name: 'smith' });
    await expect(
      scope({ cursor: unsized, page_size: 10 }, ctx, TOOL, CEILINGS.source),
    ).rejects.toMatchObject({ data: { reason: 'cursor_invalid' } });
  });
  it('picks a mode-dependent ceiling from the supplied scope, or the stored scope on a continuation', async () => {
    const { scope, CEILINGS } = await load();
    const ctx = createMockContext();
    const ceilings = vi.fn((filters: Record<string, JsonValue>) =>
      filters.mode === 'activity' ? CEILINGS.evidence : CEILINGS.identities,
    );
    expect(await scope({ mode: 'activity', page_size: 1000 }, ctx, TOOL, ceilings)).toMatchObject({
      page_size: 1000,
      delivery_limits: {},
    });
    expect(await scope({ mode: 'search', page_size: 1000 }, ctx, TOOL, ceilings)).toMatchObject({
      page_size: 25,
      delivery_limits: { page_size: { requested: 1000, effective: 25 } },
    });
    const cursor = await stored(ctx, { mode: 'activity', page_size: 1000 });
    expect(await scope({ cursor, page_size: 1001 }, ctx, TOOL, ceilings)).toMatchObject({
      filters: { mode: 'activity', page_size: 1000 },
      delivery_limits: { page_size: { requested: 1001, effective: 1000 } },
    });
    expect(ceilings).toHaveBeenLastCalledWith({ mode: 'activity', page_size: 1000 });
  });
  it('rejects an over-cap value naming the cap when USLOBBYING_CLAMP_LIMITS=false, without recording a clamp', async () => {
    vi.stubEnv('USLOBBYING_CLAMP_LIMITS', 'false');
    const { scope, CEILINGS } = await load();
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    await expect(
      scope({ name: 'smith', page_size: 26 }, ctx, TOOL, CEILINGS.source),
    ).rejects.toMatchObject({
      message: 'page_size cannot exceed 25.',
      data: { reason: 'invalid_filter', field: 'page_size', maximum: 25 },
    });
    await expect(
      scope({ name: 'smith', max_pages: 6 }, ctx, TOOL, CEILINGS.source),
    ).rejects.toMatchObject({ data: { reason: 'invalid_filter', field: 'max_pages', maximum: 5 } });
    expect(info).not.toHaveBeenCalled();
    expect(await scope({ name: 'smith', page_size: 25 }, ctx, TOOL, CEILINGS.source)).toMatchObject(
      {
        page_size: 25,
        delivery_limits: {},
      },
    );
  });
});

describe('LDA delivery plumbing', () => {
  it('always requests LDA pages of 25, whatever the delivery page size', async () => {
    const { nativeFilters } = await load();
    for (const page_size of [1, 10, 250, 1000])
      expect(nativeFilters({ page_size, client_id: '7' }, ['client_id'])).toEqual({
        page_size: 25,
        client_id: '7',
      });
    expect(nativeFilters({}, [])).toEqual({ page_size: 25 });
  });
  it('carries this call’s delivery limits over the stored provenance', async () => {
    const { envelope, provenance } = await load();
    const limits = { page_size: { requested: 26, effective: 25 } };
    expect(provenance({ name: 'smith' }, limits).delivery_limits).toEqual(limits);
    expect(provenance({ name: 'smith' }).delivery_limits).toEqual({});
    const stored = { ...provenance({ name: 'smith' }, limits), retrieved_at: 'first-call' };
    const result = envelope(window({ records: [1], records_returned: 1 }), {}, 'none', stored);
    expect(result).toMatchObject({
      retrieved_at: 'first-call',
      delivery_limits: {},
      records_returned: 1,
    });
    expect(result).not.toHaveProperty('records');
    expect(envelope(window({}), {}, 'none', stored, limits).delivery_limits).toEqual(limits);
  });
  it('adds the empty-scope notice only to a complete empty first window', async () => {
    const { envelope } = await load();
    const live = 'Live API pagination is not an immutable historical snapshot.';
    expect(envelope(window({}), {}, 'Nothing matched.').notices).toEqual([
      live,
      'Nothing matched.',
    ]);
    expect(
      envelope(window({ records: [1], records_returned: 1 }), {}, 'Nothing matched.').notices,
    ).toEqual([live]);
    expect(envelope(window({ offset: 25 }), {}, 'Nothing matched.').notices).toEqual([live]);
    const collecting = window({});
    collecting.coverage.complete = false;
    expect(envelope(collecting, {}, 'Nothing matched.').notices).toEqual([
      live,
      'Acquisition is incomplete; follow next_cursor before interpreting scope.',
    ]);
  });
});

describe('include projection', () => {
  const participant = { lobbyist: { id: '7' }, covered_position: 'Aide' };
  const activity = {
    general_issue_code: 'TEC',
    description: 'Spectrum',
    lobbyists: [participant],
    government_entities: [{ id: '8', name: 'Senate' }],
    future: { description: 'nested key with the same name is kept' },
  };
  it('removes only the activity fields a selection leaves out, at any nesting of the record', async () => {
    const { projectActivity, projectFiling } = await load();
    const filing = {
      filing_uuid: 'u',
      description: 'filing-level field with the same name is kept',
      lobbying_activities: [activity, { general_issue_code: 'HCR' }, null, 'unexpected'],
    };
    expect(projectFiling(filing, [])).toEqual({
      ...filing,
      lobbying_activities: [
        {
          general_issue_code: 'TEC',
          government_entities: activity.government_entities,
          future: activity.future,
        },
        { general_issue_code: 'HCR' },
        null,
        'unexpected',
      ],
    });
    expect(projectActivity(activity, ['activity_descriptions'])).toEqual({
      general_issue_code: 'TEC',
      description: 'Spectrum',
      government_entities: activity.government_entities,
      future: activity.future,
    });
    expect(projectActivity(activity, ['activity_lobbyists'])).toEqual({
      general_issue_code: 'TEC',
      lobbyists: [participant],
      government_entities: activity.government_entities,
      future: activity.future,
    });
    expect(projectActivity(activity, ['activity_descriptions', 'activity_lobbyists'])).toEqual(
      activity,
    );
    for (const sparse of [{ filing_uuid: 'u' }, { lobbying_activities: null }, null, [activity]])
      expect(projectFiling(sparse, [])).toEqual(sparse);
    expect(filing.lobbying_activities[0]).toBe(activity);
    expect(activity).toHaveProperty('description', 'Spectrum');
  });
  it('names what an include scope leaves out, and nothing for a scope without include', async () => {
    const { envelope } = await load();
    const live = 'Live API pagination is not an immutable historical snapshot.';
    const page = window({ records: [1], records_returned: 1 });
    expect(envelope(page, {}, 'none').notices).toEqual([live]);
    expect(envelope(page, { include: [] }, 'none').notices).toEqual([
      live,
      'Lobbying activities omit description and lobbyists; a new call without cursor that adds activity_descriptions and activity_lobbyists to include returns those fields.',
    ]);
    expect(envelope(page, { include: ['activity_lobbyists'] }, 'none').notices).toEqual([
      live,
      'Lobbying activities omit description; a new call without cursor that adds activity_descriptions to include returns those fields.',
    ]);
    expect(
      envelope(page, { include: ['activity_descriptions', 'activity_lobbyists'] }, 'none').notices,
    ).toEqual([live]);
  });
});
