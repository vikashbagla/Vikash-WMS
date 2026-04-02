# WMS Ledger Engine — Logic & Calculations

**Version:** 1.0 | **Date:** 02-Apr-2026

---

## 1. Overview

The Ledger Engine tracks all money movement for each investor: manual cash entries, trade net amounts, interest bookings, and adjustments. It computes a running balance and uses that balance to calculate interest.

### Entry Types

| Type | Direction | Description |
|------|-----------|-------------|
| `CASH_RECEIVED` | **Credit** (+) | Money received from investor into the trading pool |
| `CASH_PAID` | **Debit** (−) | Money paid back to investor |
| `INTEREST_BOOKED` | **Credit** (+) | Interest charged to investor (added to their liability) |
| `ADJUSTMENT` | **Either** | Manual correction — sign as entered (positive = credit, negative = debit) |
| `TRADE` | **Either** | From transactions table — sign derived from `transaction_type`: BUY & RIGHTS_PAYMENT = debit (−), SELL/DIVIDEND/OTHER_INCOME/CAPITAL_REDUCTION = credit (+), HISTORICAL_PL = sign as stored |

---

## 2. Running Balance Calculation

The combined ledger merges `ledger_entries` rows and `transactions` rows, sorted by date ascending. On the same date, ledger entries sort before trades.

### Sign Convention

```
For each row:
  if CASH_RECEIVED or INTEREST_BOOKED → balance += |amount|
  if CASH_PAID                        → balance -= |amount|
  if ADJUSTMENT                       → balance += amount (sign preserved)
  if TRADE (BUY, RIGHTS_PAYMENT)      → balance -= |net_amount|  (debit — money out)
  if TRADE (SELL, DIVIDEND, etc.)     → balance += net_amount   (credit — money in)
  if TRADE (HISTORICAL_PL)            → balance += net_amount   (sign as stored in DB)
```

**Running balance** is cumulative: each row's balance = previous row's balance + this row's signed amount.

### Example

| # | Date | Type | Amount (DB) | Signed | Running Balance |
|---|------|------|-------------|--------|-----------------|
| 1 | 01-Jan | CASH_RECEIVED | 10,00,000 | +10,00,000 | **10,00,000** |
| 2 | 05-Jan | TRADE (BUY) | −2,50,000 | −2,50,000 | **7,50,000** |
| 3 | 10-Jan | TRADE (SELL) | +3,00,000 | +3,00,000 | **10,50,000** |
| 4 | 15-Jan | CASH_PAID | 1,00,000 | −1,00,000 | **9,50,000** |
| 5 | 31-Jan | INTEREST_BOOKED | 15,000 | +15,000 | **9,65,000** |

**Interpretation:** A positive running balance means the investor has a net credit position (money is owed by the trader/system to the investor). A negative balance means the investor owes money.

---

## 3. Interest Calculation

Interest is calculated on the **running ledger balance** over a specified date range.

### 3.1 Interest Terms (from DB)

Stored as JSONB `interest_terms` on both `investors` and `investor_broker_accounts`:

```json
{
  "rate": 18.0,
  "frequency": "weekly_friday",
  "compound": false
}
```

- **rate**: Annual interest rate as a percentage (18.0 = 18% p.a.)
- **frequency**: How often interest periods are calculated
- **compound**: If true, interest from prior periods is added to principal for subsequent periods

**Resolution priority:** Broker-account level `interest_terms` (if set with rate > 0) takes precedence over investor-level `interest_terms`.

### 3.2 Frequencies

| Frequency | Period Length | Description |
|-----------|-------------|-------------|
| `weekly_friday` | ~7 days | Each period runs from one date to the next Friday-aligned boundary |
| `monthly` | Calendar month | Period = 1st (or from-date) to last day of each month |
| `daily_monthly_compound` | Calendar month | Same as monthly, but `compound: true` adds prior interest to principal |
| `quarterly` | Calendar quarter | Period = start of quarter to end of quarter (Q1=Jan-Mar, Q2=Apr-Jun, etc.) |

### 3.3 Weighted-Average Daily Balance

For each interest period, we compute the **weighted-average daily balance** rather than using the closing balance. This gives a fairer picture when the balance changes during the period.

**Algorithm:**

```
Given: sorted ledger rows with _runningBalance, period [fromDate, toDate]

1. Find carry-forward balance = _runningBalance of the last row BEFORE fromDate
   (if no prior rows, carry-forward = 0)

2. Walk through rows within [fromDate, toDate]:
   - For each row, count the days the PREVIOUS balance was held
   - Multiply: days × previousBalance → add to weightedSum
   - Update the "current balance" to this row's _runningBalance

3. After the last row, count remaining days to toDate at the final balance
   - Multiply: remainingDays × lastBalance → add to weightedSum

4. Average = weightedSum ÷ totalDaysInPeriod
```

**Example:** Period = 01-Jan to 31-Jan (31 days)

| Date Range | Days | Balance | Weighted |
|------------|------|---------|----------|
| 01-Jan to 04-Jan | 4 | 10,00,000 | 40,00,000 |
| 05-Jan to 09-Jan | 5 | 7,50,000 | 37,50,000 |
| 10-Jan to 14-Jan | 5 | 10,50,000 | 52,50,000 |
| 15-Jan to 31-Jan | 17 | 9,50,000 | 1,61,50,000 |
| **Total** | **31** | | **2,91,50,000** |

Weighted Average Balance = 2,91,50,000 ÷ 31 = **9,40,322.58**

### 3.4 Simple Interest Formula

For each period:

```
Interest = |Average Balance| × (Rate / 100) × (Days / 365)
```

Using the example above with Rate = 18% p.a., Period = 31 days:

```
Interest = 9,40,322.58 × (18 / 100) × (31 / 365)
         = 9,40,322.58 × 0.18 × 0.08493
         = 14,371.84
```

### 3.5 Compound Interest (daily_monthly_compound)

When `compound: true`, the interest calculated for each period is added to the principal for the next period's calculation:

```
Period 1: avgBalance = computed from ledger
          interest₁ = avgBalance × rate × days₁/365

Period 2: avgBalance = computed from ledger + interest₁
          interest₂ = (avgBalance + interest₁) × rate × days₂/365

Period 3: avgBalance = computed from ledger + interest₁ + interest₂
          ...and so on
```

The compounded amount accumulates across periods. The total interest booked is the sum of all period interests.

### 3.6 Interest Booking

When the user clicks "Book Interest":

1. A single `INTEREST_BOOKED` entry is created in `ledger_entries`
2. `amount` = total interest across all periods
3. `entry_date` = the "To Date" of the interest period
4. `reference` = "Interest YYYY-MM-DD to YYYY-MM-DD"
5. This entry then becomes part of the running balance going forward

**Important:** Interest is booked as a **credit** (positive), meaning it increases the investor's balance. This represents interest owed to/by the investor depending on business context.

---

## 4. Margin Calculation

Margin is auto-calculated for F&O (Futures & Options) trades.

### Formula

```
margin_blocked = |net_amount| × (margin_rate / 100)
```

Where:
- `net_amount` = the trade's net amount from the transaction (after brokerage/charges)
- `margin_rate` = configured on `investor_broker_accounts.margin_rate` (stored as percentage, e.g., 10 = 10%)

### Example

- Trade net_amount = −2,50,000 (F&O buy)
- margin_rate = 10 (i.e., 10%)
- margin_blocked = |−2,50,000| × (10 / 100) = **25,000**

### When It's Applied

- Only for trades where `product = 'F&O'` or `product = 'FNO'`
- Auto-calculated in the transaction edit modal when charges are recalculated
- The `margin_blocked` field is saved on the transaction record
- Margin is NOT a separate ledger entry — it's a field on the trade itself

---

## 5. Ledger View (UI)

### Columns

| Column | Source | Description |
|--------|--------|-------------|
| Date | `entry_date` / `transaction_date` | Display format: DD-Mon-YY |
| Type | Badge | Color-coded: Cash In (green), Cash Out (red), Interest (purple), Adjust (amber), Trade (blue) |
| Investor | `investor_id` → name lookup | From wmsRefData |
| Broker | `broker_id` → name lookup | From wmsRefData |
| Debit | Negative amounts | Red, shown only when signedAmount < 0 |
| Credit | Positive amounts | Green, shown only when signedAmount > 0 |
| Balance | Running balance | Bold, red if negative |
| Reference/Notes | Combined | Reference + notes from the entry |
| Actions | Edit/Delete | Only for manual ledger entries (not trades) |

### Summary Footer

- **Total Debit**: Sum of all absolute debit amounts
- **Total Credit**: Sum of all credit amounts
- **Net Balance**: Credit − Debit
- **Entries**: Total row count

### Filters

- **Investor**: Dropdown (required — must select to view ledger)
- **Entry Type**: All Types, Cash Received, Cash Paid, Interest Booked, Adjustment, Trades Only
- **Date Range**: Last 30 Days, Last 90 Days (default), Last Year, All Time

---

## 6. Data Flow Diagram

```
┌─────────────────┐     ┌───────────────────┐
│  ledger_entries  │     │   transactions    │
│  (manual CRUD)   │     │  (from imports)   │
└────────┬────────┘     └────────┬──────────┘
         │                       │
         └───────┬───────────────┘
                 │
          wmsBuildLedger()
          (sort by date, compute
           signed amounts)
                 │
                 ▼
         ┌───────────────┐
         │ Combined Array │ ← each row has: date, entryType,
         │ with running   │   signedAmount, _runningBalance,
         │ balance        │   _rowType ('ledger' | 'trade')
         └───────┬───────┘
                 │
        ┌────────┼────────┐
        ▼        ▼        ▼
   Ledger Tab  Interest  Margin
   (display)   Calc      Calc
               │         │
               ▼         ▼
         wmsAvgBalance   wmsCalcMarginBlocked
         → periods       → margin_blocked
         → interest        on transaction
         → INTEREST_BOOKED
           entry
```

---

## 7. Key Functions Reference

| Function | File | Purpose |
|----------|------|---------|
| `wmsBuildLedger(entries, txns)` | wms-shared.js | Merge & sort entries + trades, compute running balance |
| `wmsAvgBalance(ledger, from, to)` | wms-shared.js | Weighted-average daily balance for a date range |
| `wmsCalcSimpleInterest(principal, rate, days)` | wms-shared.js | `principal × (rate/100) × (days/365)` |
| `wmsInterestPeriods(from, to, freq)` | wms-shared.js | Generate period boundaries for a frequency |
| `wmsCalcInterestPreview(ledger, terms, from, to)` | wms-shared.js | Full interest calc with period breakdown |
| `wmsGetInterestTerms(investorId, brokerId)` | wms-shared.js | Resolve interest terms (IBA > investor priority) |
| `wmsGetMarginRate(investorId, brokerId)` | wms-shared.js | Get margin_rate from IBA |
| `wmsCalcMarginBlocked(netAmount, marginRate)` | wms-shared.js | `|netAmount| × (marginRate / 100)` |
| `wmsDaysBetween(d1, d2)` | wms-shared.js | Inclusive day count between two dates |
| `trRefreshLedger()` | trading.js | Fetch entries + filter trades, build & render ledger |
| `trRenderLedger(rows)` | trading.js | Render the HTML table with debit/credit/balance |
| `trCalcInterestPreview()` | trading.js | UI handler: fetch data, calc preview, render table |
| `trConfirmBookInterest()` | trading.js | Save INTEREST_BOOKED entry to DB |
| `trRecalcMargin()` | trading.js | Auto-calc margin_blocked in transaction edit modal |
