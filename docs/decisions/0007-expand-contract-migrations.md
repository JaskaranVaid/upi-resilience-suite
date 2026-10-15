# 0007 — Migrations run once per deploy and only expand the schema

Date: 2026-10-15 · Status: Accepted

## Context
Until Phase 5 every process applied pending migrations when it started. In production the api and
worker services start several containers at once, and a rolling deploy runs the previous release
next to the new one for minutes; a rollback runs the previous release against the new schema for
as long as it takes to fix forward. Drizzle's migrator takes no lock of its own.

## Decision
- **One migration step per deploy.** The pipeline runs the image once with `ROLE=migrate`
  (`npm run db:migrate` locally) before it updates any service. On Postgres the step holds an
  advisory lock (`pg_advisory_lock(7221998431)`), so even two concurrent runs apply each migration once.
  If it fails, the deploy stops and the running services are untouched.
- **Production processes never migrate.** `MIGRATE_ON_START` defaults to false in production;
  api/worker check that the database has every migration their code needs and refuse to start
  otherwise ("database schema is behind this release … run the migrate task"). A database that is
  *ahead* of the code is accepted: that is a rollback.
- **Expand/contract.** A migration must keep the previous release working: add tables, nullable
  columns, columns with defaults, indexes, and views that keep their old columns. Dropping,
  renaming, retyping or tightening (`SET NOT NULL`, a `NOT NULL` column without a default) waits
  for a later release in which no running code uses the old shape, and that migration carries
  `-- merchantflo:contract <reason>`. `npm run check:migrations` enforces this in CI for every
  migration after `0016`.

## Consequences
- Rollback is "redeploy the previous image"; no down-migrations are written.
- A column rename takes three releases: add the new column and write both, backfill and read the
  new one, then drop the old one (marked as a contract step).
- Development and tests still migrate on start (PGlite, one process).
