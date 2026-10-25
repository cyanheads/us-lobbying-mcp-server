/** @fileoverview One cancellation deadline for every stage of a tool call. @module config/tool-deadline */
import type { Context } from '@cyanheads/mcp-ts-core';
import { TOOL_DEADLINE_MS } from '@/domain/contracts.js';

/** Preserve caller cancellation while bounding validation, acquisition and finalization together. */
export function withToolDeadline<T extends Context>(ctx: T): T {
  return { ...ctx, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TOOL_DEADLINE_MS)]) };
}
