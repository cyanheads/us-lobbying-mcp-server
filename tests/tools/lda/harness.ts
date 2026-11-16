/** @fileoverview Shared runner and synthetic LDA payload helpers for the LDA tool contract tests. @module tests/tools/lda/harness */
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, vi } from 'vitest';

export type Definition = Parameters<typeof runToolContract>[0];
/** The contract runner creates a request context per call; this tenant store persists across requests. */
export const tenant = { state: createMockContext().state };
/** Start a test with an empty tenant store. */
export function resetTenant(): void {
  tenant.state = createMockContext().state;
}
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const page = (results: unknown[], next: string | null = null) => ({
  count: results.length,
  results,
  next,
});
/** Run through argument, output and format contracts; a success carries one JSON twin of structuredContent. */
export async function invoke(definition: Definition, input: Record<string, unknown>) {
  const bound = {
    ...definition,
    handler: (args: never, ctx: Parameters<typeof definition.handler>[1]) =>
      definition.handler(args, { ...ctx, state: tenant.state }),
  };
  const pending = runToolContract(bound, input);
  await vi.runAllTimersAsync();
  const result = await pending;
  const data = z.record(z.string(), z.unknown()).parse(result.structuredContent);
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  if (!result.isError) {
    // format() carries the same JSON as structuredContent, and the output schema keeps every field.
    const fence = text.slice(0, text.indexOf('json\n'));
    expect(
      JSON.parse(text.slice(fence.length + 5, text.indexOf(`\n${fence}`, fence.length + 5))),
    ).toEqual(data);
    expect(definition.output?.parse(data)).toEqual(data);
  }
  return { result, data, text };
}
export function success(value: Awaited<ReturnType<typeof invoke>>) {
  expect(value.result.isError, value.text).not.toBe(true);
  return value.data;
}
