import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { getDiffTool } from '../src/tools/get-diff.js';
import { MAX_DIFF_LENGTH } from '../src/tools.js';

function initGitRepoWithCommit(dir: string): string {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', {
    cwd: dir,
    stdio: 'pipe',
  });
  execSync('git config user.name "Test Developer"', {
    cwd: dir,
    stdio: 'pipe',
  });
  writeFileSync(join(dir, 'file.ts'), 'export const value = 1;\n', 'utf-8');
  execSync('git add file.ts', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', {
    cwd: dir,
    encoding: 'utf-8',
  }).trim();
}

describe('getDiffTool', () => {
  let originalCwd: string;
  let originalCeiling: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
    tempDir = mkdtempSync(join(tmpdir(), 'steve-get-diff-test-'));
    process.env.GIT_CEILING_DIRECTORIES = dirname(tempDir);
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalCeiling === undefined) {
      delete process.env.GIT_CEILING_DIRECTORIES;
    } else {
      process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns HEAD Commit SHA, uncommitted working tree header, and unified diff when changes exist', async () => {
    const sha = initGitRepoWithCommit(tempDir);
    writeFileSync(
      join(tempDir, 'file.ts'),
      'export const value = 2;\n',
      'utf-8',
    );

    const result = await getDiffTool.execute({});

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result).toContain(`HEAD Commit SHA: ${sha}`);
    expect(result).toContain('Working Tree: uncommitted changes against HEAD');
    expect(result).toContain('-export const value = 1;');
    expect(result).toContain('+export const value = 2;');
  });

  it('returns HEAD Commit SHA and clean working tree message when no changes exist', async () => {
    const sha = initGitRepoWithCommit(tempDir);

    const result = await getDiffTool.execute({});

    expect(result).toContain(`HEAD Commit SHA: ${sha}`);
    expect(result).toContain('Working Tree: clean');
    expect(result).toContain('No changes detected. The working tree is clean.');
  });

  it('truncates oversized diff bodies at MAX_DIFF_LENGTH while keeping the HEAD Commit SHA header intact', async () => {
    const sha = initGitRepoWithCommit(tempDir);
    const largeContent =
      'export const big = "' + 'x'.repeat(MAX_DIFF_LENGTH + 2500) + '";\n';
    writeFileSync(join(tempDir, 'file.ts'), largeContent, 'utf-8');

    const result = await getDiffTool.execute({});

    expect(result.startsWith(`HEAD Commit SHA: ${sha}\n`)).toBe(true);
    expect(result).toContain('Working Tree: uncommitted changes against HEAD');
    expect(result).toContain('... [diff truncated at 10,000 characters]');
  });

  it('handles an initialized git repository with no commits (unborn HEAD) and includes staged changes', async () => {
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });

    const cleanResult = await getDiffTool.execute({});
    expect(cleanResult).toContain(
      'HEAD Commit SHA: (none — unborn HEAD, create an initial commit before filing HR complaints)',
    );
    expect(cleanResult).toContain('Working Tree: clean');

    writeFileSync(
      join(tempDir, 'staged.ts'),
      'export const staged = true;\n',
      'utf-8',
    );
    execSync('git add staged.ts', { cwd: tempDir, stdio: 'pipe' });

    const stagedResult = await getDiffTool.execute({});
    expect(stagedResult).toContain(
      'HEAD Commit SHA: (none — unborn HEAD, create an initial commit before filing HR complaints)',
    );
    expect(stagedResult).toContain('+export const staged = true;');
  });

  it('returns a clear error message when executed outside a git repository', async () => {
    const result = await getDiffTool.execute({});

    expect(result).toBe(
      'Error: failed to run git diff. Make sure this is a git repository.',
    );
  });
});
