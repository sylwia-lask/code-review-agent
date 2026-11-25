import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {
  COMMIT_SHA_PATTERN,
  COMPLAINT_CATEGORIES,
  HrDatabase,
  MAX_FILE_PATH_LENGTH,
  SNAPSHOT_ID_PATTERN,
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
 * weights and `(developer, snapshot_id, category, file_path)` idempotency) is
 * enforced here.
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
        'its weight deterministically), pass the `snapshot_id` of the reviewed ' +
        'code and the `file_path` of the offending file. ' +
        'Idempotent per `(developer, snapshot_id, category, file_path)`: ' +
        're-filing the same category for the same file in the same snapshot ' +
        'returns the existing record instead of creating a duplicate. ' +
        'Copy `file_path` LITERALLY from the diff header (the path after ' +
        '`+++ b/`, without the `b/` prefix) — never a free-form slug or a line ' +
        'number, which vary between runs and break deterministic idempotency. ' +
        'If one file has several findings of the same category, file ONE ' +
        'complaint for that file/category and consolidate all of them in `reason`.',
      inputSchema: z.object({
        developer: z
          .string()
          .trim()
          .min(1, 'developer name is required')
          .max(100)
          .describe(
            'Name or handle of the developer who wrote the offending code.',
          ),
        snapshot_id: z
          .string()
          .trim()
          .toLowerCase()
          .regex(
            SNAPSHOT_ID_PATTERN,
            'snapshot_id must be a getDiff Reviewed Snapshot ID (<head_short>:<diff_hash>) or a 7-40 character hex git SHA',
          )
          .describe(
            'Identity of the reviewed code, used for idempotency. Use the exact ' +
              '"Reviewed Snapshot ID" reported by getDiff (format ' +
              '`<head_short>:<diff_hash>`, a fingerprint of the full reviewed ' +
              'diff). Clients reviewing a closed commit may pass its 7-40 char ' +
              'hex Git commit SHA instead.',
          ),
        file_path: z
          .string()
          .trim()
          .max(MAX_FILE_PATH_LENGTH)
          .optional()
          .default('')
          .describe(
            'Repository-relative path of the offending file, copied literally ' +
              'from the diff header (e.g. `src/auth.ts` from `+++ b/src/auth.ts`). ' +
              'No line numbers. Omit only for findings that are not tied to a ' +
              'single file.',
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
            'Concrete description of the offense (line numbers welcome here). ' +
              'If the same file has several findings of this category, ' +
              'consolidate all of them in this single reason.',
          ),
      }),
    },
    async ({ developer, snapshot_id, file_path, category, reason }) => {
      const { complaint, created } = db.fileComplaint(
        developer,
        snapshot_id,
        category,
        reason,
        file_path,
      );
      const where =
        formatSnapshot(complaint.snapshot_id) +
        (complaint.file_path ? ` in ${complaint.file_path}` : '');

      const text = created
        ? `📋 Complaint #${complaint.id} filed against ${complaint.developer} ` +
          `[${complaint.category}, weight=${complaint.weight}] on ${where}: ${complaint.reason}`
        : `ℹ️ Idempotent match: complaint #${complaint.id} already exists for ` +
          `${complaint.developer} on ${where} [${complaint.category}, weight=${complaint.weight}]. ` +
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

/**
 * Short display form of a snapshot identity: plain commit SHAs are shortened to
 * 7 chars, `<head>:<hash>` diff snapshots and legacy ids are shown in full.
 */
function formatSnapshot(snapshotId: string): string {
  return COMMIT_SHA_PATTERN.test(snapshotId)
    ? snapshotId.slice(0, 7)
    : snapshotId;
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
        `    - #${c.id} [${c.category}, weight=${c.weight}] (${formatSnapshot(c.snapshot_id)}${c.file_path ? ` ${c.file_path}` : ''}) ${c.reason} (${c.created_at})`,
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
