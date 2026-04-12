# CLAUDE.md — REDIRECT

**This file is NOT the primary context file.** It was created during a session but is redundant.

**Read these three files instead (on OneDrive, in the parent `WMS Claude/` folder):**
1. `WMS-CONTEXT.md` — architecture, files, functions, UI standards, NEXT STEPS / TODO, recently resolved archive, and the copyable **Startup Prompt** at the end of the file.
2. `WMS-SCHEMA.md` — DB tables, migrations, investor vs trader audit.
3. `WMS-LESSONS.md` — rules, patterns, settled decisions (hierarchical A.1.1 format).

Module-level canonical docs (e.g. the Statements engine formulas) live inside `WMS-CONTEXT.md` under the relevant sub-module section — no separate per-module `.md` files.

**⚠️ NAMESPACE RULES:** The Trading → Statements module uses `lg` JS prefix and `ledger_*` DB tables. The Accounting module (when built) MUST use `ac` prefix and separate table names. See `WMS-LESSONS.md §A.6` for the full boundary specification — read this BEFORE writing any Accounting code.
