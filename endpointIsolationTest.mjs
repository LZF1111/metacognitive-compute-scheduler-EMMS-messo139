// Verify endpoint isolation: issue_attestation must be hidden+blocked in SCHEDULER mode
// and exposed in EXECUTOR mode. Drives server.mjs over stdio JSON-RPC.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dir, "server.mjs");

function rpc(child, msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function runMode(executorEnabled) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (executorEnabled) env.EMMS_EXECUTOR_ENDPOINT = "1";
    else delete env.EMMS_EXECUTOR_ENDPOINT;
    const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "inherit"] });
    const out = [];
    child.stdout.on("data", (b) => {
      for (const line of b.toString().split("\n")) {
        const s = line.trim();
        if (s) try { out.push(JSON.parse(s)); } catch {}
      }
    });
    rpc(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    rpc(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "issue_attestation", arguments: { exit_code: 0 } } });
    setTimeout(() => {
      child.kill();
      const list = out.find((m) => m.id === 2)?.result?.tools || [];
      const hasTool = list.some((t) => t.name === "issue_attestation");
      const callRes = out.find((m) => m.id === 3)?.result;
      const callBlocked = !!callRes?.isError;
      const callText = callRes?.content?.[0]?.text || "";
      resolve({ hasTool, callBlocked, callText });
    }, 800);
  });
}

const sched = await runMode(false);
const exec = await runMode(true);

let ok = true;
function check(label, cond) { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) ok = false; }

console.log("── SCHEDULER mode (default) ──");
check("issue_attestation hidden from tools/list", sched.hasTool === false);
check("issue_attestation call blocked", sched.callBlocked === true);
check("block message mentions executor-only", /executor-only/.test(sched.callText));

console.log("── EXECUTOR mode (EMMS_EXECUTOR_ENDPOINT=1) ──");
check("issue_attestation visible in tools/list", exec.hasTool === true);
check("issue_attestation call succeeds (signed token)", exec.callBlocked === false && /attestation|sig/.test(exec.callText));

console.log(ok ? "\nALL PASS" : "\nSOME FAILED");
process.exit(ok ? 0 : 1);
