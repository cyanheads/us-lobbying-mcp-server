/** @fileoverview Disposable real DuckDB canvas fixtures. @module tests/services/canvas/fixture */
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { ProvenanceSchema } from '../../../src/domain/contracts.js';
import { type Filing, FilingSchema } from '../../../src/domain/lda.js';
import { setCanvas, stageFilings } from '../../../src/services/canvas/canvas-service.js';
import { analyzeFilings } from '../../../src/services/lobbying/analysis.js';

export function filing(n: number, fields: Partial<Filing> = {}): Filing {
  return FilingSchema.parse({
    filing_uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    filing_type: 'Q1',
    filing_year: 2024,
    filing_period: 'first_quarter',
    dt_posted: '2024-04-01T00:00:00Z',
    registrant: { id: '10', name: 'Synthetic firm' },
    client: { id: String(n), name: 'Synthetic client' },
    income: null,
    expenses: null,
    ...fields,
  });
}

export const provenance = ProvenanceSchema.parse({
  source: 'lda',
  retrieved_at: '2024-04-02T00:00:00Z',
  effective_filters: { year: 2024 },
  notices: ['Synthetic source'],
  coverage: {
    complete: true,
    pages_fetched: 2,
    records_fetched: 3,
    unique_records: 3,
    started_at: '2024-04-01T00:00:00Z',
    finished_at: '2024-04-02T00:00:00Z',
  },
});

export async function fixture() {
  const ctx = createMockContext();
  const provider = new DuckdbProvider({
    defaultRowLimit: 100,
    exportRootPath: '/tmp',
    memoryLimitMb: 64,
    schemaSniffRows: 1,
  });
  const canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, undefined, () => Date.now()),
  );
  setCanvas(canvas, 100);
  const instance = await canvas.acquire(undefined, ctx);
  return {
    ctx,
    canvas,
    instance,
    async close() {
      setCanvas(undefined);
      await canvas.shutdown(ctx);
    },
  };
}

export async function stage(
  f: Awaited<ReturnType<typeof fixture>>,
  rows: Filing[] = [
    filing(1),
    filing(2, {
      income: '9007199254740993.01',
      expenses: '0.09',
      future: { nested: ['a', null] },
      source_fields: { literal: true },
      lobbying_activities: [
        { general_issue_code: 'TEC', description: 'Source ``` text é', future: [1, 2] },
      ],
    }),
    filing(3, { income: '0.09' }),
  ],
) {
  const analysis = await analyzeFilings(rows);
  async function* stream() {
    yield* rows;
  }
  return await stageFilings(
    {
      canvas_id: f.instance.canvasId,
      raw_filings: stream(),
      selected_filings: analysis.selected,
      ...{ selections: analysis.selections },
      activities: analysis.activities,
      provenance,
      source_tool: 'uslobbying_get_client_profile',
    },
    f.ctx,
  );
}
