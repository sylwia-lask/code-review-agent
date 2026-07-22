import { readdirSync } from 'fs';
import { resolve } from 'path';
import { Type } from '@google/genai';
import type { Tool } from '../tools.js';

/**
 * Tool: listFiles
 *
 * Lists files in a directory of the repository.
 * Useful for understanding project structure before reading specific files.
 */
export const listFilesTool: Tool = {
  name: 'listFiles',
  description:
    'List files and directories at a given path in the repository. Returns one entry per line.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description:
          'Directory path relative to the repository root, e.g. "src/tools". Use "" for root.',
      },
    },
    required: ['path'],
  },
  execute: async (args) => {
    const dirPath = args.path as string;
    const fullPath = resolve(process.cwd(), dirPath);

    try {
      const entries = readdirSync(fullPath, { withFileTypes: true });

      const lines = entries.map((entry) => {
        const suffix = entry.isDirectory() ? '/' : '';
        return `${entry.name}${suffix}`;
      });

      return lines.join('\n');
    } catch {
      return `Error: directory "${dirPath}" not found in the repository`;
    }
  },
};
