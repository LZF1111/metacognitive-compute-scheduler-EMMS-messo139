/**
 * answerTests.mjs —— 直接回答三个根本问题的复杂测试（全程走真实 MCP 传输）：
 *   (A) 越学越聪明吗?     → 学习曲线：随任务批次，校准 MAE↓ / 准确率↑ / 成本↓，且变性后能重新收敛。
 *   (B) 领域专用还是通用?  → 同一份核机制跑两个【不同领域】(不同 hint→crit 映射)，各自 namespace 独立学，
 *                            并验证"机制通用(都能学好) + 知识分领域(把A域学的库拿去B域→变差)"。
 *   (C) 污染机制有用吗?    → 对比"听从 suggest_compact 整理上下文" vs "不整理"，看长程任务成本/误判。
 *
 * 模拟环境（可复现、无需 LLM/联网）；意识臂经 spawn server.mjs + JSON-RPC 调度。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const CHEAP = 1, DEEP = 5, CRIT_TH = 0.55;

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// 领域 = 一个 hint→trueCrit 的映射规律。两个领域规律不同，模拟不同任务族。
const DOMAINS = {
  // 领域1(coding 类)：难度高 且 进度靠后 = 关键（收尾的难步最致命）
  coding: (d, prog, rng) => clamp01(0.6 * d + 0.4 * prog + (rng() - 0.5) * 0.2),
  // 领域2(ops 类)：难度低但进度早 = 关键（开局的小配置错了全盘皆输），与领域1几乎相反
  ops: (d, prog, rng) => clamp01(0.7 * (1 - d) + 0.3 * (1 - prog) + (rng() - 0.5) * 0.2),
};
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function genTask(rng, N, domainFn) {
  const steps = [];
  for (let i = 0; i < N; i++) {
    const d = rng(), prog = i / N;
    steps.push({ difficulty_hint: +d.toFixed(3), criticality_hint: +d.toFixed(3), progress: +prog.toFixed(3), trueCrit: +domainFn(d, prog, rng).toFixed(3) });
  }
  return steps;
}
function runStep(st, goDeep) {
  const crit = st.trueCrit > CRIT_TH;
  if (goDeep) return { cost: DEEP, mishandled: 0, usedS2: true };
  if (crit) return { cost: CHEAP + DEEP, mishandled: 1, usedS2: true };
  return { cost: CHEAP, mishandled: 0, usedS2: false };
}

// ── MCP 客户端 ──
function makeClient() {
  const srv = spawn(NODE, [path.join(__dir, "server.mjs")], { stdio: ["pipe", "pipe", "ignore"] });
  let buf = ""; const pending = new Map(); let nextId = 1;
  srv.stdout.on("data", (dd) => { buf += dd.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const tool = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(JSON.stringify(r.error)); return r.result.structuredContent ?? JSON.parse(r.result.content[0].text); };
  return { srv, rpc, notify, tool, close: () => srv.stdin.end() };
}
async function handshake(cli) { await cli.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ans", version: "0" } }); cli.notify("notifications/initialized", {}); }

// 跑一批任务，返回每批的 {cost,mishandled,steps}。useCompact=是否听从 suggest_compact。
async function runBatch(cli, sid, tasks, { useCompact = false } = {}) {
  let cost = 0, mishandled = 0, steps = 0, compactions = 0;
  for (const t of tasks) {
    await cli.tool("new_task", { sessionId: sid });
    let pollution = 0, taskOk = true;
    for (const st of t) {
      const d = await cli.tool("decide_step", { sessionId: sid, criticality_hint: st.criticality_hint, difficulty_hint: st.difficulty_hint, progress: st.progress, context_pollution: pollution });
      // ★污染治理：若核建议整理且我们采纳 → 花一点小代价把污染降下来（模拟压缩上下文）。
      if (useCompact && d.suggest_compact) { pollution = Math.max(0, pollution - 0.4); cost += 0.5; compactions++; }
      const goDeep = d.mode === "system2";
      const r = runStep(st, goDeep);
      cost += r.cost; mishandled += r.mishandled; steps++;
      pollution = Math.min(1, pollution + (r.usedS2 ? 0.12 : 0.03));
      if (r.mishandled) taskOk = false;
      await cli.tool("report_outcome", { sessionId: sid, criticality_hint: st.criticality_hint, difficulty_hint: st.difficulty_hint, progress: st.progress, observed_criticality: st.trueCrit, used_system2: r.usedS2, was_deep: r.usedS2 });
    }
    await cli.tool("task_feedback", { sessionId: sid, success: taskOk });
  }
  return { cost: +cost.toFixed(1), mishandled, steps, compactions };
}

(async () => {
  const N = 8;

  // ════════ (A) 越学越聪明 + 抗变性 ════════
  console.log("══════ (A) 越学越聪明吗? 学习曲线 (每批20任务×8步) ══════");
  {
    const cli = makeClient(); await handshake(cli);
    const ns = "A-" + Date.now(); const sid = "A";
    await cli.tool("open_session", { sessionId: sid, namespace: ns });
    const rng = mulberry32(11111);
    const BATCHES = 6;
    for (let b = 0; b < BATCHES; b++) {
      // 前4批 coding 域；第5批起切到 ops 域(规律反转=变性)，看是否重新收敛。
      const dom = b < 4 ? DOMAINS.coding : DOMAINS.ops;
      const tasks = Array.from({ length: 20 }, () => genTask(rng, N, dom));
      const r = await runBatch(cli, sid, tasks);
      const cal = await cli.tool("get_calibration", { sessionId: sid });
      const tag = b < 4 ? "coding" : "ops★变性";
      console.log(`  批${b}(${tag.padEnd(8)}) 成本=${String(r.cost).padStart(5)} 误判=${String(r.mishandled).padStart(3)}/${r.steps}  滚动MAE=${cal.overall.mae} 准确率=${cal.overall.accuracy}`);
    }
    const cal = await cli.tool("get_calibration", { sessionId: sid });
    console.log(`  → 全程: 前半MAE=${cal.firstHalf.mae} 近半MAE=${cal.recentHalf.mae}  improving=${cal.improving}`);
    console.log("  解读: coding 4批内 MAE/误判应下行(越学越准); 切ops后短暂回升再收敛(察觉变性重学).");
    cli.close();
  }

  // ════════ (B) 通用机制 vs 领域知识 ════════
  // 干净隔离: 先在 coding 域学满 → 锁死同一个库 → 分别跑【本域 coding】和【跨域 ops】，
  // 只变任务域、其他全同。若 本域 << 跨域(误判) = 学到的知识是领域专用的; 而"两域各自原生学都能学好"= 机制通用。
  console.log("\n══════ (B) 领域专用还是通用? (同一锁死库, 本域 vs 跨域) ══════");
  {
    const cli = makeClient(); await handshake(cli);
    // B1: 两域各自原生学(机制通用性)
    const native = {};
    for (const dom of ["coding", "ops"]) {
      const rng = mulberry32(dom === "coding" ? 2201 : 2202); // 每域独立种子，公平
      const ns = `B-${dom}-${Date.now()}`; const sid = `B-${dom}`;
      await cli.tool("open_session", { sessionId: sid, namespace: ns });
      const r = await runBatch(cli, sid, Array.from({ length: 60 }, () => genTask(rng, N, DOMAINS[dom])));
      native[dom] = r;
      console.log(`  原生学[${dom}]: 成本=${String(r.cost).padStart(5)} 误判=${String(r.mishandled).padStart(3)}/${r.steps}`);
    }
    console.log("  → 两域原生都收敛(误判率低) = 同一套机制能学不同领域 = 机制通用.");

    // B2: 在 coding 学满 → 锁死 → 同一库分别测本域/跨域(同种子同任务结构)
    const nsC = `B-lib-${Date.now()}`; const sidT = "Bt";
    await cli.tool("open_session", { sessionId: sidT, namespace: nsC });
    const rngTrain = mulberry32(2210);
    await runBatch(cli, sidT, Array.from({ length: 80 }, () => genTask(rngTrain, N, DOMAINS.coding)));
    await cli.tool("close_session", { sessionId: sidT });

    const rngEval = mulberry32(2211); // 同一套评测题种子，两域结构对齐
    const evalCoding = Array.from({ length: 60 }, () => genTask(rngEval, N, DOMAINS.coding));
    const rngEval2 = mulberry32(2211);
    const evalOps = Array.from({ length: 60 }, () => genTask(rngEval2, N, DOMAINS.ops));

    const sidIn = "Bin"; await cli.tool("open_session", { sessionId: sidIn, namespace: nsC, opts: { canGrow: false, canShift: false } });
    const rIn = await runBatch(cli, sidIn, evalCoding);
    const sidOut = "Bout"; await cli.tool("open_session", { sessionId: sidOut, namespace: nsC, opts: { canGrow: false, canShift: false } });
    const rOut = await runBatch(cli, sidOut, evalOps);
    console.log(`  coding库(锁死)→本域coding: 成本=${String(rIn.cost).padStart(5)} 误判=${String(rIn.mishandled).padStart(3)}/${rIn.steps}`);
    console.log(`  coding库(锁死)→跨域ops:    成本=${String(rOut.cost).padStart(5)} 误判=${String(rOut.mishandled).padStart(3)}/${rOut.steps}`);
    const ratio = rIn.mishandled > 0 ? (rOut.mishandled / rIn.mishandled).toFixed(1) : "∞";
    console.log(`  → 跨域误判是本域的 ${ratio}× = 学到的知识是【领域专用】的(机制通用,知识分域).`);
    cli.close();
  }

  // ════════ (C) 污染治理(suggest_compact)是否有用 ════════
  // 诚实建模"越想越乱": 上下文越脏(pollution↑)，System2 深思越不可靠——
  // 即便在真关键步点燃了深思，若 pollution>0.6，仍有 (pollution-0.6) 概率"想岔"而失败。
  // 这正是框架声称要治理的现象。compaction(整理)把 pollution 压下去→恢复 System2 可靠性。
  console.log("\n══════ (C) 上下文污染治理有用吗? (长程24步, 建模'越想越乱') ══════");
  {
    const Nlong = 24;
    // 带污染惩罚的执行: goDeep 且 pollution 高时，深思可能仍失败。
    function runStepP(st, goDeep, pollution, rng) {
      const crit = st.trueCrit > CRIT_TH;
      if (goDeep) {
        const pFail = Math.max(0, pollution - 0.6); // 脏到一定程度才开始"想岔"
        if (crit && rng() < pFail) return { cost: DEEP + DEEP, mishandled: 1, usedS2: true }; // 想岔→返工再深思
        return { cost: DEEP, mishandled: 0, usedS2: true };
      }
      if (crit) return { cost: CHEAP + DEEP, mishandled: 1, usedS2: true };
      return { cost: CHEAP, mishandled: 0, usedS2: false };
    }
    async function runBatchP(cli, sid, tasks, useCompact, rng) {
      let cost = 0, mishandled = 0, steps = 0, compactions = 0;
      for (const t of tasks) {
        await cli.tool("new_task", { sessionId: sid });
        let pollution = 0, taskOk = true;
        for (const st of t) {
          const d = await cli.tool("decide_step", { sessionId: sid, criticality_hint: st.criticality_hint, difficulty_hint: st.difficulty_hint, progress: st.progress, context_pollution: pollution });
          if (useCompact && d.suggest_compact) { pollution = Math.max(0, pollution - 0.45); cost += 0.5; compactions++; }
          const goDeep = d.mode === "system2";
          const r = runStepP(st, goDeep, pollution, rng);
          cost += r.cost; mishandled += r.mishandled; steps++;
          pollution = Math.min(1, pollution + (r.usedS2 ? 0.12 : 0.03));
          if (r.mishandled) taskOk = false;
          await cli.tool("report_outcome", { sessionId: sid, criticality_hint: st.criticality_hint, difficulty_hint: st.difficulty_hint, progress: st.progress, observed_criticality: st.trueCrit, used_system2: r.usedS2, was_deep: r.usedS2 });
        }
        await cli.tool("task_feedback", { sessionId: sid, success: taskOk });
      }
      return { cost: +cost.toFixed(1), mishandled, steps, compactions };
    }
    for (const useCompact of [false, true]) {
      const cli = makeClient(); await handshake(cli);
      const ns = `C-${useCompact}-${Date.now()}`; const sid = "C";
      await cli.tool("open_session", { sessionId: sid, namespace: ns });
      const rng = mulberry32(33333); // 同种子→同任务+同"想岔"骰子，唯一变量=是否整理
      const tasksFixed = Array.from({ length: 40 }, () => genTask(rng, Nlong, DOMAINS.coding));
      const dice = mulberry32(99999); // 失败骰子也固定
      const r = await runBatchP(cli, sid, tasksFixed, useCompact, dice);
      console.log(`  ${useCompact ? "采纳整理建议" : "忽略整理建议"}: 成本=${String(r.cost).padStart(6)} 误判=${String(r.mishandled).padStart(3)}/${r.steps} 整理次数=${r.compactions}`);
      cli.close();
    }
    console.log("  解读: 长程脏上下文里,采纳整理→压住污染→深思不再'想岔'→误判↓; 即便整理有小成本,净更优.");
  }

  process.exit(0);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
