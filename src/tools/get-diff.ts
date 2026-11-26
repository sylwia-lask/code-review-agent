import { execSync } from 'child_process';
import { createHash } from 'node:crypto';
import { Type } from '@google/genai';
import type { Tool } from '../tools.js';
import { MAX_DIFF_LENGTH } from '../tools.js';

/** Number of hex chars of the diff SHA-256 kept in the compact snapshot ID. */
export const SNAPSHOT_HASH_LENGTH = 16;

/** Prefix used in snapshot IDs when the repository has no commits yet. */
export const UNBORN_HEAD_PREFIX = 'unborn';

/**
 * Deterministic SHA-256 fingerprint of a unified diff. Line endings are
 * normalized (`\r\n` → `\n`) so the same change hashes identically regardless
 * of platform/autocrlf. Always computed on the FULL diff, before truncation.
 */
export function computeDiffFingerprint(diff: string): string {
  return createHash('sha256')
    .update(diff.replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

/**
 * Build the traceable identity of a reviewed working-tree snapshot:
 * `<head_short>:<diff_hash_16>` (or `unborn:<diff_hash_16>` without commits).
 * Two reviews only share a snapshot ID when both HEAD and the full diff match.
 */
export function buildSnapshotId(
  headSha: string | undefined,
  diffFingerprint: string,
): string {
  const head = headSha ? headSha.slice(0, 7).toLowerCase() : UNBORN_HEAD_PREFIX;
  return `${head}:${diffFingerprint.slice(0, SNAPSHOT_HASH_LENGTH)}`;
}

let lastReviewedSnapshotId: string | undefined;

/**
 * Snapshot ID emitted by the most recent successful getDiff call in this
 * process (undefined if getDiff has not run, failed, or found nothing to
 * review). The client harness uses it to reject fabricated snapshot IDs.
 */
export function getLastReviewedSnapshotId(): string | undefined {
  return lastReviewedSnapshotId;
}

/**
 * Tool: getDiff
 *
 * Runs `git rev-parse HEAD` and `git diff HEAD` on the current repository.
 * Prefixes the output with the HEAD commit SHA plus a `Reviewed Snapshot ID`
 * derived from a SHA-256 of the full (untruncated) diff, so downstream tools
 * (such as HR complaint filing) reference the exact code that was reviewed —
 * not just the last commit, which uncommitted edits do not change.
 * Shows staged + unstaged changes and truncates very large diffs without
 * losing the header.
 */
export const getDiffTool: Tool = {
  name: 'getDiff',
  description:
    'Get the git diff of the current repository along with the HEAD Commit SHA and the Reviewed Snapshot ID (a fingerprint of the exact diff under review). Returns the header followed by a unified diff of all uncommitted changes (staged and unstaged).',
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: [],
  },
  execute: async () => {
    lastReviewedSnapshotId = undefined;
    try {
      let headSha: string | undefined;

      try {
        headSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
      } catch (revParseErr) {
        const message =
          revParseErr instanceof Error
            ? revParseErr.message
            : String(revParseErr);
        if (/not a git repository/i.test(message)) {
          throw revParseErr;
        }
        // Repository is initialized but has no commits yet (unborn HEAD)
        headSha = undefined;
      }

      const headLabel =
        headSha ?? '(none — unborn HEAD, no commits yet in this repository)';

      const diff = headSha
        ? execSync('git diff HEAD', { encoding: 'utf-8' })
        : [
            execSync('git diff --cached', { encoding: 'utf-8' }),
            execSync('git diff', { encoding: 'utf-8' }),
          ]
            .filter((part) => part.trim().length > 0)
            .join('\n');

      if (!diff.trim()) {
        return (
          `HEAD Commit SHA: ${headLabel}\n` +
          `Reviewed Snapshot ID: (none — nothing to review)\n` +
          `Working Tree: clean\n\n` +
          `No changes detected. The working tree is clean.`
        );
      }

      // Fingerprint the FULL diff before truncation so edits beyond the
      // truncation point still yield a distinct snapshot identity.
      const diffFingerprint = computeDiffFingerprint(diff);
      const snapshotId = buildSnapshotId(headSha, diffFingerprint);
      lastReviewedSnapshotId = snapshotId;

      // Truncate only the diff body to avoid blowing the context window while keeping the header intact
      const diffBody =
        diff.length > MAX_DIFF_LENGTH
          ? diff.slice(0, MAX_DIFF_LENGTH) +
            '\n\n... [diff truncated at 10,000 characters]'
          : diff;

      return (
        `HEAD Commit SHA: ${headLabel}\n` +
        `Reviewed Snapshot ID: ${snapshotId}\n` +
        `Diff Fingerprint (sha256): ${diffFingerprint}\n` +
        `Working Tree: uncommitted changes against HEAD\n\n` +
        diffBody
      );
    } catch {
      lastReviewedSnapshotId = undefined;
      return 'Error: failed to run git diff. Make sure this is a git repository.';
    }
  },
};
