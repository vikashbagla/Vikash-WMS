#!/usr/bin/env bash
# Phase-C accounting engine gate — runs all accounting tests. Node only, no deps.
#   ./tests/run-accounting-tests.sh    (exit 1 on any failure)
set -e
cd "$(dirname "$0")"
echo "— cg-classify —";        node cg-classify.test.mjs
echo "— accounting-engine —";  node accounting-engine.test.mjs
echo "— accounting-parity —";  node accounting-parity.test.mjs
echo "— accounting-ef-parity (server-side, real FIFO) —"; node accounting-ef-parity.test.mjs
echo "— accounting-worklist (new/changed/closed/orphan) —"; node accounting-worklist.test.mjs
echo "ALL ACCOUNTING TESTS PASSED"
