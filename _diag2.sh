#!/bin/bash
cd ~/swebp/agent-eval || exit 1
F=runs/run-3arm-20260622-104021/eval_conscious.jsonl
echo "=== line count / last char ==="
wc -l "$F"
echo "--- tail bytes ---"
tail -c 80 "$F" | od -c | tail -5
echo "=== try pandas read_json lines=True ==="
python3 - "$F" <<'PY'
import sys, json
f=sys.argv[1]
# 1) line-by-line json.loads to find the offender
bad=0
with open(f,'r') as fh:
    for i,line in enumerate(fh,1):
        s=line.rstrip('\n')
        if not s.strip():
            print(f"  line {i}: EMPTY"); bad+=1; continue
        try:
            json.loads(s)
        except Exception as e:
            bad+=1
            print(f"  line {i}: JSON ERROR {e}  head={s[:80]!r}")
print("json.loads bad lines:", bad)
# 2) pandas
try:
    import pandas as pd
    df=pd.read_json(f, lines=True)
    print("pandas OK rows=", len(df), "cols=", list(df.columns)[:8])
except Exception as e:
    print("pandas FAIL:", repr(e))
PY
