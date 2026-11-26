import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CATEGORY_WEIGHTS,
  COMPLAINT_CATEGORIES,
  HrDatabase,
} from '../hr-server/hr-db.js';

/**
 * Tests for the SQLite persistence layer.
 *
 * Each test gets its own temp database file so they're isolated and so we can
 * prove data actually persists to disk (by closing and reopening the file).
 */
describe('HrDatabase (SQLite persistence)', () => {
  let dir: string;
  let dbPath: string;
  let db: HrDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'steve-hr-test-'));
    dbPath = join(dir, 'hr.db');
    db = new HrDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates tables automatically and starts empty', () => {
    const stats = db.getStats();
    expect(stats.totalComplaints).toBe(0);
    expect(stats.totalWeight).toBe(0);
    expect(stats.totalPromotions).toBe(0);
    expect(stats.developersTracked).toBe(0);
    expect(stats.mostComplainedAbout).toBeNull();
    expect(stats.mostPromoted).toBeNull();
  });

  it('files a complaint with fixed category weight and reads it back', () => {
    const { complaint, created } = db.fileComplaint(
      'Dusty McLegacy',
      '0c19058',
      'error_handling',
      'Swallowed an exception',
    );
    expect(created).toBe(true);
    expect(complaint.id).toBeGreaterThan(0);
    expect(complaint.developer).toBe('Dusty McLegacy');
    expect(complaint.snapshot_id).toBe('0c19058');
    expect(complaint.category).toBe('error_handling');
    expect(complaint.weight).toBe(CATEGORY_WEIGHTS.error_handling);

    const record = db.getEmployeeRecord('Dusty McLegacy');
    expect(record.complaints).toHaveLength(1);
    expect(record.complaints[0].reason).toBe('Swallowed an exception');
    expect(record.complaints[0].snapshot_id).toBe('0c19058');
    expect(record.complaints[0].category).toBe('error_handling');
    expect(record.complaints[0].weight).toBe(6);
    expect(record.promotions).toHaveLength(0);
  });

  it('records a promotion nomination', () => {
    db.nominateForPromotion('Ada Refactor', 'Deleted dead code');
    const record = db.getEmployeeRecord('Ada Refactor');
    expect(record.promotions).toHaveLength(1);
    expect(record.promotions[0].reason).toBe('Deleted dead code');
  });

  it('looks up developers case-insensitively and trims whitespace', () => {
    db.fileComplaint(
      '  Casey   Nullpointer ',
      'a1b2c3d',
      'error_handling',
      'Logged "lol" on error',
    );
    const record = db.getEmployeeRecord('casey nullpointer');
    expect(record.complaints).toHaveLength(1);
    // Name is normalized on write (trimmed + collapsed whitespace).
    expect(record.complaints[0].developer).toBe('Casey Nullpointer');
  });

  it('enforces idempotency on (developer, snapshot_id, category, file_path) even when reason changes', () => {
    const first = db.fileComplaint(
      'Sylwia',
      '0c1905850fde9d97bfbe9416097081d11f193626',
      'security_vulnerability',
      'First run: role check removed in verifyToken',
    );
    expect(first.created).toBe(true);

    const second = db.fileComplaint(
      'Sylwia',
      '0c1905850fde9d97bfbe9416097081d11f193626',
      'security_vulnerability',
      'Second run 20 minutes later: completely different wording from the LLM',
    );
    expect(second.created).toBe(false);
    expect(second.complaint.id).toBe(first.complaint.id);
    expect(second.complaint.reason).toBe(
      'First run: role check removed in verifyToken',
    );

    const stats = db.getStats();
    expect(stats.totalComplaints).toBe(1);
    expect(stats.totalWeight).toBe(10);
  });

  it('deduplicates case-insensitively across developer name and snapshot_id', () => {
    const first = db.fileComplaint(
      '  Dusty   McLegacy ',
      'ABCDEF1',
      'reckless_practice',
      'Pushed straight to main',
    );
    const second = db.fileComplaint(
      'dusty mclegacy',
      '  abcdef1  ',
      'reckless_practice',
      'Re-run with lowercase developer and sha',
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.complaint.id).toBe(first.complaint.id);
    expect(second.complaint.snapshot_id).toBe('abcdef1');

    const stats = db.getStats();
    expect(stats.totalComplaints).toBe(1);
    expect(stats.developersTracked).toBe(1);
  });

  it('deduplicates bidirectionally between 7-char short SHA and 40-char full SHA, promoting stored SHA to full length', () => {
    // 1. Short SHA first -> Full SHA second (promotes stored snapshot_id to 40 chars)
    const shortFirst = db.fileComplaint(
      'Sylwia',
      '0c19058',
      'security_vulnerability',
      'Short SHA filed first',
    );
    expect(shortFirst.created).toBe(true);
    expect(shortFirst.complaint.snapshot_id).toBe('0c19058');

    const fullSecond = db.fileComplaint(
      'sylwia',
      '0c1905850fde9d97bfbe9416097081d11f193626',
      'security_vulnerability',
      'Full 40-char SHA filed on subsequent run',
    );
    expect(fullSecond.created).toBe(false);
    expect(fullSecond.complaint.id).toBe(shortFirst.complaint.id);
    expect(fullSecond.complaint.snapshot_id).toBe(
      '0c1905850fde9d97bfbe9416097081d11f193626',
    );

    // 2. Full SHA first -> Short SHA second (keeps stored 40-char snapshot_id)
    const fullFirst = db.fileComplaint(
      'Dusty McLegacy',
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      'reckless_practice',
      'Full 40-char SHA filed first',
    );
    expect(fullFirst.created).toBe(true);

    const shortSecond = db.fileComplaint(
      'Dusty McLegacy',
      'a1b2c3d',
      'reckless_practice',
      'Short 7-char prefix filed on second run',
    );
    expect(shortSecond.created).toBe(false);
    expect(shortSecond.complaint.id).toBe(fullFirst.complaint.id);
    expect(shortSecond.complaint.snapshot_id).toBe(
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    );

    expect(db.getStats().totalComplaints).toBe(2);
  });

  it('enforces defensive input validation directly in HrDatabase methods', () => {
    expect(() =>
      db.fileComplaint('   ', '0c19058', 'error_handling', 'Valid reason text'),
    ).toThrow(/developer name is required/i);

    expect(() =>
      db.fileComplaint(
        'Dusty McLegacy',
        'not-a-sha',
        'error_handling',
        'Valid reason text',
      ),
    ).toThrow(/7-40 character hex git SHA/i);

    expect(() =>
      db.fileComplaint(
        'Dusty McLegacy',
        '0c19058',
        'apocalyptic' as unknown as (typeof COMPLAINT_CATEGORIES)[number],
        'Valid reason text',
      ),
    ).toThrow(/invalid complaint category/i);

    expect(() =>
      db.fileComplaint('Dusty McLegacy', '0c19058', 'error_handling', 'tiny'),
    ).toThrow(/reason must be between 5 and 500 characters/i);

    expect(() =>
      db.fileComplaint(
        'Dusty McLegacy',
        '0c19058',
        'error_handling',
        'Valid reason text',
        'a'.repeat(301),
      ),
    ).toThrow(/file_path must be at most 300 characters/i);

    expect(() => db.nominateForPromotion('', 'Valid reason text')).toThrow(
      /developer name is required/i,
    );
    expect(() => db.nominateForPromotion('Ada Refactor', 'bad')).toThrow(
      /reason must be between 5 and 500 characters/i,
    );
  });

  it('allows distinct categories on the same snapshot_id and sums their weights', () => {
    const sec = db.fileComplaint(
      'Sylwia',
      '0c19058',
      'security_vulnerability',
      'Removed role verification in verifyToken',
    );
    const tests = db.fileComplaint(
      'Sylwia',
      '0c19058',
      'missing_tests',
      'No unit tests covering verifyToken changes',
    );

    expect(sec.created).toBe(true);
    expect(tests.created).toBe(true);
    expect(tests.complaint.id).not.toBe(sec.complaint.id);

    const stats = db.getStats();
    expect(stats.totalComplaints).toBe(2);
    expect(stats.totalWeight).toBe(13); // 10 + 3
    expect(stats.complaintsByCategory.security_vulnerability).toBe(1);
    expect(stats.complaintsByCategory.missing_tests).toBe(1);
  });

  it('persists data across a close/reopen cycle (real file, not in-memory)', () => {
    db.fileComplaint(
      'Dusty McLegacy',
      'a1b2c3d',
      'reckless_practice',
      'Friday deploy',
    );
    db.nominateForPromotion('Ada Refactor', 'Wrote tests unprompted');
    db.close();

    // Reopen the SAME file in a fresh instance — data must still be there.
    const reopened = new HrDatabase(dbPath);
    try {
      const complaints =
        reopened.getEmployeeRecord('Dusty McLegacy').complaints;
      const promotions = reopened.getEmployeeRecord('Ada Refactor').promotions;
      expect(complaints).toHaveLength(1);
      expect(complaints[0].category).toBe('reckless_practice');
      expect(complaints[0].weight).toBe(8);
      expect(promotions).toHaveLength(1);
    } finally {
      reopened.close();
      // Re-open for afterEach's close() to succeed.
      db = new HrDatabase(dbPath);
    }
  });

  it('computes aggregate stats and ranks mostComplainedAbout by weighted score', () => {
    // Casey gets 3 minor maintainability complaints (3 * 2 = 6 total weight).
    db.fileComplaint(
      'Casey Nullpointer',
      '1111111',
      'maintainability',
      'Var a',
    );
    db.fileComplaint(
      'Casey Nullpointer',
      '2222222',
      'maintainability',
      'Var b',
    );
    db.fileComplaint(
      'Casey Nullpointer',
      '3333333',
      'maintainability',
      'Var c',
    );

    // Dusty gets 1 security_vulnerability complaint (1 * 10 = 10 total weight).
    db.fileComplaint(
      'Dusty McLegacy',
      '4444444',
      'security_vulnerability',
      'Hardcoded secret token',
    );

    db.nominateForPromotion('Ada Refactor', 'Great work');
    db.nominateForPromotion('Ada Refactor', 'More great work');

    const stats = db.getStats();
    expect(stats.totalComplaints).toBe(4);
    expect(stats.totalWeight).toBe(16);
    expect(stats.totalPromotions).toBe(2);
    expect(stats.developersTracked).toBe(3); // Dusty, Casey, Ada
    expect(stats.mostComplainedAbout).toEqual({
      developer: 'Dusty McLegacy',
      count: 1,
      totalWeight: 10,
    });
    expect(stats.mostPromoted).toEqual({
      developer: 'Ada Refactor',
      count: 2,
    });
    expect(stats.complaintsByCategory.maintainability).toBe(3);
    expect(stats.complaintsByCategory.security_vulnerability).toBe(1);
    expect(stats.complaintsByCategory.reckless_practice).toBe(0);
  });

  it('automatically migrates a legacy v0 database (severity without commit_sha) to v2', () => {
    const legacyPath = join(dir, 'legacy-v0.db');
    const raw = new Database(legacyPath);
    raw.exec(`
      CREATE TABLE complaints (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        developer  TEXT NOT NULL,
        reason     TEXT NOT NULL,
        severity   TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO complaints (developer, reason, severity) VALUES
        ('  Dusty   McLegacy  ', 'Friday mega-push', ' LEGENDARY '),
        ('Casey Nullpointer', 'Swallowed error', 'severe'),
        ('Dusty McLegacy', 'Bad variable names', 'moderate'),
        ('Casey Nullpointer', 'Minor naming hazard', 'minor'),
        ('Casey Nullpointer', 'Mystery outage', 'catastrophic');
    `);
    raw.close();

    const migrated = new HrDatabase(legacyPath);
    try {
      const all = migrated.allComplaints();
      expect(all).toHaveLength(5);
      expect(migrated.getSchemaVersion()).toBe(2);
      expect(all.every((c) => c.file_path === '')).toBe(true);

      const byId = new Map(all.map((c) => [c.id, c]));
      expect(byId.get(1)?.developer).toBe('Dusty McLegacy');
      expect(byId.get(1)?.snapshot_id).toBe('legacy-000001');
      expect(byId.get(1)?.category).toBe('reckless_practice');
      expect(byId.get(1)?.weight).toBe(8);

      expect(byId.get(2)?.snapshot_id).toBe('legacy-000002');
      expect(byId.get(2)?.category).toBe('error_handling');
      expect(byId.get(2)?.weight).toBe(6);

      expect(byId.get(3)?.snapshot_id).toBe('legacy-000003');
      expect(byId.get(3)?.category).toBe('maintainability');
      expect(byId.get(3)?.weight).toBe(2);

      expect(byId.get(4)?.snapshot_id).toBe('legacy-000004');
      expect(byId.get(4)?.category).toBe('maintainability');
      expect(byId.get(4)?.weight).toBe(2);

      expect(byId.get(5)?.snapshot_id).toBe('legacy-000005');
      expect(byId.get(5)?.category).toBe('bug_or_regression');
      expect(byId.get(5)?.weight).toBe(5);

      // Verify idempotency constraint works on the migrated table.
      const firstNew = migrated.fileComplaint(
        'Dusty McLegacy',
        '0c19058',
        'bug_or_regression',
        'Off-by-one error',
      );
      const dupNew = migrated.fileComplaint(
        'dusty mclegacy',
        '0c19058',
        'bug_or_regression',
        'Duplicate off-by-one report',
      );
      expect(firstNew.created).toBe(true);
      expect(dupNew.created).toBe(false);
      expect(dupNew.complaint.id).toBe(firstNew.complaint.id);
    } finally {
      migrated.close();
    }
  });

  describe('reviewed-diff snapshot IDs and file_path granularity', () => {
    const SNAP_A = '0c19058:3f2a9b7c1d4e5f60';
    const SNAP_B = '0c19058:aa11bb22cc33dd44'; // same HEAD, different diff

    it('records complaints for two different diffs on the same HEAD without colliding', () => {
      const a = db.fileComplaint(
        'Sylwia',
        SNAP_A,
        'security_vulnerability',
        'Role check removed in verifyToken',
        'src/auth.ts',
      );
      const b = db.fileComplaint(
        'Sylwia',
        SNAP_B,
        'security_vulnerability',
        'Edited again without committing: token never expires',
        'src/auth.ts',
      );

      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
      expect(b.complaint.id).not.toBe(a.complaint.id);
      expect(a.complaint.snapshot_id).toBe(SNAP_A);
      expect(b.complaint.snapshot_id).toBe(SNAP_B);
      expect(db.getStats().totalComplaints).toBe(2);
    });

    it('deduplicates idempotently when the same snapshot is re-filed (case/whitespace-insensitive)', () => {
      const first = db.fileComplaint(
        'Sylwia',
        SNAP_A,
        'error_handling',
        'Swallowed error in db.ts',
        'src/db.ts',
      );
      const retry = db.fileComplaint(
        ' sylwia ',
        `  ${SNAP_A.toUpperCase()}  `,
        'error_handling',
        'Different wording on the re-run',
        'src/db.ts',
      );

      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.complaint.id).toBe(first.complaint.id);
      expect(retry.complaint.reason).toBe('Swallowed error in db.ts');
      expect(db.getStats().totalComplaints).toBe(1);
    });

    it('never prefix-matches a diff snapshot against a plain commit SHA of the same HEAD', () => {
      const snap = db.fileComplaint(
        'Sylwia',
        SNAP_A,
        'missing_tests',
        'No tests for the new middleware',
        'src/middleware.ts',
      );
      const commit = db.fileComplaint(
        'Sylwia',
        '0c19058',
        'missing_tests',
        'Reviewed as a closed commit by another MCP client',
        'src/middleware.ts',
      );

      expect(snap.created).toBe(true);
      expect(commit.created).toBe(true);
      expect(commit.complaint.snapshot_id).toBe('0c19058');
    });

    it('accepts unborn-HEAD snapshot IDs', () => {
      const res = db.fileComplaint(
        'Casey Nullpointer',
        'unborn:0123456789abcdef',
        'bug_or_regression',
        'Off-by-one before the first commit',
        'src/utils.ts',
      );
      expect(res.created).toBe(true);
    });

    it('rejects malformed snapshot IDs', () => {
      for (const bad of [
        '0c19058:xyz',
        '0c19058:abc', // hash part too short
        'legacy-000001', // legacy ids are storage-only, never valid input
        'HEAD',
      ]) {
        expect(() =>
          db.fileComplaint('Sylwia', bad, 'error_handling', 'Valid reason'),
        ).toThrow(/snapshot_id must be/i);
      }
    });

    it('records the same category in two different file_paths of the same snapshot', () => {
      const auth = db.fileComplaint(
        'Sylwia',
        SNAP_A,
        'security_vulnerability',
        'Role check removed in verifyToken',
        'src/auth.ts',
      );
      const dbFile = db.fileComplaint(
        'Sylwia',
        SNAP_A,
        'security_vulnerability',
        'SQL built by string concatenation',
        'src/db.ts',
      );

      expect(auth.created).toBe(true);
      expect(dbFile.created).toBe(true);
      expect(dbFile.complaint.id).not.toBe(auth.complaint.id);
      const stats = db.getStats();
      expect(stats.totalComplaints).toBe(2);
      expect(stats.totalWeight).toBe(20);
      expect(stats.complaintsByCategory.security_vulnerability).toBe(2);
    });

    it('deduplicates the same category + same (normalized) file_path in the same snapshot', () => {
      const first = db.fileComplaint(
        'Sylwia',
        SNAP_A,
        'security_vulnerability',
        'Role check removed (line 12) and token secret hardcoded (line 40)',
        'src/auth.ts',
      );
      const variants = [
        '  src/auth.ts ',
        './src/auth.ts',
        '/./src/auth.ts',
        'src//auth.ts',
        'src\\auth.ts',
      ];
      for (const path of variants) {
        const dup = db.fileComplaint(
          'Sylwia',
          SNAP_A,
          'security_vulnerability',
          'Second finding the LLM tried to file separately',
          path,
        );
        expect(dup.created).toBe(false);
        expect(dup.complaint.id).toBe(first.complaint.id);
        expect(dup.complaint.file_path).toBe('src/auth.ts');
      }
      expect(db.getStats().totalComplaints).toBe(1);
    });

    it('treats an omitted or separator-only file_path as "" (one general complaint per category per snapshot)', () => {
      const general = db.fileComplaint(
        'Sylwia',
        SNAP_A,
        'missing_tests',
        'No tests anywhere in this change',
      );
      expect(general.complaint.file_path).toBe('');
      for (const emptyVariant of ['', '   ', './', '/']) {
        const again = db.fileComplaint(
          'Sylwia',
          SNAP_A,
          'missing_tests',
          'Still no tests',
          emptyVariant,
        );
        expect(again.created).toBe(false);
        expect(again.complaint.id).toBe(general.complaint.id);
      }
    });
  });

  it('automatically migrates a v1 database (commit_sha, UNIQUE(developer, commit_sha, category)) to v2 without data loss', () => {
    const v1Path = join(dir, 'legacy-v1.db');
    const raw = new Database(v1Path);
    raw.exec(`
      CREATE TABLE complaints (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        developer  TEXT NOT NULL COLLATE NOCASE,
        commit_sha TEXT NOT NULL,
        category   TEXT NOT NULL CHECK (
          category IN (
            'security_vulnerability', 'reckless_practice', 'error_handling',
            'bug_or_regression', 'missing_tests', 'maintainability'
          )
        ),
        weight     INTEGER NOT NULL CHECK (weight > 0),
        reason     TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(developer, commit_sha, category)
      );
      CREATE TABLE promotions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        developer  TEXT NOT NULL COLLATE NOCASE,
        reason     TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_complaints_commit ON complaints(commit_sha);
      INSERT INTO complaints (id, developer, commit_sha, category, weight, reason, created_at) VALUES
        (3, 'Sylwia', '0c1905850fde9d97bfbe9416097081d11f193626', 'security_vulnerability', 10, 'Role check removed', '2026-01-01 10:00:00'),
        (7, 'Dusty McLegacy', 'legacy-000001', 'reckless_practice', 8, 'Friday mega-push', '2025-12-24 18:00:00');
      INSERT INTO promotions (developer, reason) VALUES ('Ada Refactor', 'Great refactor');
      PRAGMA user_version = 1;
    `);
    raw.close();

    const migrated = new HrDatabase(v1Path);
    try {
      expect(migrated.getSchemaVersion()).toBe(2);

      const all = migrated.allComplaints();
      expect(all).toHaveLength(2);
      const byId = new Map(all.map((c) => [c.id, c]));
      expect(byId.get(3)).toMatchObject({
        developer: 'Sylwia',
        snapshot_id: '0c1905850fde9d97bfbe9416097081d11f193626',
        category: 'security_vulnerability',
        file_path: '',
        weight: 10,
        reason: 'Role check removed',
        created_at: '2026-01-01 10:00:00',
      });
      expect(byId.get(7)).toMatchObject({
        snapshot_id: 'legacy-000001',
        file_path: '',
        weight: 8,
      });
      expect(migrated.allPromotions()).toHaveLength(1);

      // Re-filing the pre-migration complaint (short SHA, no file_path) is
      // still an idempotent match on the migrated row.
      const retry = migrated.fileComplaint(
        'sylwia',
        '0c19058',
        'security_vulnerability',
        'Re-run after upgrading',
      );
      expect(retry.created).toBe(false);
      expect(retry.complaint.id).toBe(3);

      // New rows continue after the highest migrated id and use the v2 key.
      const fresh = migrated.fileComplaint(
        'Sylwia',
        '0c1905850fde9d97bfbe9416097081d11f193626',
        'security_vulnerability',
        'Separate finding in another file',
        'src/db.ts',
      );
      expect(fresh.created).toBe(true);
      expect(fresh.complaint.id).toBe(8);
    } finally {
      migrated.close();
    }

    // Reopening an already-migrated v2 file is a no-op.
    const reopened = new HrDatabase(v1Path);
    try {
      expect(reopened.getSchemaVersion()).toBe(2);
      expect(reopened.allComplaints()).toHaveLength(3);
    } finally {
      reopened.close();
    }
  });

  it('reset() wipes all records', () => {
    db.fileComplaint(
      'Dusty McLegacy',
      'a1b2c3d',
      'maintainability',
      'Something bad',
    );
    db.nominateForPromotion('Ada Refactor', 'Something good');
    db.reset();

    const stats = db.getStats();
    expect(stats.totalComplaints).toBe(0);
    expect(stats.totalWeight).toBe(0);
    expect(stats.totalPromotions).toBe(0);
  });

  it('seedDemoData() produces reproducible fictional records', () => {
    db.seedDemoData();
    const first = db.getStats();

    db.seedDemoData(); // seeding again should reset + reseed to the same totals
    const second = db.getStats();

    expect(second.totalComplaints).toBe(first.totalComplaints);
    expect(second.totalWeight).toBe(first.totalWeight);
    expect(second.totalPromotions).toBe(first.totalPromotions);
    expect(first.totalComplaints).toBe(3);
    expect(first.totalWeight).toBe(16); // 8 + 2 + 6
  });

  it('exposes all six fixed complaint categories and their weights', () => {
    expect(COMPLAINT_CATEGORIES).toEqual([
      'security_vulnerability',
      'reckless_practice',
      'error_handling',
      'bug_or_regression',
      'missing_tests',
      'maintainability',
    ]);
    expect(CATEGORY_WEIGHTS).toEqual({
      security_vulnerability: 10,
      reckless_practice: 8,
      error_handling: 6,
      bug_or_regression: 5,
      missing_tests: 3,
      maintainability: 2,
    });
  });
});
