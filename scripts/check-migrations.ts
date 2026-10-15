/**
 * Expand/contract guard for database migrations (docs/decisions/0007-expand-contract-migrations.md).
 *
 * During a rolling deploy the previous release keeps running against the migrated schema, and a
 * rollback runs it there indefinitely. So a migration may only *expand* the schema; a step that
 * breaks old code (dropping, renaming, retyping, tightening) ships in a later release, once no
 * running code uses the old shape, and says so with `-- merchantflo:contract <reason>`.
 *
 * Run: npm run check:migrations (CI runs it on every push).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Migrations up to this number predate the rule (Phases 1–4) and are not checked. */
export const BASELINE = 16;

const MARKER = /--[ \t]*merchantflo:contract[ \t]+\S/;

const RULES: Array<[RegExp, string]> = [
  [/\bDROP\s+TABLE\b/i, 'drops a table'],
  [/\bDROP\s+COLUMN\b/i, 'drops a column'],
  [/\bRENAME\b/i, 'renames a table or column'],
  [/\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+(SET\s+DATA\s+)?TYPE\b/i, 'changes a column type'],
  [/\bSET\s+NOT\s+NULL\b/i, 'makes a column NOT NULL'],
];

/** Problems in one migration file; empty when it is safe for the previous release (or marked as a contract step). */
export function checkMigration(name: string, text: string): string[] {
  if (MARKER.test(text)) return [];
  const code = text.replace(/--[^\n]*/g, ''); // comments (and drizzle's statement-breakpoint markers)
  const problems: string[] = [];
  const flag = (what: string, statement: string) =>
    problems.push(`${name}: ${what} (\`${statement.trim().replace(/\s+/g, ' ').slice(0, 100)}\`) — the previous release still uses the old schema during a deploy and after a rollback. Expand now and contract in a later release, marking that migration with "-- merchantflo:contract <reason>".`);

  for (const statement of code.split(';')) {
    if (!statement.trim()) continue;
    const rule = RULES.find(([re]) => re.test(statement));
    if (rule) {
      flag(rule[1], statement);
      continue;
    }
    if (/\bADD\s+COLUMN\b/i.test(statement) && /\bNOT\s+NULL\b/i.test(statement) && !/\bDEFAULT\b/i.test(statement)) {
      flag('adds a NOT NULL column without a default', statement);
      continue;
    }
    const dropView = /\bDROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w.]+)/i.exec(statement);
    if (dropView) {
      const name = dropView[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Re-creating it in the same migration (with the old columns kept) is a replacement, not a removal.
      if (!new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+${name}`, 'i').test(code)) flag('drops a view', statement);
    }
  }
  return problems;
}

export function checkMigrations(files: Array<{ name: string; sql: string }>): string[] {
  return files.filter((f) => Number.parseInt(f.name, 10) > BASELINE).flatMap((f) => checkMigration(f.name, f.sql));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = new URL('../drizzle/', import.meta.url);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(new URL(name, dir), 'utf8') }));
  const problems = checkMigrations(files);
  for (const p of problems) console.error(p);
  console.log(problems.length ? `${problems.length} unsafe migration statement(s)` : `migrations OK (${files.length} files, checked after ${String(BASELINE).padStart(4, '0')})`);
  process.exit(problems.length ? 1 : 0);
}
