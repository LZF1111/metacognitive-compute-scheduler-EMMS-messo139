#!/bin/bash
cd ~/swebp/harness || exit 1
echo "=== docker status ==="
docker ps >/dev/null 2>&1 && echo "docker OK" || echo "docker NOT available: $(docker ps 2>&1 | head -1)"
echo "=== docker images count ==="
docker images 2>/dev/null | wc -l
echo "=== secrets (dockerhub user) ==="
cat ~/swebp/agent-eval/secrets.local.json 2>/dev/null; echo
echo "=== run the EXACT judge command for conscious arm, capture full error ==="
EVAL=~/swebp/agent-eval/runs/run-3arm-20260622-104021/eval_conscious.jsonl
PRED=~/swebp/agent-eval/runs/run-3arm-20260622-104021/patches_conscious.json
OUT=/tmp/judge_retry
rm -rf "$OUT"; mkdir -p "$OUT"
DUSER=$(python3 -c "import json;print(json.load(open('/home/ss/swebp/agent-eval/secrets.local.json')).get('dockerhubUser','lzf'))" 2>/dev/null)
echo "dockerhub user = $DUSER"
timeout 120 python3 swe_bench_pro_eval.py \
  --raw_sample_path "$EVAL" \
  --patch_path "$PRED" \
  --output_dir "$OUT" \
  --scripts_dir ~/swebp/harness/run_scripts \
  --dockerhub_username "$DUSER" \
  --use_local_docker --num_workers 1 --redo 2>&1 | head -40
echo "=== exit / output dir ==="
ls -la "$OUT"
