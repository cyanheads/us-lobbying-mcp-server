/** @fileoverview Bounded acquisition admission and foreground tenant storage. @module services/acquisition/storage */
import type { Context } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { ACQUISITION_MEMORY_LIMIT_BYTES } from '@/domain/contracts.js';
import { type JsonValue, JsonValueSchema } from '@/domain/json.js';

const retained = new Map<string, { bytes: number; expires: number }>();
const active = new Set<string>();
let retainedBytes = 0;

/** Expired, unreadable and foreign tokens have the same restart recovery. */
export function invalidCursor() {
  return validationError(
    'The continuation or record is unavailable; restart the original scoped request.',
    { reason: 'cursor_invalid' },
  );
}
/** Capacity refusal preserves the last published checkpoint. */
export function storageUnavailable(cause?: unknown) {
  return serviceUnavailable(
    'Acquisition storage is unavailable. Narrow the scope or explicitly configure framework filesystem storage and restart if the checkpoint is unavailable.',
    { reason: 'acquisition_storage_unavailable', retryable: false },
    cause === undefined ? undefined : { cause },
  );
}
function sweep(): void {
  const now = Date.now();
  for (const [key, entry] of retained)
    if (entry.expires <= now) {
      retainedBytes -= entry.bytes;
      retained.delete(key);
    }
}
function accountKey(ctx: Context, key: string): string {
  if (!ctx.tenantId) throw invalidCursor();
  return JSON.stringify([ctx.tenantId, key]);
}
/** Same-scan mutations are exclusive; contention fails safely instead of queueing unbounded work. */
export async function exclusive<T>(ctx: Context, id: string, run: () => Promise<T>): Promise<T> {
  const key = accountKey(ctx, id);
  if (active.has(key) || active.size >= 64)
    throw serviceUnavailable(
      'An acquisition operation is already active or local operation capacity is full. Retry the same cursor.',
      { reason: 'acquisition_busy', retryable: true },
    );
  active.add(key);
  try {
    return await run();
  } finally {
    active.delete(key);
  }
}
/** Read JSON through the framework facade, preserving cancellation and explicit invalidation. */
export async function readJson(ctx: Context, key: string): Promise<JsonValue> {
  ctx.signal.throwIfAborted();
  let value: unknown;
  try {
    value = await ctx.state.get(key);
  } catch (error) {
    ctx.signal.throwIfAborted();
    throw invalidCursorWithCause(error);
  }
  ctx.signal.throwIfAborted();
  if (value === null) throw invalidCursor();
  const parsed = JsonValueSchema.safeParse(value);
  if (!parsed.success) throw invalidCursorWithCause(parsed.error);
  return parsed.data;
}
function invalidCursorWithCause(cause: unknown) {
  return validationError(
    'The stored acquisition is unreadable; restart the original scoped request.',
    { reason: 'cursor_invalid' },
    { cause },
  );
}
/** Reserve serialized bytes synchronously before asynchronous storage, across all tenants. */
export async function writeJson(
  ctx: Context,
  key: string,
  value: unknown,
  expires: number,
): Promise<void> {
  const parsed = JsonValueSchema.parse(value);
  const bytes = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
  if (expires <= Date.now()) throw invalidCursor();
  const memory = config.storage.providerType === 'in-memory';
  if (memory) {
    sweep();
    const identity = accountKey(ctx, key);
    const previous = retained.get(identity);
    const reservedBytes = Math.max(bytes, previous?.bytes ?? 0);
    const delta = reservedBytes - (previous?.bytes ?? 0);
    if (
      (!previous && retained.size >= 9900) ||
      retainedBytes + delta > ACQUISITION_MEMORY_LIMIT_BYTES
    )
      throw storageUnavailable();
    retained.set(identity, { bytes: reservedBytes, expires });
    retainedBytes += delta;
  }
  try {
    await ctx.state.set(key, parsed, { ttl: Math.ceil((expires - Date.now()) / 1000) });
    if (memory) {
      const identity = accountKey(ctx, key);
      const reserved = retained.get(identity);
      if (reserved) {
        retainedBytes -= reserved.bytes - bytes;
        retained.set(identity, { bytes, expires });
      }
    }
  } catch (error) {
    ctx.signal.throwIfAborted();
    // A rejected provider write can still have side effects; keep its reservation until expiry.
    throw storageUnavailable(error);
  }
}
/** Reclaim only unpublished/replaced keys; never depend on cleanup for checkpoint correctness. */
export async function removeJson(ctx: Context, key: string): Promise<void> {
  try {
    await ctx.state.delete(key);
    const identity = accountKey(ctx, key);
    const previous = retained.get(identity);
    if (previous) {
      retainedBytes -= previous.bytes;
      retained.delete(identity);
    }
  } catch (error) {
    ctx.signal.throwIfAborted();
    throw storageUnavailable(error);
  }
}
