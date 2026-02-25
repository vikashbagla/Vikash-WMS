-- Migration 21: Saved portfolio views (quick-access filter combinations)
-- Each view stores a named combination of filters + view mode

CREATE TABLE IF NOT EXISTS portfolio_views (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    filters JSONB NOT NULL DEFAULT '{}',
    -- filters JSON structure:
    -- {
    --   "investorIds": ["uuid1", "uuid2"],
    --   "traderIds": ["uuid1"],
    --   "brokerIds": ["uuid1"],
    --   "tagNames": ["tag1", "tag2"],
    --   "tagLogic": "OR" | "AND",
    --   "viewMode": "default" | "holdings" | "fno"
    -- }
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE portfolio_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON portfolio_views FOR ALL USING (true) WITH CHECK (true);
