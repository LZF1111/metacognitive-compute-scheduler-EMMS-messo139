#!/bin/bash
cd ~/swebp/agent-eval || exit 1
echo "=== runBench judge() function (lines 147-180) ==="
sed -n '147,185p' runBench.mjs
echo
echo "=== swe_bench_pro_eval.py around line 460-480 ==="
sed -n '455,485p' ~/swebp/harness/swe_bench_pro_eval.py
echo
echo "=== what --predictions / args does the py expect? ==="
grep -n 'add_argument\|raw_sample_path\|predictions_path\|read_json\|args\.' ~/swebp/harness/swe_bench_pro_eval.py | head -40
echo
echo "=== re-run judge on conscious arm now (manual) to see live error ==="
EVAL=runs/run-3arm-20260622-104021/eval_conscious.jsonl
PRED=runs/run-3arm-20260622-104021/patches_conscious.json
OUT=/tmp/judge_retry_conscious
mkdir -p "$OUT"
echo "head of predictions file:"
head -c 200 "$PRED"; echo
