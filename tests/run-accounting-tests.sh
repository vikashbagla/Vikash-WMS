#!/usr/bin/env bash
# Phase-C accounting engine gate — runs all accounting tests. Node only, no deps.
#   ./tests/run-accounting-tests.sh    (exit 1 on any failure)
set -e
cd "$(dirname "$0")"
echo "— cg-classify —";        node cg-classify.test.mjs
echo "— client income net of TDS —"; node check-client-income-tds.test.mjs
echo "— equity short: open on SELL, gain on cover —"; node check-equity-short.test.mjs
echo "— demerger: own holding only —"; node check-demerger-client.test.mjs
echo "— statements: dividend in booked P&L —"; node check-statement-dividend-booked.test.mjs
echo "— statements: income net of trade TDS —"; node check-statement-income-net-tds.test.mjs
echo "— statement ADJUSTMENT → PMS Settlement —"; node accounting-stmt-adjustment.test.mjs
echo "— accounting-engine —";  node accounting-engine.test.mjs
echo "— accounting-parity —";  node accounting-parity.test.mjs
echo "— accounting-ef-parity (server-side, real FIFO) —"; node accounting-ef-parity.test.mjs
echo "— accounting-worklist (new/changed/closed/orphan) —"; node accounting-worklist.test.mjs
echo "ALL ACCOUNTING TESTS PASSED"
