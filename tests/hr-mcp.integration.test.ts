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
    expect(complaint?.parameters?.properties?.commit_sha).toBeDefined();
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
      commit_sha: '0c19058',
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
      commit_sha: '0C19058',
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
      commit_sha: '0c1905850fde9d97bfbe9416097081d11f193626',
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
      commit_sha: '0c19058',
      category: 'apocalyptic', // not a valid enum value
      reason: 'This reason is fine',
    });

    // MCP surfaces validation failures as isError results, which our client
    // renders with an "Error:" prefix — the model can read and react to it.
    expect(result.toLowerCase()).toContain('error');
  });

  it('returns a validation error for an invalid commit_sha format', async () => {
    const nonHex = await tool('file_complaint').execute({
      developer: 'Casey Nullpointer',
      commit_sha: 'not-a-sha',
      category: 'error_handling',
      reason: 'Swallowed an exception in catch block',
    });
    expect(nonHex.toLowerCase()).toContain('error');

    const tooShort = await tool('file_complaint').execute({
      developer: 'Casey Nullpointer',
      commit_sha: '12345', // fewer than 7 hex chars
      category: 'error_handling',
      reason: 'Swallowed an exception in catch block',
    });
    expect(tooShort.toLowerCase()).toContain('error');

    const tooLong = await tool('file_complaint').execute({
      developer: 'Casey Nullpointer',
      commit_sha: 'a'.repeat(41), // more than 40 hex chars
      category: 'error_handling',
      reason: 'Swallowed an exception in catch block',
    });
    expect(tooLong.toLowerCase()).toContain('error');
  });

  it('rejects a hallucinated commit_sha at the client harness when expectedCommitSha is configured', async () => {
    const guarded = await connectHrMcp(dbPath, {
      expectedCommitSha: '0c1905850fde9d97bfbe9416097081d11f193626',
    });
    try {
      const guardedFile = guarded.tools.find(
        (t) => t.name === 'file_complaint',
      )!;

      // Mismatched valid hex SHA is blocked before reaching the MCP server
      const mismatch = await guardedFile.execute({
        developer: 'Sylwia',
        commit_sha: 'deadbeef',
        category: 'missing_tests',
        reason: 'Missing tests on new endpoint',
      });
      expect(mismatch).toContain(
        'Error: commit_sha "deadbeef" does not match current HEAD commit "0c1905850fde9d97bfbe9416097081d11f193626"',
      );

      // Matching 7-char prefix of expectedCommitSha is allowed through
      const allowedPrefix = await guardedFile.execute({
        developer: 'Sylwia',
        commit_sha: '0c19058',
        category: 'missing_tests',
        reason: 'Missing tests on new endpoint',
      });
      expect(allowedPrefix.startsWith('Error:')).toBe(false);
      expect(allowedPrefix).toContain('Complaint #2');
    } finally {
      await guarded.close();
    }
  });

  it('returns a validation error for a too-short reason', async () => {
    const result = await tool('file_complaint').execute({
      developer: 'Casey Nullpointer',
      commit_sha: '0c19058',
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
