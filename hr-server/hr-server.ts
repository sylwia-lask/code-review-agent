import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { HrDatabase, SEVERITIES, type EmployeeRecord, type HrStats } from './hr-db.js';

/**
 * HR Department — a local MCP server.
 *
 * This process is launched by the agent as a child over stdio. It exposes four
 * tools backed by SQLite. There is deliberately NO AI / LLM code in here — the
 * server is pure data + validation. The "intelligence" (deciding when to file a
 * complaint) lives in the LLM on the client side.
 *
 * Tool descriptions are written for a comedic HR persona but are precise about
 * what each tool does, so the model uses them correctly.
 */
export function createHrServer(db: HrDatabase): McpServer {
  const server = new McpServer({
    name: 'hr-department',
    version: '1.0.0',
  });

  server.registerTool(
    'get_employee_record',
    {
      title: 'Pull an Employee HR File',
      description:
        "Open a developer's confidential HR file and read back every complaint " +
        'and promotion on record. Use this BEFORE judging someone — context is ' +
        'everything, and maybe they have a reason for naming everything `temp`. ' +
        'Returns an empty record for developers HR has never heard of (lucky them).',
      inputSchema: z.object({
        developer: z
          .string()
          .trim()
          .min(1, 'developer name is required')
          .max(100)
          .describe('Full name of the developer whose file you want to read.'),
      }),
    },
    async ({ developer }) => {
      const record = db.getEmployeeRecord(developer);
      return { content: [{ type: 'text', text: formatRecord(record) }] };
    },
  );

  server.registerTool(
    'file_complaint',
    {
      title: 'File a Formal Complaint',
      description:
        'Lodge an official HR complaint about genuinely poor code quality — ' +
        'think swallowed exceptions, copy-pasted security holes, or a 500-line ' +
        'function named `doStuff`. Be fair: this is for real problems, not style ' +
        'nitpicks. Severity escalates from "minor" (mild side-eye) through ' +
        '"moderate" and "severe" up to "legendary" (will be retold at standup ' +
        'for years). Every complaint is permanently stored.',
      inputSchema: z.object({
        developer: z
          .string()
          .trim()
          .min(1, 'developer name is required')
          .max(100)
          .describe('Who the complaint is about.'),
        reason: z
          .string()
          .trim()
          .min(5, 'give a real reason (at least 5 characters)')
          .max(500)
          .describe('What they did. Be specific; HR loves specifics.'),
        severity: z
          .enum(SEVERITIES)
          .describe(
            'How bad it is: minor | moderate | severe | legendary.',
          ),
      }),
    },
    async ({ developer, reason, severity }) => {
      const complaint = db.fileComplaint(developer, reason, severity);
      return {
        content: [
          {
            type: 'text',
            text:
              `📋 Complaint #${complaint.id} filed against ${complaint.developer} ` +
              `[${complaint.severity}]: ${complaint.reason}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'nominate_for_promotion',
    {
      title: 'Nominate for Promotion',
      description:
        'Recognize genuinely excellent work: a clean refactor, thoughtful tests, ' +
        'a bug caught before production, or code so readable it brought a tear to ' +
        "your eye. Credit where credit is due — Steve is sarcastic, not heartless. " +
        'The nomination is stored permanently in the developer HR file.',
      inputSchema: z.object({
        developer: z
          .string()
          .trim()
          .min(1, 'developer name is required')
          .max(100)
          .describe('Who deserves the praise.'),
        reason: z
          .string()
          .trim()
          .min(5, 'give a real reason (at least 5 characters)')
          .max(500)
          .describe('What they did that was actually good.'),
      }),
    },
    async ({ developer, reason }) => {
      const promotion = db.nominateForPromotion(developer, reason);
      return {
        content: [
          {
            type: 'text',
            text:
              `🏆 Promotion nomination #${promotion.id} recorded for ` +
              `${promotion.developer}: ${promotion.reason}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_hr_stats',
    {
      title: 'HR Department Dashboard',
      description:
        'Return department-wide statistics: total complaints and promotions, how ' +
        'many developers are on file, the current reigning champion of complaints, ' +
        'the most-promoted hero, and a breakdown of complaints by severity. Takes ' +
        'no arguments. Great for a dramatic opening line in a review.',
      inputSchema: z.object({}),
    },
    async () => {
      const stats = db.getStats();
      return { content: [{ type: 'text', text: formatStats(stats) }] };
    },
  );

  return server;
}

function formatRecord(record: EmployeeRecord): string {
  const lines: string[] = [`HR file for ${record.developer}:`];

  if (record.complaints.length === 0 && record.promotions.length === 0) {
    lines.push('  No records on file. A blank slate. For now.');
    return lines.join('\n');
  }

  lines.push(`  Complaints (${record.complaints.length}):`);
  if (record.complaints.length === 0) {
    lines.push('    (none)');
  } else {
    for (const c of record.complaints) {
      lines.push(`    #${c.id} [${c.severity}] ${c.reason} (${c.created_at})`);
    }
  }

  lines.push(`  Promotions (${record.promotions.length}):`);
  if (record.promotions.length === 0) {
    lines.push('    (none)');
  } else {
    for (const p of record.promotions) {
      lines.push(`    #${p.id} ${p.reason} (${p.created_at})`);
    }
  }

  return lines.join('\n');
}

function formatStats(stats: HrStats): string {
  const sev = stats.complaintsBySeverity;
  return [
    'HR Department — Statistics',
    `  Total complaints:   ${stats.totalComplaints}`,
    `  Total promotions:   ${stats.totalPromotions}`,
    `  Developers tracked: ${stats.developersTracked}`,
    `  Most complained about: ${stats.mostComplainedAbout ?? '(nobody yet)'}`,
    `  Most promoted:         ${stats.mostPromoted ?? '(nobody yet)'}`,
    `  By severity: minor=${sev.minor}, moderate=${sev.moderate}, severe=${sev.severe}, legendary=${sev.legendary}`,
  ].join('\n');
}

/**
 * stdio entry point. When this module is run directly (e.g. by the MCP client's
 * StdioClientTransport, or by MCP Inspector), start the server over stdio.
 *
 * We open the database inside the serveStdio factory so each server instance
 * owns its own connection. The server runs silently — stdout is reserved for
 * the JSON-RPC protocol and we keep stderr quiet so it stays a background tool.
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const invoked = process.argv[1].replace(/\\/g, '/');
  const self = import.meta.url.replace(/\\/g, '/');
  return self.endsWith(invoked) || self.endsWith(invoked.replace(/\.js$/, '.ts'));
}

if (isMainModule()) {
  serveStdio(() => {
    const db = new HrDatabase();
    return createHrServer(db);
  });
}
