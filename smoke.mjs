/**
 * smoke.mjs —— 起一个真实 MCP 客户端，spawn server.mjs，跑完整握手 + 多步任务，验证协议与决策。
 * 不依赖任何 SDK，自己按行收发 JSON-RPC，模拟"任意智能体如何调度这个框架"。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const srv = spawn(NODE, [path.join(__dir, "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const pending = new Map();
let nextId = 1;
srv.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) { srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
async function tool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result.structuredContent ?? JSON.parse(r.result.content[0].text);
}

const log = (...a) => console.log(...a);

(async () => {
  // 1) 握手
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  log("initialize →", init.result.serverInfo.name, init.result.serverInfo.version);
  notify("notifications/initialized", {});

  // 2) 列工具
  const list = await rpc("tools/list", {});
  log("tools/list →", list.result.tools.map((t) => t.name).join(", "));

  // 3) 开会话（用唯一 namespace 避免读到旧持久化，保证 smoke 可复现）
  const ns = "smoke-" + Date.now();
  const sid = "s1";
  log("open_session →", JSON.stringify(await tool("open_session", { sessionId: sid, namespace: ns })));

  // 4) 模拟一个 6 步任务：第 0、3 步是关键步(crit高)，其余普通。看核能否点燃在关键步。
  await tool("new_task", { sessionId: sid });
  const steps = [
    { criticality_hint: 0.9, difficulty_hint: 0.8, progress: 0.0, trueCrit: 0.9 }, // 关键
    { criticality_hint: 0.2, difficulty_hint: 0.2, progress: 0.2, trueCrit: 0.1 },
    { criticality_hint: 0.3, difficulty_hint: 0.3, progress: 0.4, trueCrit: 0.2 },
    { criticality_hint: 0.85, difficulty_hint: 0.7, progress: 0.6, trueCrit: 0.9 }, // 关键
    { criticality_hint: 0.2, difficulty_hint: 0.3, progress: 0.8, trueCrit: 0.15 },
    { criticality_hint: 0.25, difficulty_hint: 0.2, progress: 1.0, trueCrit: 0.1 },
  ];
  // 多跑几轮让它学（每轮同一个任务结构）
  for (let round = 0; round < 6; round++) {
    await tool("new_task", { sessionId: sid });
    let pollution = 0;
    const modes = [];
    for (const st of steps) {
      const d = await tool("decide_step", { sessionId: sid, ...st, context_pollution: pollution });
      modes.push(d.mode === "system2" ? "S2" : "s1");
      const usedS2 = d.mode === "system2";
      pollution = Math.min(1, pollution + (usedS2 ? 0.15 : 0.04));
      await tool("report_outcome", { sessionId: sid, ...st, observed_criticality: st.trueCrit, used_system2: usedS2, was_deep: usedS2 });
    }
    await tool("task_feedback", { sessionId: sid, success: true });
    if (round === 0 || round === 5) log(`round${round} 决策序列 [${modes.join(" ")}]  (期望: 关键步S2, 普通步s1)`);
  }

  log("get_stats →", JSON.stringify(await tool("get_stats", { sessionId: sid })));
  const dump = await tool("dump_prototypes", { sessionId: sid });
  log(`dump_prototypes → 原型数=${dump.prototypes.length}, μ=${dump.mu}`);
  dump.prototypes.forEach((p) => log(`   原型#${p.id} 质心=${JSON.stringify(p.situationCentroid)} n=${p.n} conf=${p.confidence}`));

  // 5) 验证持久化：关闭→新会话同 namespace→应能复用原型
  log("close_session →", JSON.stringify(await tool("close_session", { sessionId: sid })));
  const reopen = await tool("open_session", { sessionId: "s2", namespace: ns });
  log("reopen 同 namespace → loadedPrototypes =", reopen.loadedPrototypes, "(应 >0 = 技能持久化成功)");

  srv.stdin.end();
  setTimeout(() => process.exit(0), 100);
})().catch((e) => { console.error("SMOKE FAIL:", e); process.exit(1); });
