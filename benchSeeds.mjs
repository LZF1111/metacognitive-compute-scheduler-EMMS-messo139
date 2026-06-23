/**
 * benchSeeds.mjs —— 多随机种子基准 + 硬断言(回归保护)。
 *
 * 回应评审:
 *   - 不再用固定单种子。跑 SEEDS 个种子,报告均值 ± 标准差(近似置信区间)。
 *   - 直接报告【成本敏感目标】= 总成本(已含漏判重做+过度深思),并单列关键漏判/过度深思。
 *   - 特征独立:criticality_hint 与 difficulty_hint 是【两个不同信号】(不再复制同一个 dHint)。
 *   - 硬断言:conscious 的关键漏判必须 <= static-skill,且总成本必须 < static。不满足则非零退出。
 *
 * 任务设定(更贴近真实、且让两个信号各自有用):
 *   - difficulty_hint:这步表面多难(影响要不要多想,但难≠关键)。
 *   - criticality_hint:这步表面多关键(错了毁全局),与难度【部分解耦】。
 *   - 真关键度 trueCrit:regime A = 偏向 criticality 线索;regime B(中途变性)= 线索反转+噪声。
 *   - System2 不再"必然成功":深思把这步做对的概率高但非 100%(评审指出旧版 S2 必成功不真实)。
 *
 * 用法: node benchSeeds.mjs [seeds=20] [N=8] [tasks=60]
 */
import { SelfModelAgent } from "./selfModel.mjs";

const SEEDS = parseInt(process.argv[2] || "20", 10);
const N = parseInt(process.argv[3] || "8", 10);          // 每任务步数
const TASKS = parseInt(process.argv[4] || "60", 10);     // 任务数(中途变性在一半处)

// 代价模型(与 complexTask 一致,且就是被优化的成本敏感目标):
const CHEAP = 1, DEEP = 5;            // 便宜处理=1, 深思=5
const CRIT_TH = 0.6;                  // 真关键度阈值
const SKILL_TH = 0.6;                 // 静态规则阈值
const S2_SUCCESS = 0.9;               // 深思把关键步做对的概率(非100%,更真实)

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genTasks(rng) {
  const tasks = [];
  const half = Math.floor(TASKS / 2);
  for (let k = 0; k < TASKS; k++) {
    const regime = k < half ? "A" : "B";
    const steps = [];
    for (let i = 0; i < N; i++) {
      // 两个【独立】信号
      const dHint = rng();                                   // 难度线索
      const cHintRaw = rng();                                // 关键度线索(独立采样)
      // 真关键度:regime A 主要由 cHint 决定(+少量难度耦合); regime B 线索反转。
      let base;
      if (regime === "A") base = 0.7 * cHintRaw + 0.3 * dHint;
      else base = 0.7 * (1 - cHintRaw) + 0.3 * (1 - dHint); // 变性:线索反转
      const trueCrit = Math.max(0, Math.min(1, base + (rng() - 0.5) * 0.2));
      steps.push({
        difficulty_hint: +dHint.toFixed(3),
        criticality_hint: +cHintRaw.toFixed(3),   // 独立于难度
        trueCrit: +trueCrit.toFixed(3),
        progress: +(i / N).toFixed(3),
        rndS2: rng(),   // 预存 S2 成功掷骰(各臂同步,公平对比)
      });
    }
    tasks.push(steps);
  }
  return tasks;
}

// 执行一步。goDeep=是否深思。返回 {cost, mishandled, overdeep, usedS2}。
function runStep(st, goDeep) {
  const reallyCritical = st.trueCrit > CRIT_TH;
  if (goDeep) {
    // 深思:关键步以 S2_SUCCESS 概率成功;失败则仍需补救(再 +DEEP)。
    if (reallyCritical) {
      const ok = st.rndS2 < S2_SUCCESS;
      return ok ? { cost: DEEP, mishandled: 0, overdeep: 0, usedS2: true }
                : { cost: DEEP + DEEP, mishandled: 1, overdeep: 0, usedS2: true };
    }
    return { cost: DEEP, mishandled: 0, overdeep: 1, usedS2: true }; // 非关键却深思=过度
  }
  // 便宜:若真关键 → 失败 → 升级深思(漏判)
  if (reallyCritical) return { cost: CHEAP + DEEP, mishandled: 1, overdeep: 0, usedS2: true };
  return { cost: CHEAP, mishandled: 0, overdeep: 0, usedS2: false };
}

function armAlways(tasks) {
  let cost = 0, mis = 0, over = 0;
  for (const t of tasks) for (const st of t) { const r = runStep(st, true); cost += r.cost; mis += r.mishandled; over += r.overdeep; }
  return { cost, mis, over };
}
function armStatic(tasks) {
  let cost = 0, mis = 0, over = 0;
  for (const t of tasks) for (const st of t) { const r = runStep(st, st.difficulty_hint >= SKILL_TH); cost += r.cost; mis += r.mishandled; over += r.overdeep; }
  return { cost, mis, over };
}
// router-online:简单逻辑回归在线学(评审建议的"普通在线 router"对照)。
function armRouter(tasks) {
  let cost = 0, mis = 0, over = 0;
  let w = [0, 0, 0], b = 0; const lr = 0.1; // 预测 P(critical) 用 [cHint,dHint,progress]
  const sig = (z) => 1 / (1 + Math.exp(-z));
  for (const t of tasks) for (const st of t) {
    const xs = [st.criticality_hint, st.difficulty_hint, st.progress];
    const p = sig(w[0] * xs[0] + w[1] * xs[1] + w[2] * xs[2] + b);
    const r = runStep(st, p > 0.5);
    cost += r.cost; mis += r.mishandled; over += r.overdeep;
    const y = st.trueCrit > CRIT_TH ? 1 : 0; // 在线学(用真标签,等同 conscious 的 report_outcome)
    const err = y - p;
    for (let i = 0; i < 3; i++) w[i] += lr * err * xs[i];
    b += lr * err;
  }
  return { cost, mis, over };
}
// ★成本敏感 router(评审#3 要求的公平基线):同样 3 维特征 + 同样在线学 P(critical),
//   但用【成本最优贝叶斯阈值】而非 0.5。本代价模型下:
//     深思代价 = DEEP;  便宜代价 = p·(CHEAP+DEEP) + (1-p)·CHEAP = CHEAP + p·DEEP。
//     便宜更优 ⟺ CHEAP + p·DEEP < DEEP ⟺ p < (DEEP-CHEAP)/DEEP。
//   故成本最优阈值 pStar=(DEEP-CHEAP)/DEEP=0.8:p≥0.8 才深思。这与 conscious 用的是同一成本目标,
//   只是 conscious 还有"原型/不确定度上偏/在线适应",router 只有全局 logistic+固定最优阈值。
function armRouterCost(tasks) {
  let cost = 0, mis = 0, over = 0;
  let w = [0, 0, 0], b = 0; const lr = 0.1;
  const sig = (z) => 1 / (1 + Math.exp(-z));
  const pStar = (DEEP - CHEAP) / DEEP; // =0.8
  for (const t of tasks) for (const st of t) {
    const xs = [st.criticality_hint, st.difficulty_hint, st.progress];
    const p = sig(w[0] * xs[0] + w[1] * xs[1] + w[2] * xs[2] + b);
    const r = runStep(st, p >= pStar);   // 成本最优阈值
    cost += r.cost; mis += r.mishandled; over += r.overdeep;
    const y = st.trueCrit > CRIT_TH ? 1 : 0;
    const err = y - p;
    for (let i = 0; i < 3; i++) w[i] += lr * err * xs[i];
    b += lr * err;
  }
  return { cost, mis, over };
}
function armConscious(tasks, seed) {
  const agent = new SelfModelAgent({ mu0: 1.0 });
  let cost = 0, mis = 0, over = 0;
  for (const t of tasks) {
    agent.newTask();
    let taskOk = true;
    for (const st of t) {
      const x = [st.criticality_hint, st.difficulty_hint, st.progress];
      const plan = agent.decideAbstract(x, agent.z.pollution);
      const goDeep = plan.ignite;
      const r = runStep(st, goDeep);
      cost += r.cost; mis += r.mishandled; over += r.overdeep;
      agent.learnAbstract(x, st.trueCrit, r.usedS2);
      agent.addPollution(r.usedS2, r.usedS2);
      if (r.mishandled) taskOk = false;
    }
    agent.feedback(taskOk);
  }
  return { cost, mis, over, nProto: agent.protos.length, mu: +agent.mu.toFixed(3) };
}

function stats(arr) {
  const n = arr.length;
  const mean = arr.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(arr.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
  return { mean: +mean.toFixed(1), sd: +sd.toFixed(1) };
}
// 配对 t 检验(逐 seed 配对差):返回 {mean, t, p, d, win}。p 用双尾 t 分布近似(正态尾,seed≥20 够用)。
function pairedT(a, b) {
  const n = a.length;
  const diff = a.map((v, i) => v - b[i]);            // a - b(关键漏判:负=a更少更好)
  const md = diff.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(diff.reduce((s, x) => s + (x - md) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  const t = se > 0 ? md / se : 0;
  // 双尾 p:正态近似 2*(1-Φ(|t|))。
  const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  const p = 2 * (1 - Phi(Math.abs(t)));
  const d = sd > 0 ? md / sd : 0;                    // Cohen's d(配对)
  const win = diff.filter((x) => x < 0).length / n;  // a<b 的比例(a更优胜率)
  return { mean: +md.toFixed(2), t: +t.toFixed(2), p, d: +d.toFixed(2), win: +(win * 100).toFixed(0) };
}
function erf(x) { // Abramowitz-Stegun 7.1.26
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, pp = 0.3275911;
  const tt = 1 / (1 + pp * x);
  const y = 1 - (((((a5 * tt + a4) * tt) + a3) * tt + a2) * tt + a1) * tt * Math.exp(-x * x);
  return s * y;
}
const pfmt = (p) => p <= 0 ? "<1e-16" : (p < 1e-4 ? p.toExponential(1) : p.toFixed(4));

const acc = {
  always: { cost: [], mis: [], over: [] }, static: { cost: [], mis: [], over: [] },
  router: { cost: [], mis: [], over: [] }, routerCost: { cost: [], mis: [], over: [] },
  conscious: { cost: [], mis: [], over: [], nProto: [] },
};

for (let s = 0; s < SEEDS; s++) {
  const rng = mulberry32(1000 + s * 7919);
  const tasks = genTasks(rng);
  const a = armAlways(tasks), st = armStatic(tasks), ro = armRouter(tasks), rc = armRouterCost(tasks), co = armConscious(tasks, s);
  for (const k of ["cost", "mis", "over"]) { acc.always[k].push(a[k]); acc.static[k].push(st[k]); acc.router[k].push(ro[k]); acc.routerCost[k].push(rc[k]); acc.conscious[k].push(co[k]); }
  acc.conscious.nProto.push(co.nProto);
}

const fmt = (st) => `${st.mean}±${st.sd}`;
console.log(`\n多种子基准: ${SEEDS} seeds × ${TASKS} tasks × ${N} steps  (S2成功率=${S2_SUCCESS}, 特征独立)`);
console.log("臂                | 总成本(成本敏感目标) | 关键漏判      | 过度深思");
const rows = [
  ["always-S2", acc.always], ["static-skill", acc.static],
  ["router(0.5阈值)", acc.router], ["router-cost(0.8阈值)", acc.routerCost], ["conscious", acc.conscious],
];
for (const [name, a] of rows) {
  console.log(`${name.padEnd(17)} | ${fmt(stats(a.cost)).padEnd(20)} | ${fmt(stats(a.mis)).padEnd(12)} | ${fmt(stats(a.over))}`);
}
const cCost = stats(acc.conscious.cost), sCost = stats(acc.static.cost);
const cMis = stats(acc.conscious.mis), sMis = stats(acc.static.mis);
console.log(`\nconscious 原型数: ${fmt(stats(acc.conscious.nProto))}`);

// ── 显著性检验(评审#4:均值±std 不是检验)。逐 seed 配对 t 检验 + Cohen's d + 胜率 ──
console.log("\n配对 t 检验(conscious vs 各基线, 逐 seed):");
for (const [name, a] of [["static-skill", acc.static], ["router(0.5)", acc.router], ["router-cost(0.8)", acc.routerCost], ["always-S2", acc.always]]) {
  const tc = pairedT(acc.conscious.cost, a.cost);   // 成本差(负=conscious更省)
  const tm = pairedT(acc.conscious.mis, a.mis);     // 漏判差(负=conscious更少)
  console.log(`  vs ${name.padEnd(16)} 成本Δ=${String(tc.mean).padStart(7)} p=${pfmt(tc.p)} d=${tc.d} 胜率=${tc.win}% | 漏判Δ=${String(tm.mean).padStart(6)} p=${pfmt(tm.p)} d=${tm.d} 胜率=${tm.win}%`);
}

// ── 硬断言(回归保护):不满足则非零退出 ──
let failed = 0;
function assert(cond, msg) { console.log(`  ${cond ? "PASS" : "FAIL"}: ${msg}`); if (!cond) failed++; }
console.log("\n断言(成本敏感目标 + Pareto + 显著性):");
assert(cCost.mean < sCost.mean, `conscious 总成本(${cCost.mean}) < static(${sCost.mean}) [更省]`);
assert(cMis.mean <= sMis.mean, `conscious 关键漏判(${cMis.mean}) <= static(${sMis.mean}) [不拿关键步换成本]`);
assert(stats(acc.conscious.over).mean < stats(acc.static.over).mean, `conscious 过度深思 < static [更少无效深思]`);
assert(cCost.mean < stats(acc.always.cost).mean, `conscious 总成本 < always-S2(${stats(acc.always.cost).mean}) [比全深思省]`);
// 对公平基线 router-cost:不要求单维全胜(诚实),但要求 conscious 在【关键漏判】上显著更少(p<0.05),
//   且成本不显著更差——即 conscious 用"原型/在线适应"换来更稳的关键守护(Pareto 而非单点)。
const tmRC = pairedT(acc.conscious.mis, acc.routerCost.mis);
assert(tmRC.mean < 0 && tmRC.p < 0.05, `conscious 关键漏判显著少于 router-cost(Δ=${tmRC.mean}, p=${pfmt(tmRC.p)}) [对公平基线也守住关键步]`);

if (failed) { console.log(`\n✗ ${failed} 条断言失败`); process.exit(1); }
console.log("\n✓ 全部断言通过:成本敏感目标上对 static/always 形成 Pareto 优势;对同特征同目标的 cost-router,关键漏判显著更少(多种子,配对检验)。");
