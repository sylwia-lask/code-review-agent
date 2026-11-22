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
    expect(complaint.commit_sha).toBe('0c19058');
    expect(complaint.category).toBe('error_handling');
    expect(complaint.weight).toBe(CATEGORY_WEIGHTS.error_handling);

    const record = db.getEmployeeRecord('Dusty McLegacy');
    expect(record.complaints).toHaveLength(1);
    expect(record.complaints[0].reason).toBe('Swallowed an exception');
    expect(record.complaints[0].commit_sha).toBe('0c19058');
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

  it('enforces idempotency on (developer, commit_sha, category) even when reason changes', () => {
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

  it('deduplicates case-insensitively across developer name and commit_sha', () => {
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
    expect(second.complaint.commit_sha).toBe('abcdef1');

    const stats = db.getStats();
    expect(stats.totalComplaints).toBe(1);
    expect(stats.developersTracked).toBe(1);
  });

  it('allows distinct categories on the same commit_sha and sums their weights', () => {
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

  it('automatically migrates a legacy v0 database (severity without commit_sha) to v1', () => {
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
        ('Dusty McLegacy', 'Friday mega-push', 'legendary'),
        ('Casey Nullpointer', 'Swallowed error', 'severe'),
        ('Dusty McLegacy', 'Bad variable names', 'moderate'),
        ('Casey Nullpointer', 'Minor naming hazard', 'minor');
    `);
    raw.close();

    const migrated = new HrDatabase(legacyPath);
    try {
      const all = migrated.allComplaints();
      expect(all).toHaveLength(4);

      const byId = new Map(all.map((c) => [c.id, c]));
      expect(byId.get(1)?.commit_sha).toBe('legacy-000001');
      expect(byId.get(1)?.category).toBe('reckless_practice');
      expect(byId.get(1)?.weight).toBe(8);

      expect(byId.get(2)?.commit_sha).toBe('legacy-000002');
      expect(byId.get(2)?.category).toBe('error_handling');
      expect(byId.get(2)?.weight).toBe(6);

      expect(byId.get(3)?.commit_sha).toBe('legacy-000003');
      expect(byId.get(3)?.category).toBe('maintainability');
      expect(byId.get(3)?.weight).toBe(2);

      expect(byId.get(4)?.commit_sha).toBe('legacy-000004');
      expect(byId.get(4)?.category).toBe('maintainability');
      expect(byId.get(4)?.weight).toBe(2);

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
