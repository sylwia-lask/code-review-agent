import { describe, it, expect } from 'vitest';
import { Type } from '@google/genai';
import { toFunctionDeclarations, executeTool, type Tool } from '../src/tools.js';

describe('Tool Registry', () => {
  const fakeTool: Tool = {
    name: 'sayHello',
    description: 'Says hello to someone',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'Name to greet' },
      },
      required: ['name'],
    },
    execute: async (args) => `Hello, ${args.name}!`,
  };

  describe('toFunctionDeclarations', () => {
    it('converts tools to Gemini function declarations', () => {
      const declarations = toFunctionDeclarations([fakeTool]);

      expect(declarations).toHaveLength(1);
      expect(declarations[0].name).toBe('sayHello');
      expect(declarations[0].description).toBe('Says hello to someone');
      expect(declarations[0].parameters).toBeDefined();
    });
  });

  describe('executeTool', () => {
    it('finds and executes a tool by name', async () => {
      const result = await executeTool([fakeTool], 'sayHello', { name: 'World' });
      expect(result).toBe('Hello, World!');
    });

    it('returns an error message for unknown tools', async () => {
      const result = await executeTool([fakeTool], 'unknownTool', {});
      expect(result).toContain('Error: unknown tool');
    });
  });
});
