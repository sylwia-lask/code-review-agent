import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {
  COMPLAINT_CATEGORIES,
  HrDatabase,
  type EmployeeRecord,
  type HrStats,
} from './hr-db.js';

/**
 * HR Department — a local MCP server.
 *
 * This process is launched by the agent as a child over stdio. It exposes four
 * tools backed by SQLite. There is deliberately NO AI / LLM code in here — the
 * server is pure data + validation. The "intelligence" (deciding when to file a
 * complaint) lives in the LLM on the client side, while policy (fixed category
 * weights and `(developer, commit_sha, category)` idempotency) is enforced here.
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
        'nitpicks. Pick one of the fixed offense categories (the server assigns ' +
        'its weight deterministically) and pass the reviewed Git `commit_sha`. ' +
        'Idempotent per `(developer, commit_sha, category)`: re-filing the same ' +
        'category on the same commit returns the existing record instead of ' +
        'creating a duplicate.',
      inputSchema: z.object({
        developer: z
          .string()
          .trim()
          .min(1, 'developer name is required')
          .max(100)
          .describe(
            'Name or handle of the developer who wrote the offending code.',
          ),
        commit_sha: z
          .string()
          .trim()
          .toLowerCase()
          .regex(
            /^[0-9a-f]{7,40}$/,
            'commit_sha must be a 7-40 character hex git SHA',
          )
          .describe(
            'Git commit SHA (7-40 hex chars) being reviewed, used for idempotency.',
          ),
        category: z
          .enum(COMPLAINT_CATEGORIES)
          .describe(
            'Offense category (mapped to fixed server-side weights): ' +
              'security_vulnerability (10: auth/authz bypasses, injection, secret leaks, exploitable security holes), ' +
              'reckless_practice (8: committing node_modules/secrets, unreviewed mega-pushes to main, destructive shortcuts), ' +
              'error_handling (6: swallowed exceptions, silent failures, mocking errors), ' +
              'bug_or_regression (5: logic errors, broken invariants, null dereferences, regressions), ' +
              'missing_tests (3: non-trivial behavior changes or bug-prone paths without tests), ' +
              'maintainability (2: severe readability/complexity hazards like 500-line functions or misleading names — NOT minor style nitpicks).',
          ),
        reason: z
          .string()
          .trim()
          .min(5, 'give a real reason (at least 5 characters)')
          .max(500)
          .describe(
            'Concrete description of the offense, ideally referencing file and line.',
          ),
      }),
    },
    async ({ developer, commit_sha, category, reason }) => {
      const { complaint, created } = db.fileComplaint(
        developer,
        commit_sha,
        category,
        reason,
      );
      const shortSha = complaint.commit_sha.slice(0, 7);

      const text = created
        ? `📋 Complaint #${complaint.id} filed against ${complaint.developer} ` +
          `[${complaint.category}, weight=${complaint.weight}] on ${shortSha}: ${complaint.reason}`
        : `ℹ️ Idempotent match: complaint #${complaint.id} already exists for ` +
          `${complaint.developer} on ${shortSha} [${complaint.category}, weight=${complaint.weight}]. ` +
          `Reused existing record without creating a duplicate.`;

      return {
        content: [
          {
            type: 'text',
            text,
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
        'your eye. Credit where credit is due — Steve is sarcastic, not heartless. ' +
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
        'Return department-wide statistics: total complaints, total complaint weight, ' +
        'total promotions, how many developers are on file, the most complained-about ' +
        'developer (ranked by weighted score), the most-promoted hero, and a category ' +
        'breakdown of complaints. Takes no arguments. Great for a dramatic opening ' +
        'line in a review.',
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
      lines.push(
        `    - #${c.id} [${c.category}, weight=${c.weight}] (${c.commit_sha.slice(0, 7)}) ${c.reason} (${c.created_at})`,
      );
    }
  }

  lines.push(`  Promotions (${record.promotions.length}):`);
  if (record.promotions.length === 0) {
    lines.push('    (none)');
  } else {
    for (const p of record.promotions) {
      lines.push(`    - #${p.id} ${p.reason} (${p.created_at})`);
    }
  }

  return lines.join('\n');
}

function formatStats(stats: HrStats): string {
  const byCategory = Object.entries(stats.complaintsByCategory)
    .map(([cat, count]) => `${cat}=${count}`)
    .join(', ');

  const mostComplained = stats.mostComplainedAbout
    ? `${stats.mostComplainedAbout.developer} (${stats.mostComplainedAbout.count} complaints, weight=${stats.mostComplainedAbout.totalWeight})`
    : '(nobody yet)';

  const mostPromoted = stats.mostPromoted
    ? `${stats.mostPromoted.developer} (${stats.mostPromoted.count} promotions)`
    : '(nobody yet)';

  return [
    'HR Department — Statistics',
    `  Total complaints:      ${stats.totalComplaints} (total weight: ${stats.totalWeight})`,
    `  Total promotions:      ${stats.totalPromotions}`,
    `  Developers tracked:    ${stats.developersTracked}`,
    `  Most complained-about: ${mostComplained}`,
    `  Most promoted:         ${mostPromoted}`,
    `  Breakdown by category: ${byCategory || 'none'}`,
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
  return (
    self.endsWith(invoked) || self.endsWith(invoked.replace(/\.js$/, '.ts'))
  );
}

if (isMainModule()) {
  serveStdio(() => {
    const db = new HrDatabase();
    return createHrServer(db);
  });
}
