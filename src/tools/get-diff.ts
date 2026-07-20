import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { Type } from '@google/genai';
import type { Tool } from '../tools.js';

/**
 * Tool: getDiff
 *
 * Returns the diff (code changes) that the agent should review.
 * In this demo version, it reads a local fixture file.
 */
export const getDiffTool: Tool = {
  name: 'getDiff',
  description:
    'Get the code diff (changes) to review. Returns the unified diff format showing what was added/removed.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: [],
  },
  execute: async () => {
    const diffPath = resolve(process.cwd(), 'fixtures', 'sample.diff');
    const diff = await readFile(diffPath, 'utf-8');
    return diff;
  },
};
