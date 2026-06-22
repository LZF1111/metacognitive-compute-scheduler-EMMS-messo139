/**
 * exp_cluster.mjs —— beta-mesoscale2 本机对比:逐步层(原) vs 子目标簇层(改进)。
 *
 * ── 唯一自变量 ──
 *   两臂【共用同一个单元引擎 SelfModelAgent】、同一份任务数据(配对)、同一套 oracle 学习信号。
 *   差异只在介尺度:
 *     • arm "step"    = 原 beta-mesoscale:单元=单步,直接拿【该步的(带噪)hint】竞价。
 *     • arm "cluster" = beta-mesoscale2:单元=子目标簇,拿【簇内已见步的聚合 hint】竞价 + 簇内latch。
 *
 * ── 任务结构(为什么这能区分两者)──
 *   每个任务由若干【子目标簇】拼成。一个簇有一个【潜在簇关键度 clCrit】(整簇共享,强耦合)。
 *   簇内每步的 trueCrit ≈ clCrit(簇内相干),但【单步 hint = clCrit + 噪声】(单步信号弱/带噪)。
 *   现实对应:一个"改核心逻辑→跑回归→部署"子目标里每步都关键,但某一步表面看着平平。
 *
 *   关键的乘法耦合(EMMS):任务正确 = Π P(step)。簇内任一真关键步漏判 → 该簇失败 → 任务失败。
 *   逐步层靠单步带噪 hint,关键簇里"看着平平"的那步容易漏判 → 清零整任务。
 *   簇层把簇内弱信号聚合 → 恢复 clCrit → 整簇一起进浓相(System2),救回漏判。
 *
 * 用法: node exp_cluster.mjs [seeds=24] [tasks=80] [noise=0.28]
 */
import { SelfModelAgent } from "./selfModel.mjs";
import { ClusterAgent } from "./clusterAgent.mjs";

const SEEDS = parseInt(process.argv[2] || "24", 10);
const TASKS = parseInt(process.argv[3] || "80", 10);
const NOISE = parseFloat(process.argv[4] || "0.28"); // 单步 hint 相对簇潜在关键度的噪声幅度

const CHEAP = 1, DEEP = 5;       // 便宜处理=1, 深思=5
const CRIT_TH = 0.6;             // 真关键度阈值(>阈值=真关键)
const S2_SUCCESS = 0.9;          // 深思把关键步做对的概率(非100%)

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

/**
 * 生成带【显式子目标簇】的任务集。每任务 = 一串簇;每簇 2~4 步。
 * 簇潜在关键度 clCrit ~ U(0,1)。簇内步 trueCrit ≈ clCrit(小抖动),hint = clCrit + 大噪声。
 * 返回 tasks: Array<task>,task = Array<cluster>,cluster = {steps:[...]}。
 */
function genTasks(rng) {
  const tasks = [];
  for (let k = 0; k < TASKS; k++) {
    const clusters = [];
    const nCl = 3 + Math.floor(rng() * 3); // 3~5 个簇
    for (let c = 0; c < nCl; c++) {
      const clCrit = rng();                       // 簇潜在关键度(整簇共享)
      const len = 2 + Math.floor(rng() * 3);      // 簇长 2~4 步
      const steps = [];
      for (let i = 0; i < len; i++) {
        // 簇内步真关键度:围绕 clCrit 小抖动(强耦合相干)
        const trueCrit = clamp01(clCrit + (rng() - 0.5) * 0.12);
        // 单步关键度 hint:clCrit + 大噪声(单步信号弱/带噪)——这是逐步层会被骗的地方
        const cHint = clamp01(clCrit + (rng() - 0.5) * 2 * NOISE);
        // 难度 hint:与关键度部分解耦的独立信号
        const dHint = clamp01(0.5 * clCrit + 0.5 * rng());
        steps.push({
          criticality_hint: +cHint.toFixed(3),
          difficulty_hint: +dHint.toFixed(3),
          trueCrit: +trueCrit.toFixed(3),
          rndS2: rng(),
        });
      }
      clusters.push({ clCrit, steps });
    }
    tasks.push(clusters);
  }
  return tasks;
}

// 执行一步。goDeep=是否深思。返回 {cost, mishandled, overdeep, usedS2}。
function runStep(st, goDeep) {
  const reallyCritical = st.trueCrit > CRIT_TH;
  if (goDeep) {
    if (reallyCritical) {
      const ok = st.rndS2 < S2_SUCCESS;
      return ok ? { cost: DEEP, mishandled: 0, overdeep: 0, usedS2: true }
                : { cost: DEEP + DEEP, mishandled: 1, overdeep: 0, usedS2: true };
    }
    return { cost: DEEP, mishandled: 0, overdeep: 1, usedS2: true }; // 非关键却深思=过度
  }
  if (reallyCritical) return { cost: CHEAP + DEEP, mishandled: 1, overdeep: 0, usedS2: true }; // 漏判
  return { cost: CHEAP, mishandled: 0, overdeep: 0, usedS2: false };
}

// 全局进度(0..1):用于第三维特征。
function withProgress(clusters) {
  const total = clusters.reduce((s, c) => s + c.steps.length, 0);
  let seen = 0; const out = [];
  for (const c of clusters) {
    const cs = [];
    for (const st of c.steps) { cs.push({ ...st, progress: +(seen / total).toFixed(3) }); seen++; }
    out.push({ ...c, steps: cs });
  }
  return out;
}

// ── arm: 逐步层(原 beta-mesoscale)──
function armStep(tasks) {
  const agent = new SelfModelAgent({ mu0: 1.0 });
  let cost = 0, mis = 0, over = 0, taskFail = 0, deep = 0, nStep = 0;
  for (const t0 of tasks) {
    const t = withProgress(t0);
    agent.newTask();
    let taskOk = true;
    for (const c of t) for (const st of c.steps) {
      const x = [st.criticality_hint, st.difficulty_hint, st.progress];
      const d = agent.decideAbstract(x, agent.z.pollution);
      const r = runStep(st, d.ignite);
      cost += r.cost; mis += r.mishandled; over += r.overdeep; nStep++;
      if (r.usedS2) deep++;
      agent.learnAbstract(x, st.trueCrit, r.usedS2);
      agent.addPollution(r.usedS2, r.usedS2);
      if (r.mishandled) taskOk = false;
    }
    if (!taskOk) taskFail++;
    agent.feedback(taskOk);
  }
  return { cost, mis, over, taskFail, deepRate: +(deep / nStep).toFixed(3) };
}

// ── arm: 子目标簇层(beta-mesoscale2)──
function armCluster(tasks, clusterOpts) {
  const agent = new ClusterAgent({ mu0: 1.0 }, clusterOpts);
  let cost = 0, mis = 0, over = 0, taskFail = 0, deep = 0, nStep = 0;
  for (const t0 of tasks) {
    const t = withProgress(t0);
    agent.newTask();
    let taskOk = true;
    for (const c of t) {
      agent.startCluster();   // 显式子目标簇边界
      for (const st of c.steps) {
        const d = agent.decideStep(st);
        const r = runStep(st, d.ignite);
        cost += r.cost; mis += r.mishandled; over += r.overdeep; nStep++;
        if (r.usedS2) deep++;
        agent.learnStep(st, st.trueCrit, r.usedS2);
        agent.addPollution(r.usedS2, r.usedS2);
        if (r.mishandled) taskOk = false;
      }
    }
    if (!taskOk) taskFail++;
    agent.feedback(taskOk);
  }
  return { cost, mis, over, taskFail, deepRate: +(deep / nStep).toFixed(3) };
}

function summarize(rows) {
  const keys = ["cost", "mis", "over", "taskFail", "deepRate"];
  const out = {};
  for (const k of keys) {
    const a = rows.map((r) => r[k]);
    const m = a.reduce((s, x) => s + x, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
    out[k] = { mean: +m.toFixed(2), sd: +sd.toFixed(2) };
  }
  return out;
}

function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
// 配对差 a-b(负=a更少更好)
function pairedT(a, b) {
  const n = a.length;
  const diff = a.map((v, i) => v - b[i]);
  const md = diff.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(diff.reduce((s, x) => s + (x - md) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  const t = se > 0 ? md / se : 0;
  const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  const p = 2 * (1 - Phi(Math.abs(t)));
  const win = diff.filter((x) => x < 0).length / n;
  return { mean: +md.toFixed(2), t: +t.toFixed(2), p: +p.toFixed(4), win: +(win * 100).toFixed(0) };
}

// ── 主跑 ──
const rowsStep = [], rowsCl = [], rowsClNoLatch = [];
for (let s = 0; s < SEEDS; s++) {
  const tasks = genTasks(mulberry32(1000 + s * 7));
  rowsStep.push(armStep(tasks));
  rowsCl.push(armCluster(tasks, { aggregate: "running", latch: true }));
  rowsClNoLatch.push(armCluster(tasks, { aggregate: "running", latch: false }));
}

const S = summarize(rowsStep), C = summarize(rowsCl), CN = summarize(rowsClNoLatch);
console.log(`\n=== beta-mesoscale2 本机对比 (seeds=${SEEDS}, tasks=${TASKS}, hint噪声=±${NOISE}) ===`);
console.log(`代价模型: 便宜=${CHEAP} 深思=${DEEP}; 真关键阈值=${CRIT_TH}; S2成功率=${S2_SUCCESS}`);
const fmt = (o) => `cost=${o.cost.mean}±${o.cost.sd}  关键漏判=${o.mis.mean}±${o.mis.sd}  过度深思=${o.over.mean}±${o.over.sd}  任务失败=${o.taskFail.mean}±${o.taskFail.sd}  深思率=${o.deepRate.mean}`;
console.log(`\n[step]         逐步层(原)        ${fmt(S)}`);
console.log(`[cluster]      子目标簇+latch     ${fmt(C)}`);
console.log(`[cluster-nL]   子目标簇 无latch    ${fmt(CN)}`);

console.log(`\n--- 配对检验 cluster(+latch) vs step (差=cluster-step, 负=簇层更优) ---`);
for (const k of ["mis", "taskFail", "cost", "over"]) {
  const r = pairedT(rowsCl.map((x) => x[k]), rowsStep.map((x) => x[k]));
  const sig = r.p < 0.01 ? "***" : r.p < 0.05 ? "**" : r.p < 0.1 ? "*" : "";
  console.log(`  ${k.padEnd(9)} Δ=${String(r.mean).padStart(7)}  t=${String(r.t).padStart(6)}  p=${r.p}  胜率=${r.win}%  ${sig}`);
}

// 诚实判定:簇层的核心承诺 = 在带噪 hint 下显著降低【关键漏判】与【任务失败】,代价不应暴涨。
const misR = pairedT(rowsCl.map((x) => x.mis), rowsStep.map((x) => x.mis));
const failR = pairedT(rowsCl.map((x) => x.taskFail), rowsStep.map((x) => x.taskFail));
const costR = pairedT(rowsCl.map((x) => x.cost), rowsStep.map((x) => x.cost));
console.log(`\n--- 诚实结论 ---`);
const misWin = misR.mean < 0 && misR.p < 0.05;
const failWin = failR.mean < 0 && failR.p < 0.05;
console.log(`关键漏判: 簇层${misWin ? "显著更少 ✅" : "未显著更少"} (Δ=${misR.mean}, p=${misR.p})`);
console.log(`任务失败: 簇层${failWin ? "显著更少 ✅" : "未显著更少"} (Δ=${failR.mean}, p=${failR.p})`);
console.log(`总代价:   簇层相对 step ${costR.mean <= 0 ? "更低/持平" : "更高"} (Δ=${costR.mean}, p=${costR.p})`);
const verdict = misWin || failWin;
console.log(`\n判定: 子目标簇介尺度 ${verdict ? "在带噪单步 hint 下确有可证实的改进(漏判/失败更低)。" : "未展现显著改进——需检查噪声/耦合设定。"}`);
process.exit(0);
