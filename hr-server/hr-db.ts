import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

/**
 * SQLite persistence for the (entirely fictional) HR Department. A plain data
 * layer with NO AI and NO MCP — the server sits on top of it. Tables are
 * created on first open; every write uses parameterized SQL.
 */

export const SEVERITIES = ['minor', 'moderate', 'severe', 'legendary'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Complaint {
  id: number;
  developer: string;
  reason: string;
  severity: Severity;
  created_at: string;
}

export interface Promotion {
  id: number;
  developer: string;
  reason: string;
  created_at: string;
}

export interface EmployeeRecord {
  developer: string;
  complaints: Complaint[];
  promotions: Promotion[];
}

export interface HrStats {
  totalComplaints: number;
  totalPromotions: number;
  developersTracked: number;
  mostComplainedAbout: string | null;
  mostPromoted: string | null;
  complaintsBySeverity: Record<Severity, number>;
}

/** HR_DB_PATH env var if set (tests point it at a temp file), else .hr-data/hr.db. */
export function resolveDbPath(): string {
  const fromEnv = process.env.HR_DB_PATH;
  if (fromEnv && fromEnv.trim()) {
    return resolve(fromEnv.trim());
  }
  return resolve(process.cwd(), '.hr-data', 'hr.db');
}

/** Owns one synchronous better-sqlite3 connection. Call close() when done. */
export class HrDatabase {
  private db: Database.Database;

  constructor(dbPath: string = resolveDbPath()) {
    // ":memory:" is used by some tests; only create a directory for real files.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createTables();
  }

  /** Create tables if they don't exist yet. Safe to call repeatedly. */
  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS complaints (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        developer  TEXT NOT NULL,
        reason     TEXT NOT NULL,
        severity   TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS promotions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        developer  TEXT NOT NULL,
        reason     TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_complaints_dev ON complaints(developer);
      CREATE INDEX IF NOT EXISTS idx_promotions_dev ON promotions(developer);
    `);
  }

  getEmployeeRecord(developer: string): EmployeeRecord {
    const name = normalizeName(developer);

    const complaints = this.db
      .prepare(
        `SELECT id, developer, reason, severity, created_at
         FROM complaints WHERE developer = ? COLLATE NOCASE
         ORDER BY id DESC`,
      )
      .all(name) as Complaint[];

    const promotions = this.db
      .prepare(
        `SELECT id, developer, reason, created_at
         FROM promotions WHERE developer = ? COLLATE NOCASE
         ORDER BY id DESC`,
      )
      .all(name) as Promotion[];

    return { developer: name, complaints, promotions };
  }

  fileComplaint(developer: string, reason: string, severity: Severity): Complaint {
    const name = normalizeName(developer);
    const info = this.db
      .prepare(
        `INSERT INTO complaints (developer, reason, severity) VALUES (?, ?, ?)`,
      )
      .run(name, reason.trim(), severity);

    return this.db
      .prepare(
        `SELECT id, developer, reason, severity, created_at FROM complaints WHERE id = ?`,
      )
      .get(info.lastInsertRowid) as Complaint;
  }

  nominateForPromotion(developer: string, reason: string): Promotion {
    const name = normalizeName(developer);
    const info = this.db
      .prepare(`INSERT INTO promotions (developer, reason) VALUES (?, ?)`)
      .run(name, reason.trim());

    return this.db
      .prepare(
        `SELECT id, developer, reason, created_at FROM promotions WHERE id = ?`,
      )
      .get(info.lastInsertRowid) as Promotion;
  }

  getStats(): HrStats {
    const totalComplaints = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM complaints`).get() as {
        c: number;
      }
    ).c;

    const totalPromotions = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM promotions`).get() as {
        c: number;
      }
    ).c;

    const developersTracked = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM (
             SELECT developer FROM complaints
             UNION
             SELECT developer FROM promotions
           )`,
        )
        .get() as { c: number }
    ).c;

    const mostComplainedAbout =
      (
        this.db
          .prepare(
            `SELECT developer FROM complaints
             GROUP BY developer ORDER BY COUNT(*) DESC LIMIT 1`,
          )
          .get() as { developer: string } | undefined
      )?.developer ?? null;

    const mostPromoted =
      (
        this.db
          .prepare(
            `SELECT developer FROM promotions
             GROUP BY developer ORDER BY COUNT(*) DESC LIMIT 1`,
          )
          .get() as { developer: string } | undefined
      )?.developer ?? null;

    const severityRows = this.db
      .prepare(
        `SELECT severity, COUNT(*) AS c FROM complaints GROUP BY severity`,
      )
      .all() as { severity: Severity; c: number }[];

    const complaintsBySeverity = Object.fromEntries(
      SEVERITIES.map((s) => [s, 0]),
    ) as Record<Severity, number>;
    for (const row of severityRows) {
      complaintsBySeverity[row.severity] = row.c;
    }

    return {
      totalComplaints,
      totalPromotions,
      developersTracked,
      mostComplainedAbout,
      mostPromoted,
      complaintsBySeverity,
    };
  }

  allComplaints(): Complaint[] {
    return this.db
      .prepare(
        `SELECT id, developer, reason, severity, created_at FROM complaints ORDER BY id DESC`,
      )
      .all() as Complaint[];
  }

  allPromotions(): Promotion[] {
    return this.db
      .prepare(
        `SELECT id, developer, reason, created_at FROM promotions ORDER BY id DESC`,
      )
      .all() as Promotion[];
  }

  /** Wipe all records. Used by the explicit reset command / tests. */
  reset(): void {
    this.db.exec(`DELETE FROM complaints; DELETE FROM promotions;`);
  }

  /**
   * Seed a small set of fictional demo records. Clears existing data first so
   * the demo is reproducible. All names are invented HR-comedy characters.
   */
  seedDemoData(): void {
    this.reset();

    const insertComplaint = this.db.prepare(
      `INSERT INTO complaints (developer, reason, severity) VALUES (?, ?, ?)`,
    );
    const insertPromotion = this.db.prepare(
      `INSERT INTO promotions (developer, reason) VALUES (?, ?)`,
    );

    const seed = this.db.transaction(() => {
      insertComplaint.run(
        'Dusty McLegacy',
        'Pushed a 2,000-line "quick fix" directly to main on a Friday.',
        'legendary',
      );
      insertComplaint.run(
        'Dusty McLegacy',
        'Named three different variables `data`, `data2`, and `dataFinal`.',
        'moderate',
      );
      insertComplaint.run(
        'Casey Nullpointer',
        'Caught a NullPointerException and logged "lol".',
        'severe',
      );
      insertPromotion.run(
        'Ada Refactor',
        'Deleted 4,000 lines of dead code and the build got faster.',
      );
      insertPromotion.run(
        'Ada Refactor',
        'Wrote tests before anyone asked. Unprompted. A legend.',
      );
      insertPromotion.run(
        'Casey Nullpointer',
        'Actually added error handling this time. Growth.',
      );
    });

    seed();
  }

  close(): void {
    this.db.close();
  }
}

/** Trim and collapse whitespace in a developer name for consistent lookups. */
function normalizeName(developer: string): string {
  return developer.trim().replace(/\s+/g, ' ');
}
