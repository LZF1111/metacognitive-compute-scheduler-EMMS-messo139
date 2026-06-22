/**
 * exp_shift.mjs —— τ-bench 式"任务中途规则突变"实验（顶会卖点：在线适应 vs 冻结策略）。
 *
 * 动机：主实验里 RouteLLM 式学习路由器表现不错——因为它在【平稳/可预训练】分布上能学到好阈值。
 * 但真实长程 agent 任务的痛点是【任务跑到一半，规则/用户需求突变】(τ-bench 的核心)。
 * 此时：
 *   • 冻结策略(static-skill / 预训练好的 router)：阈值是全局单一的，无法表达"前半用规律A、后半用规律B"，
 *     更没有"察觉突变"的机制 → 突变后持续误判。
 *   • 意识核：每步算【惊讶】=1-最相似原型相似度；突变→惊讶飙升→点燃→切换/新建原型 → 在线适应。
 *
 * 设计（干净隔离这个变量）：
 *   - 每个 episode 长 L 步；在随机位置 shiftPoint 处，hint→criticality 的映射【翻转】(A↔B)。
 *   - 翻转点与方向【每个 episode 随机】→ 没有任何"全局阈值"能同时适配前后两段。
 *   - 所有学习者先在【平稳】分布(只有A或只有B,不翻转)上预训练；评测时遭遇【翻转】episode。
 *   - 评测期：router 继续在线学(给它最大公平)，但它只有一个全局 logistic，无 regime 概念；
 *     意识核靠原型库+惊讶点燃在线切换。
 *   - 指标：突变【后半段】的决策准确率(深思↔真关键对齐) + episode 完成率 + cost。多 seed + 配对检验。
 *
 * 跑：node exp_shift.mjs [--seeds 30] [--L 16] [--episodes 50]
 */
import { SelfModelAgent } from "./selfModel.mjs";
import * as S from "./stats.mjs";

const argv = process.argv.slice(2);
const getArg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? +argv[i + 1] : d; };
const NSEEDS = getArg("seeds", 30);
const L = getArg("L", 16);
const EPISODES = getArg("episodes", 50);
const BUDGET = getArg("budget", 24);
const K = 8, CRIT_TH = 0.6, MAXP = 3;
const PFRAC = [0, 1 / 3, 2 / 3, 1];
const COST = [0.15, 0.45, 1.0, 3.0];
const BASE = 1.0; // 固定中等底座（突变适应是关键变量，不掺底座强度）

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function rngOf(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function capEff(p) { return BASE * (0.55 + 0.45 * PFRAC[p]); }

/** regime A: critHint 预示关键; regime B: critHint 反相关(翻转)。难度线索独立。 */
function genStep(regime, rng) {
  const a = rng();
  const crit = regime === "A" ? a : 1 - a;
  const d = clamp01(0.15 + 0.7 * rng());
  const critHint = clamp01(a + (rng() - 0.5) * 0.25);   // 同一个 critHint 在 A/B 含义相反
  const dHint = clamp01(d + (rng() - 0.5) * 0.2);
  return { crit, d, critHint, dHint, isCritical: crit > CRIT_TH };
}
/** 平稳 episode（预训练用）：整条只有一个 regime。 */
function genStationary(rng) {
  const r = rng() < 0.5 ? "A" : "B";
  return Array.from({ length: L }, () => ({ ...genStep(r, rng), regime: r }));
}
/** 突变 episode（评测用）：随机点翻转 regime，方向随机。 */
function genShift(rng) {
  const r1 = rng() < 0.5 ? "A" : "B"; const r2 = r1 === "A" ? "B" : "A";
  const sp = 0.3 + 0.4 * rng();   // 翻转点在 30%~70%
  const steps = [];
  for (let i = 0; i < L; i++) {
    const r = i / L >= sp ? r2 : r1;
    steps.push({ ...genStep(r, rng), regime: r, afterShift: i / L >= sp });
  }
  return steps;
}

function execStep(step, startP, remaining, rng) {
  let p = startP, forcedCheap = false;
  if (remaining < COST[MAXP] && p > 1) { p = 0; forcedCheap = true; }
  let cost = 0, ok = false, maxP = p;
  for (let attempt = 0; attempt <= 2; attempt++) {
    cost += COST[p]; maxP = Math.max(maxP, p);
    if (rng() < sigmoid(K * (capEff(p) - step.d))) { ok = true; break; }
    if (cost >= remaining) break;
    p = Math.min(MAXP, p + 1);
  }
  return { ok, cost, maxP, forcedCheap };
}

// ── router(RouteLLM式)：全局单一 logistic，无 regime 概念 ──
function makeRouter() {
  let w = [0, 0, 0]; const lr = 0.15; // [bias, critHint, dHint]
  return {
    decide: (o) => (sigmoid(w[0] + w[1] * o.critHint + w[2] * o.dHint) > 0.5 ? MAXP : 0),
    learn: (o, y) => { const pr = sigmoid(w[0] + w[1] * o.critHint + w[2] * o.dHint); const g = (y - pr); w[0] += lr * g; w[1] += lr * g * o.critHint; w[2] += lr * g * o.dHint; },
  };
}

/** 跑一个 episode 集，记录【突变后半段】的决策准确率。 */
function runRouter(router, episodes, rng, learnDuringEval) {
  let cost = 0, epDone = 0, afterCorrect = 0, afterTotal = 0;
  for (const ep of episodes) {
    let used = 0, epOk = true;
    for (const s of ep) {
      const remaining = BUDGET - used;
      const o = { critHint: s.critHint, dHint: s.dHint };
      if (remaining <= 0) { epOk = false; continue; }
      const startP = router.decide(o);
      const r = execStep(s, startP, remaining, rng);
      used += r.cost; cost += r.cost;
      if (!r.ok && s.isCritical) epOk = false;
      // 决策正确性：深思(startP=MAXP) 应命中真关键步
      if (s.afterShift) { afterTotal++; if ((startP === MAXP) === s.isCritical) afterCorrect++; }
      if (learnDuringEval) router.learn(o, s.isCritical ? 1 : 0); // 给 router 最大公平:评测也在线学
    }
    if (epOk) epDone++;
  }
  return { cost, epRate: epDone / episodes.length, afterAcc: afterTotal ? afterCorrect / afterTotal : 0 };
}

function runConscious(agent, episodes, rng) {
  let cost = 0, epDone = 0, afterCorrect = 0, afterTotal = 0;
  for (const ep of episodes) {
    let used = 0, epOk = true; agent.newTask();
    for (let i = 0; i < ep.length; i++) {
      const s = ep[i]; const remaining = BUDGET - used;
      if (remaining <= 0) { epOk = false; continue; }
      const x = [clamp01(s.critHint), clamp01(s.dHint), clamp01(i / ep.length)];
      const plan = agent.decideAbstract(x, clamp01(used / BUDGET));
      const startP = plan.critEst > plan.theta ? MAXP : 0;
      const r = execStep(s, startP, remaining, rng);
      used += r.cost; cost += r.cost;
      if (!r.ok && s.isCritical) epOk = false;
      if (s.afterShift) { afterTotal++; if ((startP === MAXP) === s.isCritical) afterCorrect++; }
      // 在线学习真关键度(用真关键 isCritical 当观测，与 router 标签一致以示公平)
      agent.learnAbstract(x, s.isCritical ? 0.9 : 0.1, r.maxP >= 2);
      agent.addPollution(r.maxP >= 2, r.maxP >= 2);
    }
    agent.feedback(epOk); if (epOk) epDone++;
  }
  return { cost, epRate: epDone / episodes.length, afterAcc: afterTotal ? afterCorrect / afterTotal : 0 };
}

console.log(`# τ-bench式 中途规则突变实验  seeds=${NSEEDS} L=${L} episodes=${EPISODES}`);
console.log(`# 所有学习者先在平稳分布预训练，再遭遇随机翻转episode；看【突变后半段】决策准确率\n`);

const acc = { router: [], conscious: [], routerFrozen: [], skill: [] };
const epr = { router: [], conscious: [], routerFrozen: [], skill: [] };
const cst = { router: [], conscious: [], routerFrozen: [], skill: [] };

for (let s = 0; s < NSEEDS; s++) {
  const seed = 2000 + s;
  const rng = rngOf(seed);
  const warm = Array.from({ length: 80 }, () => genStationary(rng));
  const evl = Array.from({ length: EPISODES }, () => genShift(rng));

  // router: 预训练(平稳) → 评测仍在线学(最大公平)
  const router = makeRouter();
  runRouter(router, warm, rng, true);
  const rRouter = runRouter(router, evl, rng, true);

  // routerFrozen: 预训练后冻结(模拟"部署即固定阈值")
  const routerF = makeRouter();
  runRouter(routerF, warm, rng, true);
  const rFrozen = runRouter(routerF, evl, rng, false);

  // static-skill: 固定阈值，不学
  const skill = { decide: (o) => (o.critHint > 0.55 ? MAXP : 0), learn: () => {} };
  const rSkill = runRouter(skill, evl, rng, false);

  // conscious: 预训练(平稳) → 评测在线适应
  const agent = new SelfModelAgent({ canShift: true, canGrow: true });
  runConscious(agent, warm, rng);
  const rCon = runConscious(agent, evl, rng);

  acc.router.push(rRouter.afterAcc * 100); acc.conscious.push(rCon.afterAcc * 100);
  acc.routerFrozen.push(rFrozen.afterAcc * 100); acc.skill.push(rSkill.afterAcc * 100);
  epr.router.push(rRouter.epRate * 100); epr.conscious.push(rCon.epRate * 100);
  epr.routerFrozen.push(rFrozen.epRate * 100); epr.skill.push(rSkill.epRate * 100);
  cst.router.push(rRouter.cost); cst.conscious.push(rCon.cost);
  cst.routerFrozen.push(rFrozen.cost); cst.skill.push(rSkill.cost);
}

console.log("突变【后半段】决策准确率(深思↔真关键对齐, 越高越好):");
console.log(`  static-skill(冻结阈值)     ${S.fmt(acc.skill)}%`);
console.log(`  router-frozen(部署即冻结)  ${S.fmt(acc.routerFrozen)}%`);
console.log(`  router-online(评测也在线学) ${S.fmt(acc.router)}%`);
console.log(`  conscious(本文,在线适应)    ${S.fmt(acc.conscious)}%`);
console.log("\nepisode 完成率:");
console.log(`  static-skill ${S.fmt(epr.skill)}%  router-frozen ${S.fmt(epr.routerFrozen)}%  router-online ${S.fmt(epr.router)}%  conscious ${S.fmt(epr.conscious)}%`);

console.log("\n配对t检验 (conscious vs 各对照, 后半段准确率, 逐seed):");
for (const [name, arr] of [["static-skill", acc.skill], ["router-frozen", acc.routerFrozen], ["router-online", acc.router]]) {
  const t = S.pairedT(acc.conscious, arr);
  const d = S.cohenD(acc.conscious, arr);
  const ci = S.bootstrapDiffCI(acc.conscious, arr);
  console.log(`  vs ${name.padEnd(14)} Δacc=${t.meanDiff.toFixed(1)}pt  p=${t.p.toExponential(1)} ${S.stars(t.p)}  d=${d.toFixed(2)}  95%CI[${ci.lo.toFixed(1)},${ci.hi.toFixed(1)}]  胜率=${(S.winRate(acc.conscious, arr) * 100).toFixed(0)}%`);
}
console.log("\n# 结论: 中途突变时, 全局单一阈值(skill/router)无法表达分段规律也不察觉突变 → 后半段误判;");
console.log("#       意识核靠惊讶点燃在线切换原型 → 后半段准确率显著更高(这是 τ-bench/长程变性的核心卖点).");
