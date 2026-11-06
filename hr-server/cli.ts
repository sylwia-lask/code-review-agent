import { HrDatabase, resolveDbPath, type Complaint, type Promotion } from './hr-db.js';
import { colors, printHeader } from '../src/colors.js';

/**
 * Tiny CLI for inspecting and managing the (fictional) HR database directly,
 * without going through the MCP server or the LLM.
 *
 *   pnpm hr:show   → print all complaints and promotions as readable tables
 *   pnpm hr:reset  → wipe records and re-seed reproducible demo data
 *
 * Useful for the article: it proves the SQLite data is real and inspectable,
 * and gives readers a one-command way to reset the demo.
 */

function printTable(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log(colors.dim('  (no records)'));
    return;
  }

  // Compute column widths from headers + cells.
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );

  const renderRow = (cells: string[]) =>
    '  ' + cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  │  ');

  const separator =
    '  ' + widths.map((w) => '─'.repeat(w)).join('──┼──');

  console.log(colors.bold(renderRow(headers)));
  console.log(colors.dim(separator));
  for (const row of rows) {
    console.log(renderRow(row));
  }
}

/** Truncate long reasons so the table stays readable in a terminal. */
function truncate(text: string, max = 60): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function showRecords(db: HrDatabase): void {
  printHeader('HR Department — Records');
  console.log(colors.dim(`  Database: ${resolveDbPath()}\n`));

  const complaints: Complaint[] = db.allComplaints();
  const promotions: Promotion[] = db.allPromotions();

  console.log(colors.bold(colors.yellow('\n📋 Complaints')));
  printTable(
    ['ID', 'Developer', 'Severity', 'Reason', 'When'],
    complaints.map((c) => [
      String(c.id),
      c.developer,
      c.severity,
      truncate(c.reason),
      c.created_at,
    ]),
  );

  console.log(colors.bold(colors.green('\n🏆 Promotions')));
  printTable(
    ['ID', 'Developer', 'Reason', 'When'],
    promotions.map((p) => [
      String(p.id),
      p.developer,
      truncate(p.reason),
      p.created_at,
    ]),
  );

  const stats = db.getStats();
  console.log(
    colors.dim(
      `\n  ${stats.totalComplaints} complaints, ${stats.totalPromotions} promotions, ` +
        `${stats.developersTracked} developers on file.`,
    ),
  );
}

function resetRecords(db: HrDatabase): void {
  printHeader('HR Department — Reset');
  db.seedDemoData();
  console.log(
    colors.green('  ✅ Records wiped and reproducible demo data re-seeded.'),
  );
  console.log(colors.dim(`  Database: ${resolveDbPath()}`));
  console.log(colors.dim('  Run `pnpm hr:show` to see the fresh demo records.'));
}

function main(): void {
  const command = process.argv[2];
  const db = new HrDatabase();

  try {
    switch (command) {
      case 'show':
        showRecords(db);
        break;
      case 'reset':
        resetRecords(db);
        break;
      default:
        console.log('Usage: tsx hr-server/cli.ts <show|reset>');
        console.log('  show   — print all HR records as tables');
        console.log('  reset  — wipe records and re-seed demo data');
        process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main();
