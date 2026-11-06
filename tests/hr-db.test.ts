import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HrDatabase, SEVERITIES } from '../src/hr/hr-db.js';

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
    expect(stats.totalPromotions).toBe(0);
    expect(stats.developersTracked).toBe(0);
  });

  it('files a complaint and reads it back', () => {
    const created = db.fileComplaint('Dusty McLegacy', 'Swallowed an exception', 'severe');
    expect(created.id).toBeGreaterThan(0);
    expect(created.developer).toBe('Dusty McLegacy');
    expect(created.severity).toBe('severe');

    const record = db.getEmployeeRecord('Dusty McLegacy');
    expect(record.complaints).toHaveLength(1);
    expect(record.complaints[0].reason).toBe('Swallowed an exception');
    expect(record.promotions).toHaveLength(0);
  });

  it('records a promotion nomination', () => {
    db.nominateForPromotion('Ada Refactor', 'Deleted dead code');
    const record = db.getEmployeeRecord('Ada Refactor');
    expect(record.promotions).toHaveLength(1);
    expect(record.promotions[0].reason).toBe('Deleted dead code');
  });

  it('looks up developers case-insensitively and trims whitespace', () => {
    db.fileComplaint('  Casey   Nullpointer ', 'Logged "lol" on error', 'moderate');
    const record = db.getEmployeeRecord('casey nullpointer');
    expect(record.complaints).toHaveLength(1);
    // Name is normalized on write (trimmed + collapsed whitespace).
    expect(record.complaints[0].developer).toBe('Casey Nullpointer');
  });

  it('persists data across a close/reopen cycle (real file, not in-memory)', () => {
    db.fileComplaint('Dusty McLegacy', 'Friday deploy', 'legendary');
    db.nominateForPromotion('Ada Refactor', 'Wrote tests unprompted');
    db.close();

    // Reopen the SAME file in a fresh instance — data must still be there.
    const reopened = new HrDatabase(dbPath);
    try {
      const complaints = reopened.getEmployeeRecord('Dusty McLegacy').complaints;
      const promotions = reopened.getEmployeeRecord('Ada Refactor').promotions;
      expect(complaints).toHaveLength(1);
      expect(complaints[0].severity).toBe('legendary');
      expect(promotions).toHaveLength(1);
    } finally {
      reopened.close();
      // Re-open for afterEach's close() to succeed.
      db = new HrDatabase(dbPath);
    }
  });

  it('computes aggregate stats (totals, leaders, severity breakdown)', () => {
    db.fileComplaint('Dusty McLegacy', 'Thing one', 'minor');
    db.fileComplaint('Dusty McLegacy', 'Thing two', 'severe');
    db.fileComplaint('Casey Nullpointer', 'Thing three', 'minor');
    db.nominateForPromotion('Ada Refactor', 'Great work');
    db.nominateForPromotion('Ada Refactor', 'More great work');

    const stats = db.getStats();
    expect(stats.totalComplaints).toBe(3);
    expect(stats.totalPromotions).toBe(2);
    expect(stats.developersTracked).toBe(3); // Dusty, Casey, Ada
    expect(stats.mostComplainedAbout).toBe('Dusty McLegacy');
    expect(stats.mostPromoted).toBe('Ada Refactor');
    expect(stats.complaintsBySeverity.minor).toBe(2);
    expect(stats.complaintsBySeverity.severe).toBe(1);
    expect(stats.complaintsBySeverity.legendary).toBe(0);
  });

  it('reset() wipes all records', () => {
    db.fileComplaint('Dusty McLegacy', 'Something bad', 'moderate');
    db.nominateForPromotion('Ada Refactor', 'Something good');
    db.reset();

    const stats = db.getStats();
    expect(stats.totalComplaints).toBe(0);
    expect(stats.totalPromotions).toBe(0);
  });

  it('seedDemoData() produces reproducible fictional records', () => {
    db.seedDemoData();
    const first = db.getStats();

    db.seedDemoData(); // seeding again should reset + reseed to the same totals
    const second = db.getStats();

    expect(second.totalComplaints).toBe(first.totalComplaints);
    expect(second.totalPromotions).toBe(first.totalPromotions);
    expect(first.totalComplaints).toBeGreaterThan(0);
  });

  it('exposes all four severities', () => {
    expect(SEVERITIES).toEqual(['minor', 'moderate', 'severe', 'legendary']);
  });
});
