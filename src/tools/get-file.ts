import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { Type } from '@google/genai';
import type { Tool } from '../tools.js';

/**
 * Tool: getFile
 *
 * Reads a file from the current repository.
 * The agent uses this to get additional context beyond the diff.
 */
export const getFileTool: Tool = {
  name: 'getFile',
  description:
    'Read a file from the repository to get additional context. Returns the full file content.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description:
          'Path to the file relative to the repository root, e.g. "src/agent.ts"',
      },
    },
    required: ['path'],
  },
  execute: async (args) => {
    const filePath = args.path as string;
    const fullPath = resolve(process.cwd(), filePath);

    try {
      const content = await readFile(fullPath, 'utf-8');
      return content;
    } catch {
      return `Error: file "${filePath}" not found in the repository`;
    }
  },
};
