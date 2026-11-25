import { describe, it, expect } from 'vitest';
import { Type } from '@google/genai';
import { mcpInputSchemaToGemini } from '../src/mcp/schema-convert.js';

/**
 * Tests for the JSON Schema -> Gemini Schema converter. This is the bridge that
 * lets an MCP tool's advertised inputSchema drop into the agent's existing
 * function-calling format without any hand-written declarations.
 */
describe('mcpInputSchemaToGemini', () => {
  it('converts an object with string properties and required fields', () => {
    const result = mcpInputSchemaToGemini({
      type: 'object',
      properties: {
        developer: { type: 'string', description: 'Who it is about' },
        reason: { type: 'string' },
      },
      required: ['developer'],
    });

    expect(result?.type).toBe(Type.OBJECT);
    expect(result?.properties?.developer.type).toBe(Type.STRING);
    expect(result?.properties?.developer.description).toBe('Who it is about');
    expect(result?.required).toEqual(['developer']);
  });

  it('maps an enum to a STRING type with string values', () => {
    const result = mcpInputSchemaToGemini({
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['minor', 'moderate', 'severe', 'legendary'],
        },
      },
      required: ['severity'],
    });

    const severity = result?.properties?.severity;
    expect(severity?.type).toBe(Type.STRING);
    expect(severity?.enum).toEqual([
      'minor',
      'moderate',
      'severe',
      'legendary',
    ]);
  });

  it('represents a no-argument tool as an empty object schema', () => {
    const result = mcpInputSchemaToGemini({ type: 'object', properties: {} });
    expect(result?.type).toBe(Type.OBJECT);
    expect(result?.properties).toEqual({});
  });

  it('handles number, integer, and boolean types', () => {
    const result = mcpInputSchemaToGemini({
      type: 'object',
      properties: {
        count: { type: 'integer' },
        ratio: { type: 'number' },
        active: { type: 'boolean' },
      },
    });

    expect(result?.properties?.count.type).toBe(Type.INTEGER);
    expect(result?.properties?.ratio.type).toBe(Type.NUMBER);
    expect(result?.properties?.active.type).toBe(Type.BOOLEAN);
  });

  it('handles arrays with typed items', () => {
    const result = mcpInputSchemaToGemini({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
      },
    });

    const tags = result?.properties?.tags;
    expect(tags?.type).toBe(Type.ARRAY);
    expect(tags?.items?.type).toBe(Type.STRING);
  });

  it('returns undefined for non-object input', () => {
    expect(mcpInputSchemaToGemini(undefined)).toBeUndefined();
    expect(mcpInputSchemaToGemini('nope')).toBeUndefined();
  });

  it('preserves complaint category enum and converts snapshot_id + optional file_path to Gemini string schemas', () => {
    const categories = [
      'security_vulnerability',
      'reckless_practice',
      'error_handling',
      'bug_or_regression',
      'missing_tests',
      'maintainability',
    ];

    const result = mcpInputSchemaToGemini({
      type: 'object',
      properties: {
        developer: { type: 'string', description: 'Developer name' },
        snapshot_id: {
          type: 'string',
          pattern:
            '^(?:[0-9a-f]{7,40}|(?:[0-9a-f]{7,40}|unborn):[0-9a-f]{16,64})$',
          description: 'Reviewed Snapshot ID or Git commit SHA',
        },
        file_path: {
          type: 'string',
          description: 'Repository-relative path copied from the diff header',
        },
        category: {
          type: 'string',
          enum: categories,
          description: 'Fixed technical complaint category',
        },
        reason: { type: 'string', description: 'Concrete offense description' },
      },
      required: ['developer', 'snapshot_id', 'category', 'reason'],
    });

    expect(result?.type).toBe(Type.OBJECT);
    expect(result?.properties?.category.type).toBe(Type.STRING);
    expect(result?.properties?.category.enum).toEqual(categories);
    expect(result?.properties?.snapshot_id.type).toBe(Type.STRING);
    expect(result?.properties?.snapshot_id.description).toBe(
      'Reviewed Snapshot ID or Git commit SHA',
    );
    expect(result?.properties?.file_path.type).toBe(Type.STRING);
    expect(result?.required).toEqual([
      'developer',
      'snapshot_id',
      'category',
      'reason',
    ]);
  });
});
