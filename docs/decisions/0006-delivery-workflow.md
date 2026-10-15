# 0006 — Delivery workflow

Date: 2026-10-15 · Status: Accepted

## Decision
- **Branches:** one branch per change (`phase/<n>-<topic>` for roadmap phases, `fix/…`, `feat/…`);
  `main` is always releasable. Merge through pull requests once CI passes.
- **CI:** GitHub Actions runs typecheck and the full test suite on every push and PR
  (`.github/workflows/ci.yml`). A red CI blocks merging.
- **Commits:** conventional commits (`feat(scope): …`, `fix(…)`, `docs`, `test`, `chore`), written in
  the present tense, describing behaviour. Commits are authored by the founder making them; no
  tool or AI attribution lines.
- **Specs and plans:** a design spec in `docs/superpowers/specs/` before non-trivial work, an
  implementation plan in `docs/superpowers/plans/`, and decisions here in `docs/decisions/`.
- **Line endings:** LF everywhere (`.gitattributes`), so Windows and macOS/Linux checkouts agree.
- **Ownership:** Founder 1 — infrastructure (`infra/`, `src/db`, workers, observability);
  Founder 2 — business logic (`src/rules`, `src/checkout`, `src/analytics`, `src/tracking`);
  Founder 3 — integrations (`src/psp`, `src/routing`, webhooks). Reviews cross divisions.

## Owner actions (GitHub settings, not in the repo)
Protect `main` (require PRs and the `CI` check), and turn on secret scanning and Dependabot alerts.
