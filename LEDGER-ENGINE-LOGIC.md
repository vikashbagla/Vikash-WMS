# WMS Ledger Engine — Logic & Calculations

**Version:** 2.0 | **Date:** 02-Apr-2026 | **Status:** Revised spec (v1 → v2 rewrite)

---

## 1. Overview

The Ledger Engine tracks all money movement for each investor–trader–broker combination: opening balances, cash entries, trade amounts, F&O margin adjustments, and interest postings. It runs on a **financial year (FY) basis** per investor and supports **saved ledger views** (named filter combinations).

### Architecture

- **Separate module:** `ledger.html` + `ledger.js` (lazy-loaded when Ledger tab is activated, same pattern as F&O)
- **Shared engine functions:** `wms-shared.js` (calculations, period generation)
- **Saved views:** `ledger_views` table in Supabase (same pattern as `portfolio_views`)
- **Prefix:** All ledger module variables/functions use `lg` prefix

### Entry Types (DB: `ledger_entries.entry_type`)

| Type | Direction | Description |
|------|-----------|-------------|
| `OPENING_BALANCE` | **Either** | Starting balance for the FY. Positive = credit, Negative = debit |
| `CASH_RECEIVED` | **Credit** (+) | Money received from investor into the trading pool |
| `CASH_PAID` | **Debit** (−) | Money paid back to investor |
| `INTEREST_BOOKED` | **Credit** (+) | Interest charged to investor (added to their liability) |
| `ADJUSTMENT` | **Either** | Manual correction — sign as entered |

### Virtual Row Types (computed, not stored in DB)

| Type | Direction | Description |
|------|-----------|-------------|
| `TRADE` | **Either** | From `transactions` table — BUY/RIGHTS_PAYMENT = debit, SELL/DIVIDEND/etc. = credit |
| `MARGIN` | **Either** | F&O margin blocked/released — computed from NFO trades |

---

## 2. Financial Year & Dates

### FY Boundaries

- Each investor has `financial_year_start` (1-12) in the `investors` table. Default: 4 (April = Indian FY)
- FY runs from 1st of that month to last day of (month-1) next year
  - Example: `financial_year_start = 4` → FY 2025-26 = 01-Apr-2025 to 31-Mar-2026

### Opening Balance

- First entry in a ledger for any FY is an `OPENING_BALANCE`
- Represents the closing balance of the previous FY
- For the very first FY, opening balance = 0 (or manually set by user)
- Opening balance is a regular `ledger_entries` row with `entry_type = 'OPENING_BALANCE'`

### Date Filters

- **FY selector:** Dropdown to pick financial year (e.g., "FY 2025-26", "FY 2024-25")
- **From/To dates:** Within the selected FY, further narrow the date range
- Default view: Current FY, full date range

---

## 3. Running Balance Calculation

The combined ledger merges `ledger_entries` rows and `transactions` rows (filtered by the saved view's investor/trader/broker/tag filters), sorted by date ascending. On the same date, ledger entries sort before trades; within trades, sort by `created_at`.

### Sign Convention for Trades

The DB stores `net_amount` as positive for most transaction types. Sign is derived from `transaction_type`:

| Transaction Type | Direction | Rule |
|-----------------|-----------|------|
| BUY | Debit (−) | `balance -= |net_amount|` (money going out to buy) |
| RIGHTS_PAYMENT | Debit (−) | `balance -= |net_amount|` |
| SELL | Credit (+) | `balance += net_amount` (money coming in) |
| DIVIDEND | Credit (+) | `balance += net_amount` |
| OTHER_INCOME | Credit (+) | `balance += net_amount` |
| CAPITAL_REDUCTION | Credit (+) | `balance += net_amount` |
| HISTORICAL_PL | Either | `balance += net_amount` (sign as stored in DB) |
| BONUS | None | net_amount = 0, no cash impact |
| RIGHTS_ENTITLEMENT | None | net_amount = 0, no cash impact |

### Amount Used (Investor = Trader vs. Investor ≠ Trader)

- If `investor_id === trader_id`: use `net_amount` (includes all charges from investor's perspective)
- If `investor_id !== trader_id`: use `gross_amount + trader_charges` (the trader pays gross + their share of charges, not the investor's charges)

---

## 4. F&O Margin

### When Margin Applies

Margin is tracked for **NFO** trades (product field contains 'F&O', 'FNO', or 'NFO' — check case-insensitively). Check `security_type` as well if product is null — NFO securities have distinctive symbols.

### Margin Calculation

- **If investor = trader:** `margin = |net_amount| × (margin_rate / 100)`
- **If investor ≠ trader:** `margin = |gross_amount| × (trader_charges_rate)` — derived from the IBA margin_rate

### Margin Impact on Balance

- **Opening a position (BUY of futures, SELL of options):** Margin is ADDED to the balance (it's money blocked, considered as used capital)
- **FO Margin Adj column** in the ledger: Shows the margin adjustment separately (visible in the Excel sample)
- The margin amount is added to the running balance for interest calculation purposes

### FIFO Square-Off of Margin

When an F&O position is squared off:
1. Match the closing trade to the oldest open position for the same contract (FIFO)
2. The margin for the original position is **zeroed out** (not recalculated with new amounts)
3. The **net P&L** from the square-off (sell amount − buy amount for longs, or buy amount − sell amount for shorts) impacts the running balance
4. New margin is only computed if a new position is opened (e.g., rollover)

### Margin Column in Ledger

The ledger table has a dedicated "FO Margin Adj" column showing:
- Positive value when margin is newly blocked
- Negative value when margin is released (square-off)
- The cumulative margin adds to the "effective balance" used for interest calculation

---

## 5. Interest Calculation

### 5.1 Interest Terms

Stored as JSONB `interest_terms` on both `investors` and `investor_broker_accounts`:

```json
{
  "rate": 18.0,
  "frequency": "weekly_friday",
  "compound": false
}
```

**Resolution priority:** IBA-level (if set with rate > 0) > investor-level.

### 5.2 Key Rule: Interest Cannot Be Negative

Interest is always ≥ 0. If the balance is such that the investor is owed money (i.e., trader owes the investor), interest is NOT earned by the investor. Interest only accrues when the investor owes money to the trader/system (negative balance from the investor's credit perspective = positive outstanding).

### 5.3 `weekly_friday` Frequency

1. **Interest is calculated on the closing balance on the Friday of that week**
   - NOT weighted average — use the actual closing balance as of end-of-day Friday
2. **Interest is posted on Saturday** and increases the running balance from Saturday onwards
3. Formula: `interest = max(0, |closing_balance_friday|) × (rate / 100) × (7 / 365)`
   - If closing balance on Friday is such that investor has a credit (money owed TO them), interest = 0
4. The posted interest entry has `entry_date = Saturday (Friday + 1)`

### 5.4 `daily_monthly_compound` Frequency

1. **Interest is calculated on the daily closing balance** (adjusted only for trades and cash entries that day)
   - For each day: `daily_interest = max(0, |balance|) × (rate / 100) × (1 / 365)`
   - Only accrue interest on days where the balance indicates the investor owes money
2. **Aggregate interest for the month is posted on the 1st of the next month**
   - This INCREASES the balance → automatically compounds (next month's daily balances include prior interest)
3. The posted interest entry has `entry_date = 1st of next month`

### 5.5 `monthly` Frequency

1. Interest calculated on closing balance at month-end
2. `interest = max(0, |closing_balance|) × (rate / 100) × (days_in_month / 365)`
3. Posted on the 1st of next month

### 5.6 `quarterly` Frequency

1. Interest calculated on closing balance at quarter-end
2. Posted on 1st of next quarter
3. Quarters align to FY (if FY starts Apr: Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar)

### 5.7 Interest Detail & Posting Workflow

When the user **double-clicks an interest amount** in the ledger table:
1. A detail panel expands showing the calculation since the last interest posting:
   - For `weekly_friday`: the closing balance on that Friday, rate, days, calculated interest
   - For `daily_monthly_compound`: daily balances, daily interest amounts, total for the month
2. The user can **edit the final interest amount** if needed (override the calculated value)
3. Clicking "Post" creates an `INTEREST_BOOKED` entry in `ledger_entries`
4. Once posted, the entry is permanent and won't be recalculated (edit/delete available for corrections)

### 5.8 Interest Preview

Before posting, the "Book Interest" action shows a preview:
- Period breakdown with balance, days, rate, interest per period
- Total interest amount
- User can modify and then confirm posting

---

## 6. Saved Ledger Views

### Concept

Each "ledger" is a **saved view** — a named set of filters that determines which transactions appear. Same pattern as `portfolio_views` in the Trading module.

### `ledger_views` Table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | |
| name | TEXT NOT NULL | User-given name (e.g., "T2 Ledger", "T1 - CS Broker") |
| filters | JSONB | `{investorIds, traderIds, brokerIds, tagNames, tagLogic}` |
| sort_order | INT | Display order in tabs |
| is_default | BOOLEAN | Auto-applies on Ledger tab load |
| show_in_tabs | BOOLEAN | Whether visible as a tab |
| created_at | TIMESTAMPTZ | |

### Filter Structure

```json
{
  "investorIds": ["uuid1"],
  "traderIds": ["uuid2"],
  "brokerIds": [],
  "tagNames": [],
  "tagLogic": "OR"
}
```

### Expected Ledgers (from user)

- Investor: T0; Trader: T0; Brokers: All; Tags: All
- Investor: Any; Trader: T1; Brokers: All; Tags: All
- Investor: Any; Trader: T2; Brokers: All; Tags: All
- Investor: Any; Trader: T3; Brokers: All; Tags: All
- Investor: T0; Trader: T0; Brokers: CS (specific broker); Tags: All
- Investor: Any; Trader: Any; Brokers: TG (specific broker); Tags: All

### UI: View Tabs

Same tab bar pattern as Portfolio views (D.10 in WMS-LESSONS.md):
- Default view locked left with ★
- Non-default tabs with ✕ close on hover
- "Update" / "+ Save New" / "More ▼" action buttons
- Single-click to apply, double-click to rename

---

## 7. Ledger UI Layout

### 7.1 Overall Structure

```
┌─────────────────────────────────────────────────────────┐
│  View Tabs: [★ T2 Ledger] [T1 Ledger] [+] [More ▼]    │
├─────────────────────────────────────────────────────────┤
│  Filters: [Investor pills] [Trader pills] [Broker pills]│
│           [Tags] [FY: 2025-26 ▼] [From] [To]           │
├─────────────────────────────────────────────────────────┤
│  ENTRIES SECTION                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Date | Scrip | Product | Qty | Price | Net | Amount ││
│  │      |       |         |     |       |     | Balance││
│  │      |       |         |     |       | FO Margin Adj││
│  │ (inline editable for new entries)                   ││
│  └─────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────┤
│  CURRENT BALANCE SECTION                                 │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Summary:                                            ││
│  │   Holdings Value (Stocks: CMP × Qty)                ││
│  │ + MTM of F&O positions                              ││
│  │ − Outstanding liabilities (net of FO Margin)        ││
│  │ − Potential Tax (profit × tax_rate)                 ││
│  │ = Net Receivable / (Payable)                        ││
│  └─────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────┤
│  [Export PDF] [Export Excel]                             │
└─────────────────────────────────────────────────────────┘
```

### 7.2 Entries Table Columns (matching Excel sample)

| Column | Description |
|--------|-------------|
| Date | Transaction/entry date |
| Scrip | Company/stock name, or "Opening Balance", "Interest", "Cash" |
| Product | EQ, NFO, Op Ce/Pe, or blank |
| Qty | Quantity (signed: negative for sells) |
| Price | Price per unit |
| Net | Net price per unit (after charges) |
| Amount | Net amount for the row (signed) |
| Balance | Running balance |
| FO Margin Adj | Margin adjustment for NFO trades |

### 7.3 Inline Entry

- New entries are added directly in the table (no separate modal)
- An empty row at the bottom (or top) with input fields for each column
- On pressing Enter or Tab out of last field → entry is saved and table re-sorts by date
- Entry types: Cash (in/out), Adjustment, Opening Balance — determined by what's entered

### 7.4 Current Balance Section

Computed from holdings + F&O positions at current date:

```
Holdings Value = Σ (CMP × Qty) for all stocks held
MTM of F&O    = Σ (CMP − Avg Cost) × Qty for open F&O positions
Outstanding   = Running balance from ledger (net of FO margin)
Potential Tax = Total Profit for FY × tax_rate (from investor/IBA config)
Net Value     = Holdings Value + MTM − Outstanding − Potential Tax
```

### 7.5 Tax Rate

A new field `tax_rate` (NUMERIC, percentage) to be added to either `investors` or `investor_broker_accounts` table. Used for the "Potential Tax" calculation in the Current Balance section.

---

## 8. Export

### PDF Export
- Format matching the Excel sample layout
- Include: ledger entries, summary section, opening balances
- Suitable for sharing with traders/clients

### Excel Export
- Full data export matching the T2 Ledger Sample.xlsx format
- All columns, formulas where applicable
- Separate sections: Entries, Summary, Opening Balances

---

## 9. Key Functions Reference

| Function | File | Purpose |
|----------|------|---------|
| `wmsBuildLedger(entries, txns, opts)` | wms-shared.js | Merge & sort entries + trades, compute running balance + margin |
| `wmsCalcClosingBalance(ledger, date)` | wms-shared.js | Get closing balance on a specific date |
| `wmsCalcInterestWeeklyFriday(ledger, terms, from, to)` | wms-shared.js | Weekly friday interest calc |
| `wmsCalcInterestDailyMonthly(ledger, terms, from, to)` | wms-shared.js | Daily/monthly compound interest calc |
| `wmsCalcMarginFIFO(txns)` | wms-shared.js | FIFO margin tracking for F&O positions |
| `wmsGetInterestTerms(investorId, brokerId)` | wms-shared.js | Resolve interest terms (IBA > investor) |
| `wmsGetMarginRate(investorId, brokerId)` | wms-shared.js | Get margin_rate from IBA |
| `lgInit()` | ledger.js | Initialize ledger module (one-time) |
| `lgLoadViews()` | ledger.js | Load saved ledger views from DB |
| `lgApplyView(viewId)` | ledger.js | Apply a saved view's filters |
| `lgRefresh()` | ledger.js | Fetch data and render ledger |
| `lgRenderEntries(rows)` | ledger.js | Render the entries table |
| `lgRenderSummary()` | ledger.js | Render current balance section |
| `lgShowInterestDetail(entryId)` | ledger.js | Show interest calculation detail on dbl-click |
| `lgPostInterest(data)` | ledger.js | Post interest entry to DB |
| `lgExportPdf()` | ledger.js | Generate PDF export |
| `lgExportExcel()` | ledger.js | Generate Excel export |

---

## 10. DB Changes Required (Migration 33)

```sql
-- New entry type for opening balance
-- (entry_type is TEXT, no enum constraint — just add 'OPENING_BALANCE' in app code)

-- Ledger views table (same pattern as portfolio_views)
CREATE TABLE IF NOT EXISTS ledger_views (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    filters JSONB NOT NULL DEFAULT '{}',
    sort_order INT DEFAULT 0,
    is_default BOOLEAN DEFAULT false,
    show_in_tabs BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE ledger_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON ledger_views FOR ALL USING (true) WITH CHECK (true);

-- Tax rate on investors (percentage, e.g., 12.5)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 0;

-- Tax rate override on IBA (per broker account)
ALTER TABLE investor_broker_accounts ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 0;
```
