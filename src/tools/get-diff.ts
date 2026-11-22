import { execSync } from 'child_process';
import { Type } from '@google/genai';
import type { Tool } from '../tools.js';
import { MAX_DIFF_LENGTH } from '../tools.js';

/**
 * Tool: getDiff
 *
 * Runs `git rev-parse HEAD` and `git diff HEAD` on the current repository.
 * Always prefixes the output with the current HEAD commit SHA so downstream
 * tools (such as HR complaint filing) can reference the exact commit deterministically.
 * Shows staged + unstaged changes and truncates very large diffs without losing the SHA header.
 */
export const getDiffTool: Tool = {
  name: 'getDiff',
  description:
    'Get the git diff of the current repository along with the HEAD Commit SHA. Returns the HEAD commit SHA header followed by a unified diff of all uncommitted changes (staged and unstaged).',
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: [],
  },
  execute: async () => {
    try {
      let headSha: string;
      let diff: string;

      try {
        headSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
        diff = execSync('git diff HEAD', { encoding: 'utf-8' });
      } catch (revParseErr) {
        const message =
          revParseErr instanceof Error
            ? revParseErr.message
            : String(revParseErr);
        if (/not a git repository/i.test(message)) {
          throw revParseErr;
        }
        // Repository is initialized but has no commits yet (unborn HEAD)
        headSha =
          '(none — unborn HEAD, create an initial commit before filing HR complaints)';
        diff = execSync('git diff', { encoding: 'utf-8' });
      }

      if (!diff.trim()) {
        return (
          `HEAD Commit SHA: ${headSha}\n` +
          `Working Tree: clean\n\n` +
          `No changes detected. The working tree is clean.`
        );
      }

      // Truncate only the diff body to avoid blowing the context window while keeping the SHA header intact
      const diffBody =
        diff.length > MAX_DIFF_LENGTH
          ? diff.slice(0, MAX_DIFF_LENGTH) +
            '\n\n... [diff truncated at 10,000 characters]'
          : diff;

      return (
        `HEAD Commit SHA: ${headSha}\n` +
        `Working Tree: uncommitted changes against HEAD\n\n` +
        diffBody
      );
    } catch {
      return 'Error: failed to run git diff. Make sure this is a git repository.';
    }
  },
};
