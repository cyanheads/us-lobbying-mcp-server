/** @fileoverview Exact retained-parent retrieval through own-property JSON Pointer windows. @module services/acquisition/record-window */
import { createHash } from 'node:crypto';
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { FULL_RESULT_TARGET_BYTES, type RecordWindowSchema } from '@/domain/contracts.js';
import { fullResultBytes } from '@/domain/format.js';
import { type JsonValue, JsonValueSchema } from '@/domain/json.js';
import { invalidCursor, readJson, writeJson } from './storage.js';
import { StoredRecordSchema } from './types.js';

const selectors = z.object({
  tool: z.string().min(1),
  record_handle: z.string(),
  record_path: z.string().default(''),
  record_offset: z.number().int().nonnegative().default(0),
  record_limit: z.number().int().min(1).max(25).default(25),
});
/** Window response includes the stored parent's complete provenance. */
export interface RecordRetrievalOptions {
  buildResponse?: (
    window: z.infer<typeof RecordWindowSchema>,
    provenance: Record<string, JsonValue>,
  ) => object;
  record_handle: string;
  record_limit?: number;
  record_offset?: number;
  record_path?: string;
  tool: string;
}
function badPath() {
  return validationError('The record pointer or offset does not select a stored value.', {
    reason: 'invalid_filter',
  });
}
/** Metadata itself cannot be truncated to manufacture an empty successful result. */
export function assertFits(response: object): void {
  if (fullResultBytes(response) > FULL_RESULT_TARGET_BYTES)
    throw validationError(
      'The complete result metadata cannot fit the delivery window; narrow the request.',
      { reason: 'result_too_large' },
    );
}
/** Store an exact parent before publishing its handle; deterministic retry keys never mutate committed parents. */
export async function deferRecord(
  ctx: Context,
  options: {
    scanId: string;
    tool: string;
    identity: string;
    value: JsonValue;
    expires: number;
    provenance: Record<string, JsonValue>;
  },
) {
  const digest = createHash('sha256')
    .update(JSON.stringify([options.tool, options.identity, options.value]))
    .digest('hex');
  const handle = `${options.scanId}.${digest}`;
  await writeJson(
    ctx,
    `acquisition/record/${options.scanId}/${digest}`,
    {
      tool: options.tool,
      expires: options.expires,
      value: options.value,
      provenance: options.provenance,
    },
    options.expires,
  );
  return {
    record_handle: handle,
    source_id: options.identity,
    record_bytes: new TextEncoder().encode(JSON.stringify(options.value)).byteLength,
    expires_at: new Date(options.expires).toISOString(),
    retrieval_tool: options.tool,
  };
}
function childPath(parent: string, key: string): string {
  return `${parent}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}
function select(root: JsonValue, pointer: string): JsonValue {
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) throw badPath();
  let value = root;
  for (const token of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(token)) throw badPath();
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw badPath();
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key)) throw badPath();
      const item = value[Number(key)];
      if (item === undefined) throw badPath();
      value = item;
    } else {
      const item = value[key];
      if (item === undefined) throw badPath();
      value = item;
    }
  }
  return value;
}
/** No upstream request is made; unknown keys and Unicode code points remain reconstructable. */
export async function readRecordWindow(
  ctx: Context,
  options: RecordRetrievalOptions,
): Promise<object> {
  const input = selectors.parse(options);
  const match = /^([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(input.record_handle);
  if (!match) throw invalidCursor();
  const stored = StoredRecordSchema.safeParse(
    await readJson(ctx, `acquisition/record/${match[1]}/${match[2]}`),
  );
  if (!stored.success || stored.data.tool !== input.tool || stored.data.expires <= Date.now())
    throw invalidCursor();
  const value = select(stored.data.value, input.record_path);
  const envelope = (window: z.infer<typeof RecordWindowSchema>) =>
    options.buildResponse
      ? options.buildResponse(window, stored.data.provenance)
      : { ...stored.data.provenance, record_window: window, truncated: !window.complete };
  const base = {
    record_handle: input.record_handle,
    path: input.record_path,
    offset: input.record_offset,
  };
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    if (input.record_offset !== 0) throw badPath();
    const response = envelope({
      ...base,
      kind: 'scalar',
      total: 1,
      returned: 1,
      complete: true,
      value,
    });
    assertFits(response);
    return response;
  }
  if (typeof value === 'string') {
    const points = Array.from(value);
    if (input.record_offset > points.length) throw badPath();
    let count = Math.min(input.record_limit, points.length - input.record_offset);
    while (count >= 0) {
      const next = input.record_offset + count;
      const response = envelope({
        ...base,
        kind: 'string',
        total: points.length,
        returned: count,
        complete: next === points.length,
        text: points.slice(input.record_offset, next).join(''),
        ...(next < points.length ? { next_offset: next } : {}),
      });
      if (fullResultBytes(response) <= FULL_RESULT_TARGET_BYTES) {
        if (count === 0 && next < points.length)
          throw validationError('Record-window metadata leaves no room for a Unicode code point.', {
            reason: 'result_too_large',
          });
        return response;
      }
      count--;
    }
    throw validationError('Record-window metadata cannot fit.', { reason: 'result_too_large' });
  }
  const array = Array.isArray(value);
  const keys = array ? value.map((_, index) => String(index)) : Object.keys(value).sort();
  if (input.record_offset > keys.length) throw badPath();
  const entries: { key: string; path: string; value?: JsonValue }[] = [];
  let omitted = false;
  const window = (): z.infer<typeof RecordWindowSchema> => {
    const next = input.record_offset + entries.length;
    const shared = {
      ...base,
      total: keys.length,
      returned: entries.length,
      complete: next === keys.length && !omitted,
      ...(next < keys.length ? { next_offset: next } : {}),
    };
    return array
      ? {
          ...shared,
          kind: 'array',
          items: entries.map(({ key, ...entry }) => ({ index: Number(key), ...entry })),
        }
      : { ...shared, kind: 'object', entries };
  };
  assertFits(envelope(window()));
  for (const key of keys.slice(input.record_offset, input.record_offset + input.record_limit)) {
    const child = array ? value[Number(key)] : value[key];
    if (child === undefined) throw badPath();
    const entry = { key, path: childPath(input.record_path, key), value: child };
    entries.push(entry);
    if (fullResultBytes(envelope(window())) > FULL_RESULT_TARGET_BYTES) {
      entries.pop();
      if (entries.length > 0) break;
      entries.push({ key, path: childPath(input.record_path, key) });
      omitted = true;
      assertFits(envelope(window()));
    }
  }
  const response = envelope(window());
  JsonValueSchema.parse(response);
  return response;
}
