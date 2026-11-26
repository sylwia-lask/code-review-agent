import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { execSync } from 'child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  buildSnapshotId,
  computeDiffFingerprint,
  getDiffTool,
  getLastReviewedSnapshotId,
} from '../src/tools/get-diff.js';
import { MAX_DIFF_LENGTH } from '../src/tools.js';

const INITIAL_FILE_CONTENT = 'export const value = 1;\n';

function initGitRepoWithCommit(dir: string): string {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'file.ts'), INITIAL_FILE_CONTENT, 'utf-8');
  execSync('git add file.ts', { cwd: dir, stdio: 'pipe' });
  execSync(
    'git -c user.email="test@example.com" -c user.name="Test Developer" commit -m "initial commit"',
    { cwd: dir, stdio: 'pipe' },
  );
  return execSync('git rev-parse HEAD', {
    cwd: dir,
    encoding: 'utf-8',
  }).trim();
}

describe('getDiffTool', { timeout: 20_000 }, () => {
  let originalCwd: string;
  let originalCeiling: string | undefined;
  let repoDir: string;
  let headSha: string;

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'steve-get-diff-repo-'));
    headSha = initGitRepoWithCommit(repoDir);
  }, 20_000);

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dirname(repoDir);
    process.chdir(repoDir);
    writeFileSync(join(repoDir, 'file.ts'), INITIAL_FILE_CONTENT, 'utf-8');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalCeiling === undefined) {
      delete process.env.GIT_CEILING_DIRECTORIES;
    } else {
      process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
    }
  });

  it('returns HEAD Commit SHA, uncommitted working tree header, and unified diff when changes exist', async () => {
    writeFileSync(
      join(repoDir, 'file.ts'),
      'export const value = 2;\n',
      'utf-8',
    );

    const result = await getDiffTool.execute({});

    expect(headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result).toContain(`HEAD Commit SHA: ${headSha}`);
    expect(result).toContain('Working Tree: uncommitted changes against HEAD');
    expect(result).toContain('-export const value = 1;');
    expect(result).toContain('+export const value = 2;');
  });

  it('returns HEAD Commit SHA and clean working tree message when no changes exist', async () => {
    const result = await getDiffTool.execute({});

    expect(result).toContain(`HEAD Commit SHA: ${headSha}`);
    expect(result).toContain('Working Tree: clean');
    expect(result).toContain('No changes detected. The working tree is clean.');
  });

  it('truncates oversized diff bodies at MAX_DIFF_LENGTH while keeping the HEAD Commit SHA header intact', async () => {
    const largeContent =
      'export const big = "' + 'x'.repeat(MAX_DIFF_LENGTH + 2500) + '";\n';
    writeFileSync(join(repoDir, 'file.ts'), largeContent, 'utf-8');

    const result = await getDiffTool.execute({});

    expect(result.startsWith(`HEAD Commit SHA: ${headSha}\n`)).toBe(true);
    expect(result).toContain('Working Tree: uncommitted changes against HEAD');
    expect(result).toContain('... [diff truncated at 10,000 characters]');
  });

  it('handles an initialized git repository with no commits (unborn HEAD) and includes staged changes', async () => {
    const unbornDir = mkdtempSync(join(tmpdir(), 'steve-get-diff-unborn-'));
    try {
      process.env.GIT_CEILING_DIRECTORIES = dirname(unbornDir);
      process.chdir(unbornDir);
      execSync('git init', { cwd: unbornDir, stdio: 'pipe' });

      const cleanResult = await getDiffTool.execute({});
      expect(cleanResult).toContain(
        'HEAD Commit SHA: (none — unborn HEAD, no commits yet in this repository)',
      );
      expect(cleanResult).toContain('Working Tree: clean');

      writeFileSync(
        join(unbornDir, 'staged.ts'),
        'export const staged = true;\n',
        'utf-8',
      );
      execSync('git add staged.ts', { cwd: unbornDir, stdio: 'pipe' });

      const stagedResult = await getDiffTool.execute({});
      expect(stagedResult).toContain(
        'HEAD Commit SHA: (none — unborn HEAD, no commits yet in this repository)',
      );
      expect(stagedResult).toContain('+export const staged = true;');
      expect(stagedResult).toMatch(
        /Reviewed Snapshot ID: unborn:[0-9a-f]{16}\n/,
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(unbornDir, { recursive: true, force: true });
    }
  });

  describe('Reviewed Snapshot ID (diff fingerprint)', () => {
    function snapshotIdOf(output: string): string {
      const match = /Reviewed Snapshot ID: (\S+)/.exec(output);
      if (!match) throw new Error(`no snapshot id in output:\n${output}`);
      return match[1];
    }

    it('emits <head_short>:<sha256_16> plus the full sha256 of the full diff and records it as the last reviewed snapshot', async () => {
      writeFileSync(join(repoDir, 'file.ts'), 'export const value = 2;\n');

      const result = await getDiffTool.execute({});
      const fullDiff = execSync('git diff HEAD', {
        cwd: repoDir,
        encoding: 'utf-8',
      });
      const fingerprint = computeDiffFingerprint(fullDiff);

      expect(fingerprint).toBe(
        createHash('sha256')
          .update(fullDiff.replace(/\r\n/g, '\n'))
          .digest('hex'),
      );
      expect(snapshotIdOf(result)).toBe(
        `${headSha.slice(0, 7)}:${fingerprint.slice(0, 16)}`,
      );
      expect(result).toContain(`Diff Fingerprint (sha256): ${fingerprint}`);
      expect(getLastReviewedSnapshotId()).toBe(snapshotIdOf(result));
    });

    it('produces different snapshot IDs for two different diffs on the same HEAD', async () => {
      writeFileSync(join(repoDir, 'file.ts'), 'export const value = 2;\n');
      const first = snapshotIdOf(await getDiffTool.execute({}));

      // Edit again WITHOUT committing: HEAD is unchanged, the diff is not.
      writeFileSync(join(repoDir, 'file.ts'), 'export const value = 3;\n');
      const second = snapshotIdOf(await getDiffTool.execute({}));

      expect(
        execSync('git rev-parse HEAD', {
          cwd: repoDir,
          encoding: 'utf-8',
        }).trim(),
      ).toBe(headSha);
      expect(first.startsWith(`${headSha.slice(0, 7)}:`)).toBe(true);
      expect(second.startsWith(`${headSha.slice(0, 7)}:`)).toBe(true);
      expect(second).not.toBe(first);
    });

    it('produces the same snapshot ID when the same diff is reviewed again', async () => {
      writeFileSync(join(repoDir, 'file.ts'), 'export const value = 2;\n');

      const first = snapshotIdOf(await getDiffTool.execute({}));
      const second = snapshotIdOf(await getDiffTool.execute({}));

      expect(second).toBe(first);
    });

    it('fingerprints the full diff BEFORE truncation (diffs differing only past MAX_DIFF_LENGTH get distinct IDs)', async () => {
      const prefix = 'export const big = "' + 'x'.repeat(MAX_DIFF_LENGTH + 500);

      writeFileSync(join(repoDir, 'file.ts'), `${prefix}A";\n`);
      const fullDiffA = execSync('git diff HEAD', {
        cwd: repoDir,
        encoding: 'utf-8',
      });
      const outA = await getDiffTool.execute({});

      writeFileSync(join(repoDir, 'file.ts'), `${prefix}B";\n`);
      const fullDiffB = execSync('git diff HEAD', {
        cwd: repoDir,
        encoding: 'utf-8',
      });
      const outB = await getDiffTool.execute({});

      // The truncated hunk body shown to the LLM is identical...
      const hunk = (out: string) => out.slice(out.indexOf('@@'));
      expect(outA).toContain('... [diff truncated at 10,000 characters]');
      expect(outB).toContain('... [diff truncated at 10,000 characters]');
      expect(hunk(outA)).toBe(hunk(outB));

      // ...and the emitted fingerprint matches the FULL untruncated diff
      // (not the truncated body), producing distinct snapshot IDs.
      const fpA = computeDiffFingerprint(fullDiffA);
      const fpB = computeDiffFingerprint(fullDiffB);
      expect(fpA).not.toBe(
        computeDiffFingerprint(fullDiffA.slice(0, MAX_DIFF_LENGTH)),
      );
      expect(outA).toContain(`Diff Fingerprint (sha256): ${fpA}`);
      expect(outB).toContain(`Diff Fingerprint (sha256): ${fpB}`);
      expect(snapshotIdOf(outA)).not.toBe(snapshotIdOf(outB));
    });

    it('normalizes CRLF line endings before hashing', () => {
      const lf = 'diff --git a/x b/x\n-a\n+b\n';
      const crlf = lf.replace(/\n/g, '\r\n');
      expect(computeDiffFingerprint(crlf)).toBe(computeDiffFingerprint(lf));
      expect(computeDiffFingerprint(lf)).not.toBe(
        computeDiffFingerprint(lf + '+c\n'),
      );
    });

    it('builds traceable snapshot IDs for normal and unborn HEADs', () => {
      const fp = 'abcdef0123456789'.repeat(4);
      expect(buildSnapshotId('0C1905850FDE9D97', fp)).toBe(
        '0c19058:abcdef0123456789',
      );
      expect(buildSnapshotId(undefined, fp)).toBe('unborn:abcdef0123456789');
    });

    it('clears the last reviewed snapshot when the working tree is clean or git fails', async () => {
      writeFileSync(join(repoDir, 'file.ts'), 'export const value = 2;\n');
      await getDiffTool.execute({});
      expect(getLastReviewedSnapshotId()).toBeDefined();

      writeFileSync(join(repoDir, 'file.ts'), INITIAL_FILE_CONTENT, 'utf-8');
      const clean = await getDiffTool.execute({});
      expect(clean).toContain(
        'Reviewed Snapshot ID: (none — nothing to review)',
      );
      expect(getLastReviewedSnapshotId()).toBeUndefined();
    });
  });

  it('returns a clear error message when executed outside a git repository', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'steve-get-diff-nogit-'));
    try {
      process.env.GIT_CEILING_DIRECTORIES = dirname(nonGitDir);
      process.chdir(nonGitDir);
      const result = await getDiffTool.execute({});

      expect(result).toBe(
        'Error: failed to run git diff. Make sure this is a git repository.',
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
