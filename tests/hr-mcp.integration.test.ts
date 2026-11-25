import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { COMPLAINT_CATEGORIES } from '../hr-server/hr-db.js';
import {
  connectHrMcp,
  type HrMcpConnection,
} from '../src/mcp/hr-mcp-client.js';

/**
 * Real MCP client/server integration test — no mocks. connectHrMcp() spawns the
 * actual server over stdio, does the handshake, lists tools, and calls them:
 * the same path the agent uses at runtime. Spawning takes a moment, hence the
 * generous timeout.
 */
describe('HR MCP client/server integration', () => {
  let dir: string;
  let dbPath: string;
  let hr: HrMcpConnection;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'steve-hr-mcp-'));
    dbPath = join(dir, 'hr.db');
    hr = await connectHrMcp(dbPath);
  }, 30_000);

  afterAll(async () => {
    if (hr) await hr.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovers all four HR tools via listTools()', () => {
    const names = hr.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'file_complaint',
      'get_employee_record',
      'get_hr_stats',
      'nominate_for_promotion',
    ]);
  });

  it('exposes funny, non-empty descriptions and valid parameter schemas', () => {
    for (const tool of hr.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.isHrAction).toBe(true);
    }
    const complaint = hr.tools.find((t) => t.name === 'file_complaint');
    expect(complaint?.parameters?.properties?.developer).toBeDefined();
    expect(complaint?.parameters?.properties?.snapshot_id).toBeDefined();
    expect(complaint?.parameters?.properties?.category).toBeDefined();
    expect(complaint?.parameters?.properties?.category?.enum).toEqual([
      ...COMPLAINT_CATEGORIES,
    ]);
    expect(complaint?.parameters?.properties?.severity).toBeUndefined();
    expect(complaint?.parameters?.properties?.reason).toBeDefined();
  });

  it('files a complaint and reads it back through MCP (end to end)', async () => {
    const fileComplaint = tool('file_complaint');
    const getRecord = tool('get_employee_record');

    const fileResult = await fileComplaint.execute({
      developer: 'Sylwia',
      snapshot_id: '0c19058',
      category: 'reckless_practice',
      reason: 'Committed node_modules again',
    });
    expect(fileResult).toContain('Complaint #1');
    expect(fileResult).toContain('Sylwia');
    expect(fileResult).toContain('reckless_practice');
    expect(fileResult).toContain('weight=8');
    expect(fileResult).toContain('0c19058');

    const record = await getRecord.execute({ developer: 'Sylwia' });
    expect(record).toContain('Committed node_modules again');
    expect(record).toContain('reckless_practice');
    expect(record).toContain('weight=8');
    expect(record).toContain('0c19058');
  });

  it('reuses the existing complaint idempotently on retry or re-run without creating a duplicate', async () => {
    const fileComplaint = tool('file_complaint');
    const retryResult = await fileComplaint.execute({
      developer: 'sylwia',
      snapshot_id: '0C19058',
      category: 'reckless_practice',
      reason: 'Re-run 20 minutes later with different LLM phrasing',
    });

    expect(retryResult.startsWith('Error:')).toBe(false);
    expect(retryResult).toContain('Idempotent match');
    expect(retryResult).toContain('complaint #1');
    expect(retryResult).toContain('weight=8');

    // Also matches when re-run supplies the full 40-char SHA for the same 7-char prefix
    const fullShaRetry = await fileComplaint.execute({
      developer: 'Sylwia',
      snapshot_id: '0c1905850fde9d97bfbe9416097081d11f193626',
      category: 'reckless_practice',
      reason: 'Re-run with full 40-char SHA',
    });
    expect(fullShaRetry.startsWith('Error:')).toBe(false);
    expect(fullShaRetry).toContain('Idempotent match');
    expect(fullShaRetry).toContain('complaint #1');
    expect(fullShaRetry).toContain('on 0c19058');

    const stats = await tool('get_hr_stats').execute({});
    expect(stats).toContain('Total complaints:      1 (total weight: 8)');
  });

  it('nominates for promotion and reflects it in stats', async () => {
    await tool('nominate_for_promotion').execute({
      developer: 'Ada Refactor',
      reason: 'Turned a 500-line function into 5 readable ones',
    });

    const stats = await tool('get_hr_stats').execute({});
    expect(stats).toContain('Total promotions:');
    expect(stats).toContain('Ada Refactor');
  });

  it('returns a validation error (not a crash) for an invalid category', async () => {
    const result = await tool('file_complaint').execute({
      developer: 'Casey Nullpointer',
      snapshot_id: '0c19058',
      category: 'apocalyptic', // not a valid enum value
      reason: 'This reason is fine',
    });

    // MCP surfaces validation failures as isError results, which our client
    // renders with an "Error:" prefix — the model can read and react to it.
    expect(result.toLowerCase()).toContain('error');
  });

  it('returns a validation error for an invalid snapshot_id format', async () => {
    const nonHex = await tool('file_complaint').execute({
      developer: 'Casey Nullpointer',
      snapshot_id: 'not-a-sha',
      category: 'error_handling',
      reason: 'Swallowed an exception in catch block',
    });
    expect(nonHex.toLowerCase()).toContain('error');

    const tooShort = await tool('file_complaint').execute({
      developer: 'Casey Nullpointer',
      snapshot_id: '12345', // fewer than 7 hex chars
      category: 'error_handling',
      reason: 'Swallowed an exception in catch block',
    });
    expect(tooShort.toLowerCase()).toContain('error');

    const tooLong = await tool('file_complaint').execute({
      developer: 'Casey Nullpointer',
      snapshot_id: 'a'.repeat(41), // more than 40 hex chars
      category: 'error_handling',
      reason: 'Swallowed an exception in catch block',
    });
    expect(tooLong.toLowerCase()).toContain('error');
  });

  it('rejects a hallucinated plain commit SHA at the client harness when expectedSnapshotId is a commit SHA', async () => {
    const guarded = await connectHrMcp(dbPath, {
      expectedSnapshotId: '0c1905850fde9d97bfbe9416097081d11f193626',
    });
    try {
      const guardedFile = guarded.tools.find(
        (t) => t.name === 'file_complaint',
      )!;

      // Mismatched valid hex SHA is blocked before reaching the MCP server
      const mismatch = await guardedFile.execute({
        developer: 'Sylwia',
        snapshot_id: 'deadbeef',
        category: 'missing_tests',
        reason: 'Missing tests on new endpoint',
      });
      expect(mismatch).toContain(
        'Error: snapshot_id "deadbeef" does not match the reviewed snapshot "0c1905850fde9d97bfbe9416097081d11f193626"',
      );

      // Matching 7-char prefix of a plain commit SHA is allowed through
      const allowedPrefix = await guardedFile.execute({
        developer: 'Sylwia',
        snapshot_id: '0c19058',
        category: 'missing_tests',
        reason: 'Missing tests on new endpoint',
      });
      expect(allowedPrefix.startsWith('Error:')).toBe(false);
      expect(allowedPrefix).toContain('Complaint #2');
    } finally {
      await guarded.close();
    }
  });

  it('exposes snapshot_id and an optional file_path in the file_complaint schema', () => {
    const complaint = tool('file_complaint');
    expect(complaint.parameters?.properties?.file_path).toBeDefined();
    expect(complaint.parameters?.required).toContain('snapshot_id');
    expect(complaint.parameters?.required).not.toContain('file_path');
    expect(complaint.description).toContain('file_path');
    expect(complaint.description).toContain('consolidate');
  });

  it('files per-file complaints on a diff snapshot: same category in two files is recorded, same file is deduplicated idempotently', async () => {
    const fileComplaint = tool('file_complaint');
    const snapshot = 'b1c02da:0123456789abcdef';

    const auth = await fileComplaint.execute({
      developer: 'Dusty McLegacy',
      snapshot_id: snapshot,
      file_path: 'src/auth.ts',
      category: 'security_vulnerability',
      reason: 'Role check removed in verifyToken (line 12)',
    });
    expect(auth.startsWith('Error:')).toBe(false);
    expect(auth).toMatch(/Complaint #\d+ filed/);
    expect(auth).toContain(`on ${snapshot} in src/auth.ts`);

    const dbFile = await fileComplaint.execute({
      developer: 'Dusty McLegacy',
      snapshot_id: snapshot,
      file_path: 'src/db.ts',
      category: 'security_vulnerability',
      reason: 'SQL injection via string concatenation',
    });
    expect(dbFile.startsWith('Error:')).toBe(false);
    expect(dbFile).toMatch(/Complaint #\d+ filed/);

    const authId = /Complaint #(\d+)/.exec(auth)![1];
    const retry = await fileComplaint.execute({
      developer: 'dusty mclegacy',
      snapshot_id: snapshot.toUpperCase(),
      file_path: './src/auth.ts',
      category: 'security_vulnerability',
      reason: 'Same file, second finding the model tried to file separately',
    });
    expect(retry.startsWith('Error:')).toBe(false);
    expect(retry).toContain('Idempotent match');
    expect(retry).toContain(`complaint #${authId}`);

    const record = await tool('get_employee_record').execute({
      developer: 'Dusty McLegacy',
    });
    expect(record).toContain(`${snapshot} src/auth.ts`);
    expect(record).toContain(`${snapshot} src/db.ts`);
  });

  it('guards diff snapshots exactly via a getter and blocks filing before getDiff has produced one', async () => {
    let current: string | undefined;
    const guarded = await connectHrMcp(dbPath, {
      expectedSnapshotId: () => current,
    });
    try {
      const guardedFile = guarded.tools.find(
        (t) => t.name === 'file_complaint',
      )!;
      const args = {
        developer: 'Casey Nullpointer',
        snapshot_id: 'b1c02da:fedcba9876543210',
        file_path: 'src/utils.ts',
        category: 'bug_or_regression',
        reason: 'Off-by-one in pagination helper',
      };

      const beforeDiff = await guardedFile.execute(args);
      expect(beforeDiff).toContain('Error: no reviewed snapshot is available');

      current = 'b1c02da:aaaaaaaaaaaaaaaa'; // a different (newer) snapshot
      const stale = await guardedFile.execute(args);
      expect(stale).toContain(
        'does not match the reviewed snapshot "b1c02da:aaaaaaaaaaaaaaaa"',
      );

      current = 'b1c02da:fedcba9876543210';
      const ok = await guardedFile.execute(args);
      expect(ok.startsWith('Error:')).toBe(false);
      expect(ok).toMatch(/Complaint #\d+ filed/);

      // A plain HEAD SHA is NOT accepted in place of a diff snapshot.
      const headInstead = await guardedFile.execute({
        ...args,
        snapshot_id: 'b1c02da',
      });
      expect(headInstead).toContain('does not match the reviewed snapshot');

      // Omitting snapshot_id still surfaces MCP schema validation error.
      const missingSnapshot = await guardedFile.execute({
        developer: 'Casey Nullpointer',
        category: 'bug_or_regression',
        reason: 'Off-by-one in pagination helper',
      });
      expect(missingSnapshot.toLowerCase()).toContain('error');
    } finally {
      await guarded.close();
    }
  });

  it('returns a validation error for a too-short reason', async () => {
    const result = await tool('file_complaint').execute({
      developer: 'Casey Nullpointer',
      snapshot_id: '0c19058',
      category: 'maintainability',
      reason: 'x', // below the 5-char minimum
    });
    expect(result.toLowerCase()).toContain('error');
  });

  function tool(name: string) {
    const found = hr.tools.find((t) => t.name === name);
    if (!found) throw new Error(`tool ${name} not found`);
    return found;
  }
});
