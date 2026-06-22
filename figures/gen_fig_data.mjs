/**
 * gen_fig_data.mjs —— 采集论文/README 配图所需的全部数据，统一导出为 fig_data.json。
 *
 * 复用真实调度核 SelfModelAgent（与 MCP server 同一底座），跑一个【长程 + 中途变性】实验，
 * 逐步记录 EMMS 竞争-协调的原始竞价量（robGain / ecoCost / μ / ignite / critEst / 真关键度），
 * 并与两条对照臂（always-System2 / static-skill）对齐成本、误判、过度深思。
 *
 * 输出四组数据：
 *   armBars        —— 三臂总成本 / 误判 / 过度深思（长程三臂对比，柱状图）
 *   learningCurve  —— 误判率随任务批次下降（越学越聪明，折线）
 *   muTrace        —— 影子价 μ 随任务收敛（协调变量不动点，折线）
 *   biddingScatter —— 每步 (robGain, ecoCost) 散点 + 是否点燃（EMMS 竞价裁决可视化）
 *   shiftBars      —— 中途变性后半段决策准确率（来自 exp_shift.mjs，30 seed）
 *
 * 跑：node gen_fig_data.mjs   →   写 fig_data.json
 */
import { SelfModelAgent } from "../selfModel.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ── 可复现随机 ──
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 代价模型（与 complexTask.mjs 一致）──
const CHEAP = 1, DEEP = 5;
const CRIT_TH = 0.55;     // trueCrit > 此 → 该步真关键（便宜必失败→升级）
const SKILL_TH = 0.6;     // static-skill 硬阈值

function genTask(rng, N, regime) {
  const steps = [];
  for (let i = 0; i < N; i++) {
    const dHint = rng();                               // 难度线索
    const cHint = rng();                               // 关键度线索(独立采样,难≠关键)
    const base = regime === "A" ? (0.7 * cHint + 0.3 * dHint) : (0.7 * (1 - cHint) + 0.3 * (1 - dHint)); // B：线索反转
    const trueCrit = Math.max(0, Math.min(1, base + (rng() - 0.5) * 0.25));
    steps.push({
      criticality_hint: +cHint.toFixed(3),
      difficulty_hint: +dHint.toFixed(3),
      progress: +(i / N).toFixed(3),
      trueCrit: +trueCrit.toFixed(3),
    });
  }
  return steps;
}

/** 给定是否深思，返回 {cost, mishandled, overdeep, usedS2}。 */
function runStep(st, goDeep) {
  const reallyCritical = st.trueCrit > CRIT_TH;
  if (goDeep) return { cost: DEEP, mishandled: 0, overdeep: reallyCritical ? 0 : 1, usedS2: true };
  if (reallyCritical) return { cost: CHEAP + DEEP, mishandled: 1, overdeep: 0, usedS2: true };
  return { cost: CHEAP, mishandled: 0, overdeep: 0, usedS2: false };
}

// ── 实验配置 ──
const rng = mulberry32(20260607);
const N = 8, TASKS = 60, half = TASKS / 2;
const tasks = [];
for (let k = 0; k < TASKS; k++) tasks.push(genTask(rng, N, k < half ? "A" : "B"));

// ── 对照臂 1：always-System2 ──
function armAlwaysS2() {
  let cost = 0, mishandled = 0, overdeep = 0;
  for (const t of tasks) for (const st of t) { const r = runStep(st, true); cost += r.cost; mishandled += r.mishandled; overdeep += r.overdeep; }
  return { name: "always-System2", cost, mishandled, overdeep };
}
// ── 对照臂 2：static-skill（硬阈值）──
function armStaticSkill() {
  let cost = 0, mishandled = 0, overdeep = 0;
  for (const t of tasks) for (const st of t) { const r = runStep(st, st.difficulty_hint >= SKILL_TH); cost += r.cost; mishandled += r.mishandled; overdeep += r.overdeep; }
  return { name: "static-skill", cost, mishandled, overdeep };
}
// ── 本文：意识核（逐步采竞价量）──
function armConscious() {
  const agent = new SelfModelAgent();
  let cost = 0, mishandled = 0, overdeep = 0;
  const muTrace = [];                 // 每任务结束记 μ
  const biddingScatter = [];          // 每步 (robGain, ecoCost, ignite)
  const perTaskMishandle = [];        // 每任务误判数（→ 批次学习曲线）
  for (let ti = 0; ti < tasks.length; ti++) {
    const t = tasks[ti];
    agent.newTask();
    let taskOk = true, mh = 0;
    for (const st of t) {
      const x = [st.criticality_hint, st.difficulty_hint, st.progress];
      const d = agent.decideAbstract(x);
      const goDeep = d.ignite;
      const r = runStep(st, goDeep);
      cost += r.cost; mishandled += r.mishandled; overdeep += r.overdeep; mh += r.mishandled;
      if (r.mishandled) taskOk = false;
      biddingScatter.push({
        robGain: +d.robGain.toFixed(4),
        ecoCost: +d.ecoCost.toFixed(4),
        ignite: d.ignite ? 1 : 0,
        trueCritical: st.trueCrit > CRIT_TH ? 1 : 0,
      });
      agent.learnAbstract(x, st.trueCrit, d.ignite);
      agent.addPollution(d.ignite, r.usedS2);
    }
    agent.feedback(taskOk);
    perTaskMishandle.push(mh);
    muTrace.push({ task: ti + 1, mu: +agent.mu.toFixed(4), regime: ti < half ? "A" : "B" });
  }
  // 批次学习曲线：每 BATCH 个任务聚合误判率（误判步数 / 总步数）
  const BATCH = 6;
  const learningCurve = [];
  for (let b = 0; b * BATCH < TASKS; b++) {
    const seg = perTaskMishandle.slice(b * BATCH, b * BATCH + BATCH);
    const mh = seg.reduce((a, c) => a + c, 0);
    learningCurve.push({
      batch: b + 1,
      taskRange: `${b * BATCH + 1}-${b * BATCH + seg.length}`,
      mishandleRate: +(mh / (seg.length * N)).toFixed(4),
      regime: (b * BATCH) < half ? "A" : "B",
    });
  }
  return { name: "conscious", cost, mishandled, overdeep, muTrace, biddingScatter, learningCurve, nProto: agent.protos.length, mu: +agent.mu.toFixed(3) };
}

const a1 = armAlwaysS2();
const a2 = armStaticSkill();
const a3 = armConscious();
const base = a1.cost;
const saveOf = (c) => +(((base - c) / base) * 100).toFixed(1);

// ── exp_shift.mjs 的 30-seed 结果（中途变性后半段决策准确率，均值±std）──
// 数字来自 `node exp_shift.mjs`（conscious 臂用对外 MCP 真实判据 plan.ignite 选功率）。
const shiftBars = {
  note: "exp_shift.mjs, seeds=30, L=16, episodes=50; 突变后半段决策准确率(深思↔真关键对齐); conscious 用 plan.ignite",
  arms: [
    { name: "static-skill", mean: 52.4, std: 5.1 },
    { name: "router-frozen", mean: 55.6, std: 9.0 },
    { name: "router-online", mean: 57.3, std: 3.4 },
    { name: "conscious", mean: 59.8, std: 3.3 },
  ],
  significance: "conscious vs router-online: Δ=2.5pt, p=4.9e-7, d=0.93, 胜率80%",
};

const out = {
  meta: {
    title: "Metacognitive Compute Scheduler — figure data",
    seed: 20260607, tasks: TASKS, stepsPerTask: N, regimeShiftAt: half,
    costModel: { cheap: CHEAP, deep: DEEP, critTh: CRIT_TH },
    generated: new Date().toISOString(),
  },
  armBars: [
    { name: a1.name, cost: a1.cost, save: saveOf(a1.cost), mishandled: a1.mishandled, overdeep: a1.overdeep },
    { name: a2.name, cost: a2.cost, save: saveOf(a2.cost), mishandled: a2.mishandled, overdeep: a2.overdeep },
    { name: a3.name, cost: a3.cost, save: saveOf(a3.cost), mishandled: a3.mishandled, overdeep: a3.overdeep },
  ],
  learningCurve: a3.learningCurve,
  muTrace: a3.muTrace,
  biddingScatter: a3.biddingScatter,
  shiftBars,
};

const outPath = path.join(__dir, "fig_data.json");
writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
console.log("wrote", outPath);
console.log("armBars:");
for (const a of out.armBars) console.log(`  ${a.name.padEnd(16)} cost=${String(a.cost).padStart(5)} save=${String(a.save).padStart(5)}% mishandled=${String(a.mishandled).padStart(3)} overdeep=${String(a.overdeep).padStart(3)}`);
console.log(`conscious: nProto=${a3.nProto} mu=${a3.mu} | learningCurve batches=${a3.learningCurve.length} | scatter pts=${a3.biddingScatter.length}`);
