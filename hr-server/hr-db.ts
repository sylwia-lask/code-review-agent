import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

/**
 * SQLite persistence for the (entirely fictional) HR Department. A plain data
 * layer with NO AI and NO MCP — the server sits on top of it. Tables are
 * created/migrated on first open; every write uses parameterized SQL.
 */

export const COMPLAINT_CATEGORIES = [
  'security_vulnerability',
  'reckless_practice',
  'error_handling',
  'bug_or_regression',
  'missing_tests',
  'maintainability',
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export const CATEGORY_WEIGHTS: Record<ComplaintCategory, number> = {
  security_vulnerability: 10,
  reckless_practice: 8,
  error_handling: 6,
  bug_or_regression: 5,
  missing_tests: 3,
  maintainability: 2,
};

/** A traditional Git commit SHA (short or full), e.g. from a closed-commit review. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * A reviewed working-tree snapshot as emitted by getDiff:
 * `<head_short>:<diff_sha256_prefix>` or `unborn:<diff_sha256_prefix>`.
 */
export const DIFF_SNAPSHOT_PATTERN =
  /^(?:[0-9a-f]{7,40}|unborn):[0-9a-f]{16,64}$/;

/** Valid `snapshot_id` input: either a diff snapshot or a plain Git commit SHA. */
export const SNAPSHOT_ID_PATTERN =
  /^(?:[0-9a-f]{7,40}|(?:[0-9a-f]{7,40}|unborn):[0-9a-f]{16,64})$/;

/** Max stored length of a complaint `file_path`. */
export const MAX_FILE_PATH_LENGTH = 300;

/** Current on-disk schema version (stored in PRAGMA user_version). */
export const SCHEMA_VERSION = 2;

export interface Complaint {
  id: number;
  developer: string;
  snapshot_id: string;
  category: ComplaintCategory;
  file_path: string;
  weight: number;
  reason: string;
  created_at: string;
}

export interface FileComplaintResult {
  complaint: Complaint;
  created: boolean;
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
  totalWeight: number;
  totalPromotions: number;
  developersTracked: number;
  mostComplainedAbout: {
    developer: string;
    count: number;
    totalWeight: number;
  } | null;
  mostPromoted: { developer: string; count: number } | null;
  complaintsByCategory: Record<ComplaintCategory, number>;
}

const COMPLAINT_COLUMNS = `id, developer, snapshot_id, category, file_path, weight, reason, created_at`;

/** DDL for the v2 complaints table (used for fresh DBs and migrations). */
function complaintsTableDdl(tableName: string): string {
  return `
    CREATE TABLE ${tableName} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      developer   TEXT NOT NULL COLLATE NOCASE,
      snapshot_id TEXT NOT NULL,
      category    TEXT NOT NULL CHECK (
        category IN (
          'security_vulnerability',
          'reckless_practice',
          'error_handling',
          'bug_or_regression',
          'missing_tests',
          'maintainability'
        )
      ),
      file_path   TEXT NOT NULL DEFAULT '',
      weight      INTEGER NOT NULL CHECK (weight > 0),
      reason      TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(developer, snapshot_id, category, file_path)
    );
  `;
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
    this.ensureSchema();
  }

  /**
   * Create v2 tables if they don't exist yet, or atomically migrate older
   * `complaints` tables into the v2 schema inside a single transaction:
   *   - v0: free-form `severity`, no `commit_sha` → mapped category + `legacy-NNNNNN` id
   *   - v1: `commit_sha` + `UNIQUE(developer, commit_sha, category)` → `commit_sha`
   *         copied verbatim into `snapshot_id`, `file_path = ''`
   * Every existing row (ids included) is preserved. Safe to call repeatedly.
   */
  private ensureSchema(): void {
    const migrate = this.db.transaction(() => {
      const existingCols = this.db
        .prepare(`PRAGMA table_info(complaints)`)
        .all() as { name: string }[];
      const has = (name: string) => existingCols.some((c) => c.name === name);

      const hasComplaintsTable = existingCols.length > 0;
      const isV2 = has('snapshot_id') && has('file_path');
      const isV1 = has('commit_sha') && has('category') && has('weight');

      if (!hasComplaintsTable) {
        this.db.exec(complaintsTableDdl('complaints'));
      } else if (isV2) {
        // Already up to date.
      } else if (isV1) {
        this.db.exec(complaintsTableDdl('complaints_v2'));
        this.db.exec(`
          INSERT INTO complaints_v2 (
            id, developer, snapshot_id, category, file_path, weight, reason, created_at
          )
          SELECT id, developer, commit_sha, category, '', weight, reason, created_at
          FROM complaints
          ORDER BY id ASC;

          DROP TABLE complaints;
          ALTER TABLE complaints_v2 RENAME TO complaints;
        `);
      } else {
        this.migrateFromV0();
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS promotions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          developer  TEXT NOT NULL COLLATE NOCASE,
          reason     TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_complaints_dev
          ON complaints(developer COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_complaints_snapshot
          ON complaints(snapshot_id);
        CREATE INDEX IF NOT EXISTS idx_promotions_dev
          ON promotions(developer COLLATE NOCASE);

        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    });

    migrate();
  }

  /** v0 (free-form `severity`, no commit identity) → v2. */
  private migrateFromV0(): void {
    const legacyRows = this.db
      .prepare(
        `SELECT id, developer, reason, severity, created_at FROM complaints ORDER BY id ASC`,
      )
      .all() as {
      id: number;
      developer: string;
      reason: string;
      severity: string | null;
      created_at: string;
    }[];

    this.db.exec(complaintsTableDdl('complaints_v2'));

    const insertLegacy = this.db.prepare(`
      INSERT INTO complaints_v2 (
        id, developer, snapshot_id, category, file_path, weight, reason, created_at
      ) VALUES (?, ?, ?, ?, '', ?, ?, ?)
    `);

    for (const row of legacyRows) {
      const normalizedDev = normalizeName(row.developer) || 'Unknown';
      const legacyId = `legacy-${String(row.id).padStart(6, '0')}`;
      const sev = String(row.severity ?? '')
        .trim()
        .toLowerCase();
      let category: ComplaintCategory;
      if (sev === 'legendary') {
        category = 'reckless_practice';
      } else if (sev === 'severe') {
        category = 'error_handling';
      } else if (sev === 'moderate' || sev === 'minor') {
        category = 'maintainability';
      } else {
        category = 'bug_or_regression';
      }
      const weight = CATEGORY_WEIGHTS[category];
      const cleanReason = (row.reason ?? '').trim() || '(legacy complaint)';

      insertLegacy.run(
        row.id,
        normalizedDev,
        legacyId,
        category,
        weight,
        cleanReason,
        row.created_at,
      );
    }

    this.db.exec(`
      DROP TABLE complaints;
      ALTER TABLE complaints_v2 RENAME TO complaints;
    `);
  }

  /** Current schema version recorded in the database file. */
  getSchemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  getEmployeeRecord(developer: string): EmployeeRecord {
    const name = normalizeName(developer);

    const complaints = this.db
      .prepare(
        `SELECT ${COMPLAINT_COLUMNS}
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

  /**
   * File a complaint, idempotent per `(developer, snapshot_id, category, file_path)`.
   *
   * `snapshotId` is either a reviewed-diff snapshot (`<head_short>:<hash>`, as
   * emitted by getDiff) or a plain Git commit SHA (for clients reviewing closed
   * commits). Plain commit SHAs additionally deduplicate short ↔ full prefixes;
   * diff snapshots must match exactly. Re-filing returns the existing record
   * with `created: false`.
   */
  fileComplaint(
    developer: string,
    snapshotId: string,
    category: ComplaintCategory,
    reason: string,
    filePath: string = '',
  ): FileComplaintResult {
    const name = normalizeName(developer);
    if (!name || name.length > 100) {
      throw new Error('developer name is required (1-100 characters)');
    }

    const snapshot = normalizeSnapshotId(snapshotId);
    const isCommitSha = COMMIT_SHA_PATTERN.test(snapshot);
    if (!isCommitSha && !DIFF_SNAPSHOT_PATTERN.test(snapshot)) {
      throw new Error(
        'snapshot_id must be a getDiff Reviewed Snapshot ID (<head_short>:<diff_hash>) or a 7-40 character hex git SHA',
      );
    }

    const weight = CATEGORY_WEIGHTS[category];
    if (typeof weight !== 'number') {
      throw new Error(`invalid complaint category: ${String(category)}`);
    }

    const cleanReason = reason.trim();
    if (cleanReason.length < 5 || cleanReason.length > 500) {
      throw new Error('reason must be between 5 and 500 characters');
    }

    const path = normalizeFilePath(filePath);
    if (path.length > MAX_FILE_PATH_LENGTH) {
      throw new Error(
        `file_path must be at most ${MAX_FILE_PATH_LENGTH} characters`,
      );
    }

    const tx = this.db.transaction((): FileComplaintResult => {
      const existing = isCommitSha
        ? // Plain commit SHA: also match stored short/full prefixes of the same
          // commit, but only against stored ids that are pure hex (never legacy
          // ids or `<head>:<hash>` diff snapshots).
          (this.db
            .prepare(
              `SELECT ${COMPLAINT_COLUMNS}
               FROM complaints
               WHERE developer = ? COLLATE NOCASE
                 AND category = ?
                 AND file_path = ?
                 AND (
                   snapshot_id = ?
                   OR (
                     snapshot_id NOT GLOB '*[^0-9a-f]*'
                     AND (
                       (length(snapshot_id) < length(?) AND substr(?, 1, length(snapshot_id)) = snapshot_id)
                       OR
                       (length(?) < length(snapshot_id) AND substr(snapshot_id, 1, length(?)) = ?)
                     )
                   )
                 )
               ORDER BY id ASC
               LIMIT 1`,
            )
            .get(
              name,
              category,
              path,
              snapshot,
              snapshot,
              snapshot,
              snapshot,
              snapshot,
              snapshot,
            ) as Complaint | undefined)
        : (this.db
            .prepare(
              `SELECT ${COMPLAINT_COLUMNS}
               FROM complaints
               WHERE developer = ? COLLATE NOCASE
                 AND category = ?
                 AND file_path = ?
                 AND snapshot_id = ?
               ORDER BY id ASC
               LIMIT 1`,
            )
            .get(name, category, path, snapshot) as Complaint | undefined);

      if (existing) {
        if (isCommitSha && snapshot.length > existing.snapshot_id.length) {
          this.db
            .prepare(`UPDATE complaints SET snapshot_id = ? WHERE id = ?`)
            .run(snapshot, existing.id);
          existing.snapshot_id = snapshot;
        }
        return { complaint: existing, created: false };
      }

      const info = this.db
        .prepare(
          `INSERT INTO complaints (developer, snapshot_id, category, file_path, weight, reason)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(developer, snapshot_id, category, file_path) DO NOTHING`,
        )
        .run(name, snapshot, category, path, weight, cleanReason);

      if (info.changes === 1) {
        const complaint = this.db
          .prepare(`SELECT ${COMPLAINT_COLUMNS} FROM complaints WHERE id = ?`)
          .get(info.lastInsertRowid) as Complaint;
        return { complaint, created: true };
      }

      const fallbackExisting = this.db
        .prepare(
          `SELECT ${COMPLAINT_COLUMNS}
           FROM complaints
           WHERE developer = ? COLLATE NOCASE
             AND snapshot_id = ?
             AND category = ?
             AND file_path = ?`,
        )
        .get(name, snapshot, category, path) as Complaint;

      return { complaint: fallbackExisting, created: false };
    });

    return tx();
  }

  nominateForPromotion(developer: string, reason: string): Promotion {
    const name = normalizeName(developer);
    if (!name || name.length > 100) {
      throw new Error('developer name is required (1-100 characters)');
    }
    const cleanReason = reason.trim();
    if (cleanReason.length < 5 || cleanReason.length > 500) {
      throw new Error('reason must be between 5 and 500 characters');
    }

    const info = this.db
      .prepare(`INSERT INTO promotions (developer, reason) VALUES (?, ?)`)
      .run(name, cleanReason);

    return this.db
      .prepare(
        `SELECT id, developer, reason, created_at FROM promotions WHERE id = ?`,
      )
      .get(info.lastInsertRowid) as Promotion;
  }

  getStats(): HrStats {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(weight), 0) AS w FROM complaints`,
      )
      .get() as { c: number; w: number };

    const totalComplaints = totals.c;
    const totalWeight = totals.w;

    const totalPromotions = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM promotions`).get() as {
        c: number;
      }
    ).c;

    const developersTracked = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM (
             SELECT LOWER(developer) AS dev FROM complaints
             UNION
             SELECT LOWER(developer) AS dev FROM promotions
           )`,
        )
        .get() as { c: number }
    ).c;

    const mostComplainedAbout =
      (this.db
        .prepare(
          `SELECT developer, COUNT(*) AS count, SUM(weight) AS totalWeight
           FROM complaints
           GROUP BY developer COLLATE NOCASE
           ORDER BY totalWeight DESC, count DESC, MIN(id) ASC
           LIMIT 1`,
        )
        .get() as
        | { developer: string; count: number; totalWeight: number }
        | undefined) ?? null;

    const mostPromoted =
      (this.db
        .prepare(
          `SELECT developer, COUNT(*) AS count
           FROM promotions
           GROUP BY developer COLLATE NOCASE
           ORDER BY count DESC, MIN(id) ASC
           LIMIT 1`,
        )
        .get() as { developer: string; count: number } | undefined) ?? null;

    const categoryRows = this.db
      .prepare(
        `SELECT category, COUNT(*) AS c FROM complaints GROUP BY category`,
      )
      .all() as { category: ComplaintCategory; c: number }[];

    const complaintsByCategory = Object.fromEntries(
      COMPLAINT_CATEGORIES.map((c) => [c, 0]),
    ) as Record<ComplaintCategory, number>;
    for (const row of categoryRows) {
      complaintsByCategory[row.category] = row.c;
    }

    return {
      totalComplaints,
      totalWeight,
      totalPromotions,
      developersTracked,
      mostComplainedAbout,
      mostPromoted,
      complaintsByCategory,
    };
  }

  allComplaints(): Complaint[] {
    return this.db
      .prepare(`SELECT ${COMPLAINT_COLUMNS} FROM complaints ORDER BY id DESC`)
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

    const seed = this.db.transaction(() => {
      this.fileComplaint(
        'Dusty McLegacy',
        'a1b2c3d',
        'reckless_practice',
        'Pushed a 2,000-line "quick fix" directly to main on a Friday.',
      );
      this.fileComplaint(
        'Dusty McLegacy',
        'b2c3d4e:9f86d081884c7d65',
        'maintainability',
        'Named three different variables `data`, `data2`, and `dataFinal`.',
        'src/utils.ts',
      );
      this.fileComplaint(
        'Casey Nullpointer',
        'c3d4e5f',
        'error_handling',
        'Caught a NullPointerException and logged "lol".',
      );
      this.nominateForPromotion(
        'Ada Refactor',
        'Deleted 4,000 lines of dead code and the build got faster.',
      );
      this.nominateForPromotion(
        'Ada Refactor',
        'Wrote tests before anyone asked. Unprompted. A legend.',
      );
      this.nominateForPromotion(
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

/** Trim and lowercase a snapshot ID / Git commit SHA for consistent deduplication keys. */
export function normalizeSnapshotId(snapshotId: string): string {
  return snapshotId.trim().toLowerCase();
}

/**
 * Normalize a repository-relative file path for deterministic dedup keys:
 * trim, `\` → `/`, collapse repeated slashes, drop leading `./` and `/`.
 * Case is preserved because Git paths are case-sensitive.
 */
export function normalizeFilePath(filePath: string | undefined): string {
  return (filePath ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(?:\/+|\.\/)+/, '');
}
