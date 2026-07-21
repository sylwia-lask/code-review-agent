import { execSync } from 'child_process';
import { Type } from '@google/genai';
import type { Tool } from '../tools.js';

/**
 * Tool: getDiff
 *
 * Runs `git diff` on the current repository and returns the result.
 * Shows staged + unstaged changes by default.
 */
export const getDiffTool: Tool = {
  name: 'getDiff',
  description:
    'Get the git diff of the current repository. Returns unified diff of all uncommitted changes (staged and unstaged).',
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: [],
  },
  execute: async () => {
    try {
      // Get both staged and unstaged changes
      const diff = execSync('git diff HEAD', { encoding: 'utf-8' });

      if (!diff.trim()) {
        return 'No changes detected. The working tree is clean.';
      }

      return diff;
    } catch {
      return 'Error: failed to run git diff. Make sure this is a git repository.';
    }
  },
};
