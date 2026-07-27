# CLAUDE.md — REDIRECT + CRITICAL RULES

## 🔱 REPOSITORY STRUCTURE — TWO REPOS (READ FIRST, 2026-07-27)

The project is split across **two** repositories to keep the strategy engine and infra private:

| Repo | Visibility | Contains | Deploys to |
|---|---|---|---|
| **`Vikash-WMS`** (this one) | **PUBLIC** | Browser **frontend only** — `*.html`, `*.js`, `*.css`, `icons/`, `mockups/` | GitHub Pages (main → prod) + Cloudflare (dev) |
| **`Vikash-WMS-backend`** | **PRIVATE** | `supabase/` (Edge Functions incl. the **MS007 GS engine** + migrations), `wms-live/` (Droplet order service), `tests/`, `analysis/`, `automation-validation/`, **`Documentation/`** | Manually (see below) |

**HARD RULE — never put server-side code in this public repo.** The MS007 engine, Edge Functions, migrations, live-order logic, tests, backtests, and all docs live **only** in the private `Vikash-WMS-backend` repo. This public repo must stay public (GitHub Pages requires it), so anything with strategy edge, infra detail, or secrets goes in the private repo. Both repos are cloned side-by-side under OneDrive `WMS Claude/`.

**Where to do what:**
- **Frontend change** → edit here (`Vikash-WMS`), follow the dev→main workflow below, GitHub Pages redeploys prod.
- **Engine / Edge Function / migration / backend / tests / docs** → edit in **`Vikash-WMS-backend`**. Deploy EFs by dragging the file into the Supabase dashboard; run migrations in Supabase Studio. See `Vikash-WMS-backend/Documentation/REPO-STRUCTURE-AND-PROTOCOL.md` for the full protocol.

**Canonical docs now live in the private repo** at `Vikash-WMS-backend/Documentation/`:
1. `CONTEXT.md` — architecture, files, functions, UI standards, TODO, Startup Prompt.
2. `SCHEMA.md` — DB tables, migrations, investor vs trader audit.
3. `LESSONS.md` — rules, patterns, settled decisions (hierarchical A.1.1 format).
4. `REPO-STRUCTURE-AND-PROTOCOL.md` — the two-repo split, deploy flows, backups, secret hygiene.

Module-level canonical docs (e.g. the Statements engine formulas) live inside `CONTEXT.md` under the relevant sub-module section — no separate per-module `.md` files.

---

## ⛔ CRITICAL: DEV/PROD GIT WORKFLOW (MANDATORY — READ EVERY SESSION)

**Two branches exist. Two live sites. One database. Violating these rules can break production.**

| | Production | Dev |
|---|---|---|
| Branch | `main` | `dev` |
| Site | vikashbagla.github.io/Vikash-WMS/ | vikash-wms.pages.dev |
| Data tables | `transactions`, `ledger_entries` | `transactions_dev`, `ledger_entries_dev` |
| Master data | Shared (investors, brokers, securities, IBAs, etc.) | Shared (same tables) |

### HARD RULES:

1. **ALL new code goes to the `dev` branch. NEVER push directly to `main`.** No exceptions. Not for "small fixes," not for "quick patches," not for "just this one thing."
2. **Code reaches `main` ONLY via a merge from `dev`, and ONLY after the owner explicitly approves.** Ask "Ready to push this to production?" and wait for a clear yes.
3. **When committing, always verify which branch you are pushing to.** Use `git push origin dev` — never `git push origin main` unless the owner has approved a production deploy in the current conversation.
4. **If the local repo is on `main` (lock file issues, fresh clone, etc.), push to dev explicitly:** `git push origin main:dev` does NOT work for this — you must push committed changes to `origin dev`. Use a temp clone on the `dev` branch if needed.
5. **Test on the dev site (vikash-wms.pages.dev) before any merge to main.**
6. **Database migrations:** Test on dev tables first. Only run against production tables after owner approval.
7. **Master data is shared.** Changes to investors, brokers, securities, IBAs, charges, portfolio_views affect BOTH sites. This is by design — but be aware of it.

### IF IN DOUBT:
- Push to `dev`. Always.
- Ask the owner before touching `main`.

See `WMS-LESSONS.md §A.8` for the full specification and `§B.20` for technical details.

---

**⚠️ NAMESPACE RULES:** The Trading → Statements module uses `lg` JS prefix and `ledger_*` DB tables. The Accounting module (when built) MUST use `ac` prefix and separate table names. See `WMS-LESSONS.md §A.6` for the full boundary specification — read this BEFORE writing any Accounting code.

**⚠️ EXPORT RULES:** All Excel exports MUST use linked formulas by default (not hardcoded values). Use the global `wmsExportExcel()` engine in `wms-export.js` — never build ad-hoc export code. See `WMS-LESSONS.md §A.7` for the full specification.
