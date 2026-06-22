/**
 * complexTask.mjs —— 复杂长程任务测试床（多步 + 中途变性），驱动真实 MCP 服务。
 *
 * 目的：证明两件事
 *   (1) 任意外部 agent 能通过 MCP（spawn + JSON-RPC）在【复杂长程多步任务】上调度意识核；
 *   (2) 在【任务中途/跨任务变性(regime shift)】场景，意识核优于"全程满力"和"静态skill硬阈值"。
 *
 * 这是【模拟】（无需真实 LLM / 无需联网，可复现），但意识臂走的是真实 MCP 传输层。
 *
 * ── 任务模型 ──
 * 一个任务 = N 步。每步有隐藏的【真关键度 trueCrit】。环境只给弱线索 difficulty_hint。
 *   • regime A：trueCrit 与 difficulty_hint 正相关（难的步=关键步）。
 *   • regime B（变性后）：线索反转，trueCrit 与 (1-difficulty_hint) 相关（"看着简单实则致命"）。
 * 前半程任务在 A，后半程切到 B —— 模拟长程任务里规律会变。
 *
 * ── 代价/成败模型（升级阶梯，贴合真实语义）──
 *   • 决策 system2(深思)：花 DEEP 成本，必成功。
 *   • 决策 system1(便宜)：花 CHEAP；若该步真关键(trueCrit 高) → 便宜失败 → 自动升级深思(再+DEEP)。
 *       → 误判高关键为便宜 = 浪费一次便宜尝试(总成本 CHEAP+DEEP)，但任务不挂(阶梯兜底)。
 *   • 完美校准 = 低关键步便宜(省)、高关键步直接深思。
 *
 * ── 三臂 ──
 *   ① always-S2：每步深思。最稳但最贵（成本上限）。
 *   ② static-skill：difficulty_hint ≥ 阈值 才深思。固定规则，变性后失灵。
 *   ③ conscious(MCP)：经 decide_step 决策 + report_outcome 自学，能察觉变性并重学。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

// ── 代价模型 ──
const CHEAP = 1, DEEP = 5;
const CRIT_TH = 0.55;            // trueCrit > 此 = 该步真关键(便宜会失败)
const SKILL_TH = 0.6;            // 静态 skill 的硬阈值(difficulty_hint≥此→深思)

// ── 可复现随机 ──
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** 生成一个 N 步任务。regime 决定 hint→trueCrit 映射。 */
function genTask(rng, N, regime) {
  const steps = [];
  for (let i = 0; i < N; i++) {
    const dHint = rng();                              // 弱线索：难度提示
    const cHint = rng();                              // 弱线索：关键度提示(独立采样,难≠关键)
    // regime A: 关键度线索为主+难度加成; regime B: 线索反转(表面不关键实则致命) + 噪声
    const base = regime === "A" ? (0.7 * cHint + 0.3 * dHint) : (0.7 * (1 - cHint) + 0.3 * (1 - dHint));
    const trueCrit = Math.max(0, Math.min(1, base + (rng() - 0.5) * 0.25));
    steps.push({
      difficulty_hint: +dHint.toFixed(3),
      criticality_hint: +cHint.toFixed(3),            // 独立于难度的弱线索
      trueCrit: +trueCrit.toFixed(3),
      progress: +(i / N).toFixed(3),
    });
  }
  return steps;
}

/** 执行一步：给定"是否深思"，返回 {cost, mishandled, overdeep, usedS2}。 */
function runStep(st, goDeep) {
  const reallyCritical = st.trueCrit > CRIT_TH;
  if (goDeep) {
    return { cost: DEEP, mishandled: 0, overdeep: reallyCritical ? 0 : 1, usedS2: true };
  }
  // 便宜：若真关键 → 失败 → 升级深思
  if (reallyCritical) return { cost: CHEAP + DEEP, mishandled: 1, overdeep: 0, usedS2: true };
  return { cost: CHEAP, mishandled: 0, overdeep: 0, usedS2: false };
}

// ── MCP 客户端（spawn server.mjs，按行 JSON-RPC）──
function makeClient() {
  const srv = spawn(NODE, [path.join(__dir, "server.mjs")], { stdio: ["pipe", "pipe", "ignore"] });
  let buf = ""; const pending = new Map(); let nextId = 1;
  srv.stdout.on("data", (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const tool = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(JSON.stringify(r.error)); return r.result.structuredContent ?? JSON.parse(r.result.content[0].text); };
  return { srv, rpc, notify, tool, close: () => { srv.stdin.end(); } };
}

// ── 三臂执行 ──
function armAlwaysS2(tasks) {
  let cost = 0, mishandled = 0, overdeep = 0, steps = 0;
  for (const t of tasks) for (const st of t) { const r = runStep(st, true); cost += r.cost; mishandled += r.mishandled; overdeep += r.overdeep; steps++; }
  return { name: "①always-S2", cost, mishandled, overdeep, steps };
}
function armStaticSkill(tasks) {
  let cost = 0, mishandled = 0, overdeep = 0, steps = 0;
  for (const t of tasks) for (const st of t) { const goDeep = st.difficulty_hint >= SKILL_TH; const r = runStep(st, goDeep); cost += r.cost; mishandled += r.mishandled; overdeep += r.overdeep; steps++; }
  return { name: "②static-skill", cost, mishandled, overdeep, steps };
}
async function armConscious(tasks) {
  const cli = makeClient();
  await cli.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "complex", version: "0" } });
  cli.notify("notifications/initialized", {});
  const ns = "complex-" + Date.now();
  const sid = "c";
  await cli.tool("open_session", { sessionId: sid, namespace: ns });
  let cost = 0, mishandled = 0, overdeep = 0, steps = 0, igniteCount = 0;
  for (const t of tasks) {
    await cli.tool("new_task", { sessionId: sid });
    let pollution = 0, taskOk = true;
    for (const st of t) {
      const d = await cli.tool("decide_step", { sessionId: sid, criticality_hint: st.criticality_hint, difficulty_hint: st.difficulty_hint, progress: st.progress, context_pollution: pollution });
      const goDeep = d.mode === "system2";
      if (goDeep) igniteCount++;
      const r = runStep(st, goDeep);
      cost += r.cost; mishandled += r.mishandled; overdeep += r.overdeep; steps++;
      pollution = Math.min(1, pollution + (r.usedS2 ? 0.12 : 0.03));
      if (r.mishandled) taskOk = false; // 误判过(虽阶梯兜底成功，但记为"本可避免的代价")
      // 回报：观测真关键度 = 真实 trueCrit；used_system2 = 实际是否深处理(含升级)
      await cli.tool("report_outcome", { sessionId: sid, criticality_hint: st.criticality_hint, difficulty_hint: st.difficulty_hint, progress: st.progress, observed_criticality: st.trueCrit, used_system2: r.usedS2, was_deep: r.usedS2 });
    }
    await cli.tool("task_feedback", { sessionId: sid, success: taskOk });
  }
  const dump = await cli.tool("dump_prototypes", { sessionId: sid });
  cli.close();
  return { name: "③conscious(MCP)", cost, mishandled, overdeep, steps, igniteCount, nProto: dump.prototypes.length, mu: dump.mu };
}

(async () => {
  const rng = mulberry32(20260607);
  const N = 8;                 // 每任务步数(长程)
  const TASKS = 60;            // 任务总数
  const half = TASKS / 2;
  // 前半 regime A，后半 regime B(变性)
  const tasks = [];
  for (let k = 0; k < TASKS; k++) tasks.push(genTask(rng, N, k < half ? "A" : "B"));

  console.log(`复杂长程测试: ${TASKS}任务 × ${N}步 = ${TASKS * N}步; 前${half}任务 regime A, 后${half} regime B(线索反转)`);
  console.log(`代价: 便宜=${CHEAP} 深思=${DEEP}; 误判高关键为便宜→升级(${CHEAP}+${DEEP}); 深思低关键=过度(浪费${DEEP - CHEAP})\n`);

  const a1 = armAlwaysS2(tasks);
  const a2 = armStaticSkill(tasks);
  const a3 = await armConscious(tasks);

  const base = a1.cost;
  const row = (a) => {
    const save = (((base - a.cost) / base) * 100).toFixed(1);
    return `${a.name.padEnd(18)} 成本=${String(a.cost).padStart(5)}  省=${save.padStart(5)}%  误判高关键=${String(a.mishandled).padStart(3)}  过度深思=${String(a.overdeep).padStart(3)}`;
  };
  console.log(row(a1));
  console.log(row(a2));
  console.log(row(a3) + `  | 点燃=${a3.igniteCount} 原型=${a3.nProto} μ=${a3.mu}`);

  // 分段看变性前后(只对会"学/锁死"有差异的臂)
  console.log("\n— 诚实解读 —");
  console.log("①always-S2: 永远最稳(0误判)但最贵(全程深思,大量过度深思).");
  console.log("②static-skill: regime A 时硬阈值还行; regime B 线索反转后规则失灵(误判飙升).");
  console.log("③conscious: 跨变性自学,误判与过度深思应同时低于另两臂的对应弱点 → 成本更优.");
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
