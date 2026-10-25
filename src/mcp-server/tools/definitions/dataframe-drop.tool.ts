/** @fileoverview Opt-in removal of staged disclosure tables. @module mcp-server/tools/definitions/dataframe-drop.tool */
import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { withToolDeadline } from '@/config/tool-deadline.js';
import { CanvasPointersShape } from '@/domain/contracts.js';
import { formatResult } from '@/domain/format.js';
import { dropCanvasTable } from '@/services/canvas/canvas-service.js';

const definition = tool('uslobbying_dataframe_drop', {
  title: 'Drop disclosure table',
  description:
    'Remove one staged table before expiry when deletion is enabled; an absent table returns dropped false.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    canvas_id: CanvasIdSchema.describe('Canvas token containing the table to remove.'),
    table_name: z.string().trim().min(1).describe('Exact existing table name.'),
  }),
  output: z.object({
    ...CanvasPointersShape,
    table_name: z.string().describe('Requested table name.'),
    dropped: z.boolean().describe('Whether a table existed and was removed.'),
  }),
  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'Canvas is not configured.',
      recovery:
        'Use uslobbying_get_client_profile or uslobbying_get_issue_spending for inline results; SQL requires an npm or Docker installation with CANVAS_PROVIDER_TYPE=duckdb, and is unavailable in the MCPB bundle.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'Canvas token is unknown or expired and no deletion is possible.',
      recovery:
        'No table can be removed from this canvas; use a canvas_id returned by uslobbying_get_client_profile or uslobbying_get_issue_spending for a later drop.',
    },
  ],
  handler: (input, ctx) => dropCanvasTable(input, withToolDeadline(ctx)),
  format: formatResult,
});

/** Retain operator enable guidance in the manifest when deletion is disabled. */
export function createDataframeDropTool() {
  return getServerConfig().dataframeDropEnabled
    ? definition
    : disabledTool(definition, {
        reason: 'Dataframe deletion is disabled.',
        hint: 'Set USLOBBYING_DATAFRAME_DROP_ENABLED=true to enable.',
      });
}
