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
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { HrDatabase } from '../hr-server/hr-db.js';
import { getDiffTool } from '../src/tools/get-diff.js';

const INITIAL_AUTH = 'export const ok = true;\n';

/**
 * End-to-end idempotency: real git working tree → getDiff → Reviewed Snapshot
 * ID → HrDatabase.fileComplaint. Proves that uncommitted edits between runs
 * (same HEAD) are NOT deduplicated against earlier findings, while a pure
 * re-run of the same diff is.
 */
describe(
  'snapshot-based complaint idempotency (getDiff → HR DB)',
  { timeout: 20_000 },
  () => {
    let originalCwd: string;
    let originalCeiling: string | undefined;
    let repoDir: string;
    let dbDir: string;
    let db: HrDatabase;

    beforeAll(() => {
      repoDir = mkdtempSync(join(tmpdir(), 'steve-snapshot-repo-'));
      execSync('git init', { cwd: repoDir, stdio: 'pipe' });
      writeFileSync(join(repoDir, 'auth.ts'), INITIAL_AUTH);
      execSync('git add auth.ts', { cwd: repoDir, stdio: 'pipe' });
      execSync(
        'git -c user.email="test@example.com" -c user.name="Test Developer" commit -m "initial"',
        { cwd: repoDir, stdio: 'pipe' },
      );
    }, 20_000);

    afterAll(() => {
      rmSync(repoDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      originalCwd = process.cwd();
      originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
      dbDir = mkdtempSync(join(tmpdir(), 'steve-snapshot-db-'));
      process.env.GIT_CEILING_DIRECTORIES = dirname(repoDir);
      process.chdir(repoDir);
      writeFileSync(join(repoDir, 'auth.ts'), INITIAL_AUTH);
      db = new HrDatabase(join(dbDir, 'hr.db'));
    });

    afterEach(() => {
      db.close();
      process.chdir(originalCwd);
      if (originalCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
      }
      rmSync(dbDir, { recursive: true, force: true });
    });

    async function reviewSnapshotId(): Promise<string> {
      const out = await getDiffTool.execute({});
      const match = /Reviewed Snapshot ID: (\S+)/.exec(out);
      if (!match) throw new Error(`no snapshot id in:\n${out}`);
      return match[1];
    }

    it('same HEAD + two different uncommitted diffs → distinct snapshots, both complaints recorded', async () => {
      writeFileSync(join(repoDir, 'auth.ts'), 'export const ok = !!process;\n');
      const snap1 = await reviewSnapshotId();
      const first = db.fileComplaint(
        'Sylwia',
        snap1,
        'security_vulnerability',
        'Auth check bypassed',
        'auth.ts',
      );

      writeFileSync(
        join(repoDir, 'auth.ts'),
        'export const ok = 1 as never;\n',
      );
      const snap2 = await reviewSnapshotId();
      const second = db.fileComplaint(
        'Sylwia',
        snap2,
        'security_vulnerability',
        'New, different auth bypass',
        'auth.ts',
      );

      expect(snap2).not.toBe(snap1);
      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(second.complaint.id).not.toBe(first.complaint.id);
      expect(db.getStats().totalComplaints).toBe(2);
    });

    it('same diff re-run without changes → same snapshot, idempotent dedup returning the existing #id', async () => {
      writeFileSync(join(repoDir, 'auth.ts'), 'export const ok = !!process;\n');
      const snap1 = await reviewSnapshotId();
      const first = db.fileComplaint(
        'Sylwia',
        snap1,
        'security_vulnerability',
        'Auth check bypassed',
        'auth.ts',
      );

      const snap2 = await reviewSnapshotId();
      const rerun = db.fileComplaint(
        'Sylwia',
        snap2,
        'security_vulnerability',
        'LLM rephrased the same finding on the re-run',
        'auth.ts',
      );

      expect(snap2).toBe(snap1);
      expect(rerun.created).toBe(false);
      expect(rerun.complaint.id).toBe(first.complaint.id);
      expect(db.getStats().totalComplaints).toBe(1);
    });
  },
);
