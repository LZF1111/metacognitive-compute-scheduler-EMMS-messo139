/**
 * exp_action.mjs —— 复现用户报告的【漏判病根】并验证两个改进。
 *
 * ── 用户报告的失败模式(精确复现)──
 *   连续在线学习 20 条全程出现 2 次关键漏判,都在"设计补丁(design_patch)"阶段被降成 System1。
 *   归因(已在代码核验): design_patch 步的 critHint 被欺骗性压低 + μ 从 1 衰减到 0.46
 *   → robBase=μ·pCrit·missPenalty 太小 → pUpper 没过 criticalGate=0.75 → 没有任何障碍触发
 *   → 降成 System1 且不验证 → 漏判清零整任务。
 *
 * ── 本测试构造一个【对抗性 SWE 任务序列】精确触发它 ──
 *   每个任务 = [read_issue, retrieve, locate, design_patch, apply_patch, run_test]。
 *   关键陷阱: design_patch / apply_patch 的 critHint 被故意压低(=0.25,看着像低风险),
 *   但它们的真关键度 trueCrit 很高(=0.85,改错就毁全局)。其余只读步 critHint≈trueCrit(诚实)。
 *   先喂一批"成功任务"让 μ 衰减(复现 μ→0.46),再看改动步是否被漏判。
 *
 * ── 三臂对比 ──
 *   baseline   : 原 selfModel(不传 actionType)——应复现 design_patch 漏判。
 *   action     : 新 selfModel(传 actionType)——动作硬约束应救回漏判 + 改动步强制 test。
 *   action+test: 同 action,但把 verify=test 当作真验证器(recall=0.9)计入——漏判应进一步压到≈0。
 *
 * 用法: node exp_action.mjs [seeds=30]
 */
import { SelfModelAgent } from "./selfModel.mjs";

const SEEDS = parseInt(process.argv[2] || "30", 10);
const WARMUP = 10;   // 先跑 WARMUP 条"诚实易任务"让 μ 衰减(复现 μ→0.46)
const TRIAL = 14;    // 再跑 TRIAL 条含对抗 design_patch 的任务
const CRIT_TH = 0.6;
const TEST_RECALL = 0.9; // verify=test 抓住漏判的召回率(验证器物理属性)

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 诚实易任务(warmup):全是低关键只读步,critHint≈trueCrit,让模型学会"省"+μ 衰减。
function easyTask(rng) {
  const acts = ["read_issue", "retrieve", "locate", "inspect"];
  return acts.map((a, i) => {
    const c = 0.15 + rng() * 0.2; // 真低关键
    return { actionType: a, critHint: +(c + (rng() - 0.5) * 0.1).toFixed(3),
             dHint: +rng().toFixed(3), trueCrit: +c.toFixed(3), i, n: acts.length, rndV: rng() };
  });
}

// 对抗任务: design_patch/apply_patch 真关键(0.85)但 critHint 被压低(0.25)。
function trapTask(rng) {
  const spec = [
    ["read_issue", 0.2, 0.2], ["retrieve", 0.2, 0.2], ["locate", 0.4, 0.4],
    ["design_patch", 0.85, 0.25],  // ★陷阱: 真关键0.85, 提示却0.25
    ["apply_patch", 0.85, 0.25],   // ★陷阱
    ["run_test", 0.45, 0.45],
  ];
  return spec.map(([a, tc, ch], i) => ({
    actionType: a,
    critHint: +(ch + (rng() - 0.5) * 0.06).toFixed(3),
    dHint: +rng().toFixed(3),
    trueCrit: +(tc + (rng() - 0.5) * 0.06).toFixed(3),
    i, n: spec.length, rndV: rng(),
  }));
}

/**
 * 跑一臂。passAction=是否把 actionType 传给引擎(false=复现原行为)。
 * useTestVerifier=verify=="test"时是否真用验证器抓漏判(把"猜对"变"测过")。
 */
function runArm(seed, { passAction, useTestVerifier, premiumWeight }) {
  const rng = mulberry32(seed);
  const agent = new SelfModelAgent({ mu0: 1.0,
    ...(premiumWeight != null ? { actionPremiumWeight: premiumWeight } : {}) });
  let miss = 0, mutMiss = 0, deep = 0, nStep = 0, forcedTests = 0;
  const allTasks = [];
  for (let k = 0; k < WARMUP; k++) allTasks.push({ steps: easyTask(rng), trap: false });
  for (let k = 0; k < TRIAL; k++) allTasks.push({ steps: trapTask(rng), trap: true });

  for (const { steps, trap } of allTasks) {
    agent.newTask();
    let taskOk = true;
    for (const st of steps) {
      const x = [st.critHint, st.dHint, st.i / st.n];
      const ctx = passAction ? { actionType: st.actionType } : {};
      const d = agent.decideAbstract(x, agent.z.pollution, ctx);
      nStep++;
      let usedS2 = d.ignite;
      let caught = false;
      // verify=test 真验证器: 即使 System1,若该步挂了 test,以 recall 概率抓住漏判→升级补救(不漏)。
      if (useTestVerifier && d.verify === "test") {
        forcedTests++;
        if (!d.ignite && st.trueCrit > CRIT_TH) {
          // 漏判风险被 test 以 recall 概率拦截。
          if (st.rndV < TEST_RECALL) { caught = true; usedS2 = true; }
        }
      }
      const reallyCrit = st.trueCrit > CRIT_TH;
      const mishandled = (!usedS2 && reallyCrit); // 便宜处理了真关键步且没被验证器救回 = 漏判
      if (usedS2) deep++;
      if (mishandled) {
        miss++;
        if (st.actionType === "design_patch" || st.actionType === "apply_patch") mutMiss++;
        taskOk = false;
      }
      const verifierPassed = (useTestVerifier && d.verify === "test") ? (caught || !reallyCrit) : null;
      agent.learnAbstract(x, st.trueCrit, d.ignite, { verifierPassed, missHappened: mishandled }, ctx);
      agent.addPollution(usedS2, usedS2);
    }
    agent.feedback(taskOk);
  }
  return { miss, mutMiss, deepRate: +(deep / nStep).toFixed(3), mu: +agent.mu.toFixed(3), forcedTests };
}

function avg(rows, k) { return +(rows.reduce((s, r) => s + r[k], 0) / rows.length).toFixed(2); }

const arms = {
  "baseline(原)":       { passAction: false, useTestVerifier: false },
  "action(硬约束)":     { passAction: true,  useTestVerifier: false },
  "action+test(强制验)": { passAction: true,  useTestVerifier: true },
  // 消融:溢价几乎置零(模拟溢价不足以点燃) → 单靠【改动步强制 test】能否独立兑住漏判?
  "test-only(只靠强制验)": { passAction: true, useTestVerifier: true, premiumWeight: 0.001 },
};
const out = {};
for (const [name, cfg] of Object.entries(arms)) {
  const rows = [];
  for (let s = 0; s < SEEDS; s++) rows.push(runArm(2000 + s * 13, cfg));
  out[name] = {
    miss: avg(rows, "miss"), mutMiss: avg(rows, "mutMiss"),
    deepRate: avg(rows, "deepRate"), mu: avg(rows, "mu"), forcedTests: avg(rows, "forcedTests"),
  };
}

console.log(`\n=== 复现 design_patch 漏判 + 验证两改进 (seeds=${SEEDS}, warmup=${WARMUP}易, trial=${TRIAL}对抗) ===`);
console.log(`陷阱: design_patch/apply_patch 真关键0.85 但 critHint 压到0.25; 真关键阈值=${CRIT_TH}; test召回=${TEST_RECALL}`);
for (const [name, o] of Object.entries(out)) {
  console.log(`\n[${name}]`);
  console.log(`  关键漏判(总)   = ${o.miss}`);
  console.log(`  ★改动步漏判    = ${o.mutMiss}   ← 用户报告的"design_patch 被降 System1"`);
  console.log(`  深思率         = ${o.deepRate}`);
  console.log(`  末 μ           = ${o.mu}   (复现 μ 衰减)`);
  console.log(`  强制 test 次数 = ${o.forcedTests}`);
}

const b = out["baseline(原)"], a = out["action(硬约束)"], at = out["action+test(强制验)"];
console.log(`\n--- 诚实结论 ---`);
console.log(`baseline 改动步漏判 = ${b.mutMiss} (复现用户报告的漏判)`);
console.log(`action   改动步漏判 = ${a.mutMiss} (动作硬约束的语义溢价${a.mutMiss < b.mutMiss ? "降低了漏判 ✅" : "未降低"})`);
console.log(`action+test 改动步漏判 = ${at.mutMiss} (改动步强制 test 后${at.mutMiss <= a.mutMiss ? "进一步压低 ✅" : ""})`);
const fixed = at.mutMiss < b.mutMiss;
console.log(`\n判定: ${fixed ? "两改进确实修复了 design_patch 漏判病根(改动步漏判从 " + b.mutMiss + " 降到 " + at.mutMiss + ")。" : "未修复——需检查动作先验/溢价权重。"}`);
process.exit(0);
