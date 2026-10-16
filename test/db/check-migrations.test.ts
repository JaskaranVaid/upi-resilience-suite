import { describe, expect, it } from 'vitest';
import { checkMigration, checkMigrations } from '../../scripts/check-migrations.js';

describe('migration safety check (expand/contract)', () => {
  const file = '0017_example.sql';

  it('accepts additive changes', () => {
    expect(
      checkMigration(
        file,
        `CREATE TABLE "x" ("id" text PRIMARY KEY NOT NULL);--> statement-breakpoint
ALTER TABLE "debits" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "debits" ADD COLUMN "retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "debits_note" ON "debits" USING btree ("note");--> statement-breakpoint
CREATE OR REPLACE VIEW "v" AS SELECT 1;`,
      ),
    ).toEqual([]);
  });

  it.each([
    ['DROP TABLE', 'DROP TABLE "vendors";', 'drops a table'],
    ['DROP COLUMN', 'ALTER TABLE "merchants" DROP COLUMN "api_key_hash";', 'drops a column'],
    ['RENAME COLUMN', 'ALTER TABLE "debits" RENAME COLUMN "order_id" TO "order_ref";', 'renames'],
    ['RENAME TABLE', 'ALTER TABLE "debits" RENAME TO "autopay_debits";', 'renames'],
    ['type change', 'ALTER TABLE "debits" ALTER COLUMN "attempts" SET DATA TYPE bigint;', 'changes a column type'],
    ['type change (short form)', 'ALTER TABLE "debits" ALTER COLUMN "attempts" TYPE bigint;', 'changes a column type'],
    ['SET NOT NULL', 'ALTER TABLE "debits" ALTER COLUMN "order_id" SET NOT NULL;', 'makes a column NOT NULL'],
    ['NOT NULL column without default', 'ALTER TABLE "debits" ADD COLUMN "region" text NOT NULL;', 'adds a NOT NULL column without a default'],
    ['DROP VIEW', 'DROP VIEW "merchant_payments_v";', 'drops a view'],
  ])('flags %s', (_name, statement, problem) => {
    const problems = checkMigration(file, statement);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(problem);
    expect(problems[0]).toContain(file);
  });

  it('allows a view to be dropped and re-created in the same migration', () => {
    expect(checkMigration(file, 'DROP VIEW "merchant_payments_v";--> statement-breakpoint\nCREATE VIEW "merchant_payments_v" AS SELECT 1;')).toEqual([]);
  });

  it('ignores statements inside SQL comments', () => {
    expect(checkMigration(file, '-- we used to DROP TABLE "x" here\nCREATE TABLE "y" ("id" text);')).toEqual([]);
  });

  it('allows a deliberate contract step marked with a reason', () => {
    expect(checkMigration(file, '-- merchantflo:contract column unused since release 2026-11 (expand in 0017)\nALTER TABLE "debits" DROP COLUMN "note";')).toEqual([]);
  });

  it('does not accept the marker without a reason', () => {
    expect(checkMigration(file, '-- merchantflo:contract\nALTER TABLE "debits" DROP COLUMN "note";')).toHaveLength(1);
  });

  it('skips migrations up to the baseline (written before the rule existed)', () => {
    const files = [
      { name: '0011_drop_merchant_key_hash.sql', sql: 'ALTER TABLE "merchants" DROP COLUMN "api_key_hash";' },
      { name: '0017_new.sql', sql: 'ALTER TABLE "merchants" DROP COLUMN "name";' },
    ];
    const problems = checkMigrations(files);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('0017_new.sql');
  });
});
