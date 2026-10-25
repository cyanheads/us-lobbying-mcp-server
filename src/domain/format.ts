/** @fileoverview Lossless JSON text formatting and official document links. @module domain/format */
import type { JsonValue } from './json.js';

/** Format every field once as JSON; source fence runs cannot terminate the block. */
export function formatResult(result: object): { type: 'text'; text: string }[] {
  const json = JSON.stringify(result, null, 2);
  const runs = json.match(/`+/g) ?? [];
  const fence = '`'.repeat(runs.reduce((longest, run) => Math.max(longest, run.length + 1), 3));
  const links = new Set<string>();
  const visit = (value: JsonValue): void => {
    if (typeof value === 'string') {
      if (!value.startsWith('https://')) return;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return;
      }
      if (
        ['lda.gov', 'efile.fara.gov', 'lobbyingdisclosure.house.gov'].includes(url.hostname) &&
        !url.username &&
        !url.password
      )
        links.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };
  // Results have already passed their JSON-safe output schema at the tool boundary.
  visit(JSON.parse(json));
  const documents = [...links]
    .map(
      (url, index) =>
        `[Official source ${index + 1}](<${url.replaceAll('>', '%3E').replaceAll('<', '%3C')}>)`,
    )
    .join('\n');
  return [
    { type: 'text', text: `${fence}json\n${json}\n${fence}${documents ? `\n\n${documents}` : ''}` },
  ];
}
/** Measure the two complete result surfaces with reserved transport-envelope bytes. */
export function fullResultBytes(result: object): number {
  return (
    new TextEncoder().encode(
      JSON.stringify({ content: formatResult(result), structuredContent: result }),
    ).byteLength + 512
  );
}
