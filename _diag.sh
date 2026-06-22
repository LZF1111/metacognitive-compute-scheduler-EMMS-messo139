#!/bin/bash
cd ~/swebp/agent-eval || exit 1
RD=runs/run-3arm-20260622-104021
echo '=== summary.json ==='
cat "$RD/summary.json" 2>/dev/null; echo
echo '=== run dir tree ==='
ls -laR "$RD" | head -60
echo '=== eval jsonl files (size + head) ==='
for f in $(find "$RD" -name 'eval_*.jsonl' 2>/dev/null); do
  echo "-- $f size=$(wc -c < "$f")"
  head -c 250 "$f"; echo
done
echo '=== patches files ==='
for f in $(find "$RD" -name 'patches_*.json' 2>/dev/null); do
  echo "-- $f size=$(wc -c < "$f")"
done
echo '=== judge / harness invocation in runBench.mjs ==='
grep -n 'raw_sample\|eval_.*jsonl\|read_json\|predictions\|swe_bench_pro_eval\|judge\|spawnSync\|execFileSync\|spawn\|\.py' runBench.mjs | head -40
echo '=== how eval jsonl is written ==='
grep -n 'eval_\|writeFileSync\|jsonl\|\\n' runBench.mjs | head -40
