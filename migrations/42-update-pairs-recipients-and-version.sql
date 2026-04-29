-- Migration 42 — update the seeded `pairs` strategy with the real recipients
-- (Vikash + Nikhar) and bump the version note.
--
-- Phase 3c lands the actual TS-ported pairs scanner. Until now the row had
-- just Vikash as the recipient (placeholder seed). Production alerts must
-- also reach Nikhar.
--
-- Safe to re-run.

UPDATE auto_strategies
SET recipients = '[
    {"name":"Vikash","email":"vikash.bagla@gmail.com"},
    {"name":"Nikhar","email":"nikhararora730@gmail.com"}
]'::jsonb,
    version = '11.0',
    updated_at = now()
WHERE name = 'pairs';

UPDATE auto_strategies_dev
SET recipients = '[
    {"name":"Vikash","email":"vikash.bagla@gmail.com"},
    {"name":"Nikhar","email":"nikhararora730@gmail.com"}
]'::jsonb,
    version = '11.0',
    updated_at = now()
WHERE name = 'pairs';

-- Sanity report
SELECT name, version, owner, enabled, execution_mode, recipients
FROM auto_strategies
WHERE name = 'pairs';
