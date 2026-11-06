import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { connectHrMcp, type HrMcpConnection } from '../src/mcp/hr-mcp-client.js';

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
    expect(complaint?.parameters?.properties?.severity).toBeDefined();
  });

  it('files a complaint and reads it back through MCP (end to end)', async () => {
    const fileComplaint = tool('file_complaint');
    const getRecord = tool('get_employee_record');

    const fileResult = await fileComplaint.execute({
      developer: 'Dusty McLegacy',
      reason: 'Committed node_modules again',
      severity: 'legendary',
    });
    expect(fileResult).toContain('Complaint');
    expect(fileResult).toContain('Dusty McLegacy');

    const record = await getRecord.execute({ developer: 'Dusty McLegacy' });
    expect(record).toContain('Committed node_modules again');
    expect(record).toContain('legendary');
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

  it('returns a validation error (not a crash) for a bad severity', async () => {
    const result = await tool('file_complaint').execute({
      developer: 'Casey Nullpointer',
      reason: 'This reason is fine',
      severity: 'apocalyptic', // not a valid enum value
    });

    // MCP surfaces validation failures as isError results, which our client
    // renders with an "Error:" prefix — the model can read and react to it.
    expect(result.toLowerCase()).toContain('error');
  });

  it('returns a validation error for a too-short reason', async () => {
    const result = await tool('file_complaint').execute({
      developer: 'Casey Nullpointer',
      reason: 'x', // below the 5-char minimum
      severity: 'minor',
    });
    expect(result.toLowerCase()).toContain('error');
  });

  function tool(name: string) {
    const found = hr.tools.find((t) => t.name === name);
    if (!found) throw new Error(`tool ${name} not found`);
    return found;
  }
});
