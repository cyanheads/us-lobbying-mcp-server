/** @fileoverview Count ceilings, clamp disclosure, and the clamp off switch. @module tests/domain/delivery-limits */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('USLOBBYING_CLAMP_LIMITS', undefined);
});
afterEach(() => vi.unstubAllEnvs());

async function load() {
  return await import('../../src/domain/delivery-limits.js');
}

describe('delivery ceilings', () => {
  it('serves the ruled ceiling for every delivery unit', async () => {
    const { CEILINGS } = await load();
    expect(CEILINGS).toEqual({
      source: { page_size: 25, max_pages: 5 },
      identities: { page_size: 25, max_pages: 5 },
      evidence: { page_size: 1000, max_pages: 5 },
      analytical: { page_size: 250, max_pages: 5 },
      fara: { page_size: 1000 },
      sql: { row_limit: 100 },
    });
  });
  it.each([
    ['source', 'page_size', 26, 25],
    ['analytical', 'page_size', 251, 250],
    ['evidence', 'page_size', 1001, 1000],
    ['fara', 'page_size', 1001, 1000],
    ['sql', 'row_limit', 101, 100],
    ['analytical', 'max_pages', 6, 5],
  ] as const)('clamps %s %s %d to %d and discloses it', async (unit, key, requested, effective) => {
    const { CEILINGS, deliveryDisclosure, normalizeDelivery } = await load();
    const input = { [key]: requested, other: 'kept' };
    expect(normalizeDelivery(input, CEILINGS[unit])).toEqual({ [key]: effective, other: 'kept' });
    expect(deliveryDisclosure(input, CEILINGS[unit])).toEqual({
      delivery_limits: { [key]: { requested, effective } },
    });
  });
  it('leaves values at or under the ceiling, absent controls and other units untouched', async () => {
    const { CEILINGS, deliveryDisclosure, normalizeDelivery } = await load();
    const input = { page_size: 250, max_pages: 5 };
    expect(normalizeDelivery(input, CEILINGS.analytical)).toEqual(input);
    expect(deliveryDisclosure(input, CEILINGS.analytical)).toEqual({ delivery_limits: {} });
    expect(normalizeDelivery({ row_limit: 500 }, CEILINGS.source)).toEqual({ row_limit: 500 });
    expect(normalizeDelivery({}, CEILINGS.fara)).toEqual({});
  });
  it('rejects an over-cap value naming the cap when USLOBBYING_CLAMP_LIMITS=false', async () => {
    vi.stubEnv('USLOBBYING_CLAMP_LIMITS', 'false');
    const { CEILINGS, normalizeDelivery } = await load();
    let error: unknown;
    try {
      normalizeDelivery({ page_size: 26 }, CEILINGS.source);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      message: 'page_size cannot exceed 25.',
      data: {
        reason: 'invalid_filter',
        field: 'page_size',
        maximum: 25,
        recovery: { hint: 'Lower page_size to 25 or less.' },
      },
    });
    expect(normalizeDelivery({ page_size: 25 }, CEILINGS.source)).toEqual({ page_size: 25 });
  });
  it('logs each clamp once and records nothing for an empty disclosure', async () => {
    const { recordClamps } = await load();
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    recordClamps(ctx, 'uslobbying_search_filings', {
      page_size: { requested: 40, effective: 25 },
      max_pages: { requested: 9, effective: 5 },
    });
    expect(info.mock.calls).toEqual([
      [
        'Clamped a count control to its served ceiling.',
        { tool: 'uslobbying_search_filings', control: 'page_size', requested: 40, effective: 25 },
      ],
      [
        'Clamped a count control to its served ceiling.',
        { tool: 'uslobbying_search_filings', control: 'max_pages', requested: 9, effective: 5 },
      ],
    ]);
    info.mockClear();
    recordClamps(ctx, 'uslobbying_search_filings', {});
    expect(info).not.toHaveBeenCalled();
  });
  it('counts each clamp on uslobbying.delivery.clamped by tool and control', async () => {
    const add = vi.fn();
    const createCounter = vi.fn(() => ({ add }));
    vi.doMock('@cyanheads/mcp-ts-core/utils', async (original) => ({
      ...(await original<typeof import('@cyanheads/mcp-ts-core/utils')>()),
      createCounter,
    }));
    try {
      const { recordClamps } = await load();
      const ctx = createMockContext();
      recordClamps(ctx, 'uslobbying_search_filings', {
        page_size: { requested: 40, effective: 25 },
        max_pages: { requested: 9, effective: 5 },
      });
      expect(createCounter).toHaveBeenCalledWith(
        'uslobbying.delivery.clamped',
        expect.any(String),
        '{controls}',
      );
      expect(add.mock.calls).toEqual([
        [1, { tool: 'uslobbying_search_filings', control: 'page_size' }],
        [1, { tool: 'uslobbying_search_filings', control: 'max_pages' }],
      ]);
      add.mockClear();
      recordClamps(ctx, 'uslobbying_search_filings', {});
      expect(add).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@cyanheads/mcp-ts-core/utils');
    }
  });
});
