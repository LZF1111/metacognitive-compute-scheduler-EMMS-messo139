#!/bin/bash
echo "=== all files under judge_retry ==="
find /tmp/judge_retry -type f
echo "=== json contents ==="
for j in $(find /tmp/judge_retry -name '*.json'); do
  echo ">> $j"
  head -c 600 "$j"; echo
done
echo "=== log files tail ==="
for l in $(find /tmp/judge_retry -name '*.log' -o -name '*.txt'); do
  echo ">> $l"
  tail -15 "$l"
done
