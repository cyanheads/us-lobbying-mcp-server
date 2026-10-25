/** @fileoverview Source identifier and optional-input normalization tests. @module tests/domain/json */
import { describe, expect, it } from 'vitest';
import {
  JsonValueSchema,
  normalizeSourceId,
  optionalCode,
  optionalLowercase,
  optionalText,
} from '../../src/domain/json.js';

describe('normalizeSourceId', () => {
  it.each([
    [0, '0'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    ['00042', '00042'],
    ['9007199254740993123456789', '9007199254740993123456789'],
  ] as const)('preserves every digit of %s', (input, expected) => {
    expect(normalizeSourceId(input)).toBe(expected);
  });
  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '',
    ' 42 ',
    '1e3',
    '12.0',
  ])('rejects ambiguous or lossy source identity %s', (input) => {
    expect(() => normalizeSourceId(input)).toThrow();
  });
});

describe('optional input normalization', () => {
  it.each([undefined, '', ' \t\r\n '])('treats %j as absent', (input) => {
    expect(optionalText(input)).toBeUndefined();
    expect(optionalCode(input)).toBeUndefined();
    expect(optionalLowercase(input)).toBeUndefined();
  });
  it('retains literal names and interior whitespace while normalizing code and mode casing', () => {
    expect(optionalText('  Société  A&B, Inc.  ')).toBe('Société  A&B, Inc.');
    expect(optionalCode('  heA  ')).toBe('HEA');
    expect(optionalLowercase('  AcTiViTy  ')).toBe('activity');
  });
});

describe('JSON source-value boundary', () => {
  it('keeps future fields through nested objects and arrays without manufacturing absent data', () => {
    const record = JSON.parse(
      '{"future":{"enabled":true},"unknown":{"rows":[{"nullable":null,"empty":[],"text":"é🌲","constructor":{"source":"literal"}}]}}',
    );
    expect(JsonValueSchema.parse(record)).toEqual(record);
  });
  it.each([
    '{"__proto__":{"future":true}}',
    '{"unknown":{"rows":[{"__proto__":{"future":true}}]}}',
  ])('rejects an own prototype key rather than silently losing source data: %s', (json) => {
    expect(JsonValueSchema.safeParse(JSON.parse(json)).success).toBe(false);
  });
  it.each([
    { child: { value: undefined } },
    { child: [Number.NaN] },
    { child: Number.POSITIVE_INFINITY },
    { child: 1n },
  ])('rejects nested values that cannot survive JSON serialization: %#', (value) => {
    expect(JsonValueSchema.safeParse(value).success).toBe(false);
  });
});
