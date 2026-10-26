/** @fileoverview Bundle pruning preserves dependency runtime modules named skills. @module tests/scripts/clean-mcpb */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { checkBundleEntries } from '../../scripts/lint-packaging.js';

describe('dependency agent documentation pruning', () => {
  it('removes dependency skill roots and other agent documentation', () => {
    const docs = [
      'node_modules/example/skills/review/SKILL.md',
      'node_modules/@scope/example/skills/review/reference.txt',
      'node_modules/parent/node_modules/@scope/example/skills/review/helper.ts',
      'node_modules/example/framework-skills/review/reference.md',
      'node_modules/example/.claude/settings.json',
      'node_modules/example/.agents/rules.md',
      'node_modules/example/nested/SKILL.md',
    ];
    expect(filterAgentDocEntries(docs)).toEqual(docs);
    expect(checkBundleEntries(docs, 'fixture')).toHaveLength(1);
  });

  it('preserves SDK and other nested runtime skills modules in both checks', () => {
    const runtime = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/core/dist/ext/skills/types.cjs',
      'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/example/dist/skills/loader.js',
      'skills/published/SKILL.md',
    ];
    expect(filterAgentDocEntries(runtime)).toEqual([]);
    expect(checkBundleEntries(runtime, 'fixture')).toEqual([]);
  });
});
