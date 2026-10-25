/** @fileoverview Server configuration through the real environment loader. @module tests/config/server-config */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('USLOBBYING_LDA_API_KEY', undefined);
  vi.stubEnv('USLOBBYING_DATAFRAME_DROP_ENABLED', undefined);
});
afterEach(() => vi.unstubAllEnvs());

async function load() {
  return (await import('../../src/config/server-config.js')).getServerConfig();
}

describe('server environment configuration', () => {
  it('defaults to anonymous access and disabled drop', async () => {
    expect(await load()).toEqual({ dataframeDropEnabled: false });
  });
  it.each([
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
    ['YES', true],
    ['off', false],
  ] as const)('parses explicit %s as %s', async (value, expected) => {
    vi.stubEnv('USLOBBYING_DATAFRAME_DROP_ENABLED', value);
    expect((await load()).dataframeDropEnabled).toBe(expected);
  });
  it.each(['', `\${USLOBBYING_DATAFRAME_DROP_ENABLED}`])(
    'treats blank or unsubstituted flag %j as unset',
    async (value) => {
      vi.stubEnv('USLOBBYING_DATAFRAME_DROP_ENABLED', value);
      expect((await load()).dataframeDropEnabled).toBe(false);
    },
  );
  it.each(['', `\${USLOBBYING_LDA_API_KEY}`])(
    'treats blank or unsubstituted key %j as absent',
    async (value) => {
      vi.stubEnv('USLOBBYING_LDA_API_KEY', value);
      expect((await load()).ldaApiKey).toBeUndefined();
    },
  );
  it('trims a configured key but preserves a placeholder embedded in a meaningful value', async () => {
    vi.stubEnv('USLOBBYING_LDA_API_KEY', `  synthetic-\${TOKEN}-suffix  `);
    expect((await load()).ldaApiKey).toBe(`synthetic-\${TOKEN}-suffix`);
  });
  it('names the environment variable when a flag is invalid', async () => {
    vi.stubEnv('USLOBBYING_DATAFRAME_DROP_ENABLED', 'maybe');
    await expect(load()).rejects.toThrow('USLOBBYING_DATAFRAME_DROP_ENABLED');
  });
  it('parses lazily and keeps the validated startup configuration', async () => {
    const { getServerConfig } = await import('../../src/config/server-config.js');
    vi.stubEnv('USLOBBYING_DATAFRAME_DROP_ENABLED', 'true');
    expect(getServerConfig().dataframeDropEnabled).toBe(true);
    vi.stubEnv('USLOBBYING_DATAFRAME_DROP_ENABLED', 'false');
    expect(getServerConfig().dataframeDropEnabled).toBe(true);
  });
});
