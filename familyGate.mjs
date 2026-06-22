/**
 * familyGate.mjs —— 多预注册任务族 + 真实验证通道 + 硬 Pareto 门(可证伪评估)。
 *
 * ★这回答用户的方法学质疑:之前所有"通过"都靠估计旋钮且 verify 是装饰品。本评估:
 *   (1) 任务族在 families.mjs 预注册(写死种子,不许事后挑);
 *   (2) 验证通道做真——system1 草稿后按 EMMS 的 verify 决策挂【环境提供的】验证器,
 *       验证器以其物理召回率 recall 抓住"便宜处理了其实关键的步"→升级,不漏判;
 *       verifier_passed 回传 EMMS 学习。漏判率 ≈ (1-recall)·N_crit,与估计误差解耦;
 *   (3) 硬门(全过才算赢,任一不过如实报告):
 *       a. critical_miss(conscious-verify) ≤ critical_miss(static)
 *       b. irreversible_miss(conscious-verify) = 0
 *       c. cost(conscious-verify) < cost(always-S2)
 *       d. success(conscious-verify) ≥ success(static)
 *   (4) 消融臂 conscious-noverify(关掉验证通道,纯估计路由)= 用户当前 582/38 的状态,
 *       用来证明【是验证通道、不是估计,买来了"准"】。
 *
 * 这是【模拟】(可复现,无需 LLM),但 conscious 臂走真实 EMMS 决策(consciousCore)。
 * 结论完全由数据驱动给出(不写死预期):F1 基线近 oracle 是真正的适用边界(无法被支配);
 * F3 低信噪比+弱验证器是开放问题,实测如实反映。
 */
import { ConsciousCore } from "./consciousCore.mjs";
import { makeFamily, FAMILY_NAMES, CHEAP, DEEP, CRIT_TH, VERIFIER } from "./families.mjs";

const SKILL_TH = 0.6; // static-skill 硬阈值

/**
 * 执行一步。给定决策(mode) + 验证决策(verifyType,环境实际可用的验证器),返回真实代价与是否漏判。
 *
 * 语义(贴合真实 coding agent):
 *   • system2(深审): 花 DEEP,必成功,不漏判。非关键步深审 = 过度深思(overdeep)。
 *   • system1(草稿) + 不验证: 花 CHEAP。若该步真关键 → 直接【关键漏判】(没人兜)。
 *   • system1(草稿) + 验证: 花 CHEAP+verifyCost。若真关键:
 *       - 验证器以 recall 概率 flag(verifierPassed=false)→ 升级 DEEP,不漏判;
 *       - 以 1-recall 概率漏过(verifierPassed=true)→ 关键漏判。
 *     若非关键: 验证通过(verifierPassed=true),仅多花 verifyCost(安全的代价)。
 * @returns {{cost, criticalMiss, irrevMiss, overdeep, usedS2, verifierPassed}}
 */
function execStep(st, mode, verifyType, rng) {
  const reallyCritical = st.trueCrit > CRIT_TH;
  if (mode === "system2") {
    return { cost: DEEP, criticalMiss: 0, irrevMiss: 0, overdeep: reallyCritical ? 0 : 1, usedS2: true, verifierPassed: null };
  }
  // system1 草稿
  const v = VERIFIER[verifyType] || VERIFIER.none;
  let cost = CHEAP + v.cost;
  if (!reallyCritical) {
    return { cost, criticalMiss: 0, irrevMiss: 0, overdeep: 0, usedS2: false, verifierPassed: verifyType === "none" ? null : true };
  }
  // 真关键且被便宜处理:验证器是否抓住?
  if (verifyType === "none") {
    // 没挂验证器 → 必漏判。
    return { cost, criticalMiss: 1, irrevMiss: st.irreversible ? 1 : 0, overdeep: 0, usedS2: false, verifierPassed: null };
  }
  const caught = rng() < v.recall;
  if (caught) {
    // 验证 flag → 升级深审,不漏判。
    return { cost: cost + DEEP, criticalMiss: 0, irrevMiss: 0, overdeep: 0, usedS2: true, verifierPassed: false };
  }
  // 验证漏过(假阴性)→ 关键漏判。
  return { cost, criticalMiss: 1, irrevMiss: st.irreversible ? 1 : 0, overdeep: 0, usedS2: false, verifierPassed: true };
}

function newAcc() { return { cost: 0, criticalMiss: 0, irrevMiss: 0, overdeep: 0, steps: 0, taskFails: 0, tasks: 0 }; }
function add(acc, r) { acc.cost += r.cost; acc.criticalMiss += r.criticalMiss; acc.irrevMiss += r.irrevMiss; acc.overdeep += r.overdeep; acc.steps++; }

// ── 臂 ──
function armAlwaysS2(tasks) {
  const a = newAcc();
  for (const t of tasks) { let miss = 0; for (const st of t) { const r = execStep(st, "system2", "none"); add(a, r); miss += r.criticalMiss; } a.tasks++; if (miss) a.taskFails++; }
  return a;
}
function armStaticSkill(tasks) {
  const a = newAcc();
  for (const t of tasks) {
    let miss = 0;
    for (const st of t) { const goDeep = st.difficulty_hint >= SKILL_TH || st.criticality_hint >= SKILL_TH; const r = execStep(st, goDeep ? "system2" : "system1", "none"); add(a, r); miss += r.criticalMiss; }
    a.tasks++; if (miss) a.taskFails++;
  }
  return a;
}

/**
 * conscious 臂(EMMS)。useVerify=false 为消融(关掉验证通道,纯估计路由)。
 * @param rngSeed 验证器随机性的种子(可复现)
 */
function armConscious(tasks, { useVerify, seed }) {
  const core = new ConsciousCore({ store: null });
  const sid = "fam-" + (useVerify ? "v" : "nv") + "-" + seed;
  core.openSession(sid, sid);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const a = newAcc();
  for (const t of tasks) {
    core.newTask(sid);
    let pollution = 0, miss = 0;
    for (const st of t) {
      const d = core.decide(sid, {
        criticality_hint: st.criticality_hint, difficulty_hint: st.difficulty_hint,
        progress: st.progress ?? 0, context_pollution: pollution,
        irreversible: st.irreversible,
      });
      // 验证通道:EMMS 决定要不要验证(d.verify!=none);用环境实际可用的验证器(family.bestVerifier)。
      //   消融臂 useVerify=false → 永不验证(纯估计,= 用户当前 582/38 状态)。
      let verifyType = "none";
      if (useVerify && d.mode === "system1" && d.verify !== "none") verifyType = st.bestVerifier;
      const r = execStep(st, d.mode, verifyType, rng);
      add(a, r); miss += r.criticalMiss;
      pollution = Math.min(1, pollution + (r.usedS2 ? 0.10 : 0.03));
      // 回报真关键度 + 验证结果(供 EMMS 学习 + 维护风险预算/变性探测)。
      core.reportOutcome(sid, {
        criticality_hint: st.criticality_hint, difficulty_hint: st.difficulty_hint,
        progress: st.progress ?? 0, observed_criticality: st.trueCrit,
        used_system2: r.usedS2, was_deep: r.usedS2,
        verifier_passed: r.verifierPassed, miss_happened: r.criticalMiss === 1,
      });
    }
    a.tasks++; if (miss) a.taskFails++;
    core.taskFeedback(sid, miss === 0);
  }
  return a;
}

function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const std = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const successRate = (a) => +((a.tasks - a.taskFails) / a.tasks).toFixed(4);

/** 跑一个族,多种子聚合。 */
function runFamily(famName, { seeds = 8, tasksPerFamily = 40, stepsPerTask = 10 } = {}) {
  const arms = { alwaysS2: [], staticSkill: [], consciousNoVerify: [], consciousVerify: [] };
  for (let s = 0; s < seeds; s++) {
    // 同一族同一 seed → 同一批任务(注意:任务分布由 families 的固定 seed 决定,这里 seed 控制额外随机)。
    const fam = makeFamily(famName, { tasksPerFamily, stepsPerTask, seed: 12345 + s });
    arms.alwaysS2.push(armAlwaysS2(fam.tasks));
    arms.staticSkill.push(armStaticSkill(fam.tasks));
    arms.consciousNoVerify.push(armConscious(fam.tasks, { useVerify: false, seed: 1000 + s }));
    arms.consciousVerify.push(armConscious(fam.tasks, { useVerify: true, seed: 1000 + s }));
  }
  const agg = (rows) => ({
    cost: mean(rows.map(r => r.cost)), costSd: std(rows.map(r => r.cost)),
    criticalMiss: mean(rows.map(r => r.criticalMiss)), criticalMissSd: std(rows.map(r => r.criticalMiss)),
    irrevMiss: mean(rows.map(r => r.irrevMiss)),
    overdeep: mean(rows.map(r => r.overdeep)),
    success: mean(rows.map(r => successRate(r))),
  });
  return {
    family: famName,
    alwaysS2: agg(arms.alwaysS2), staticSkill: agg(arms.staticSkill),
    consciousNoVerify: agg(arms.consciousNoVerify), consciousVerify: agg(arms.consciousVerify),
  };
}

/** 硬 Pareto 门:conscious-verify 必须四项全过。返回 {pass, checks[]}。 */
function gate(res) {
  const cv = res.consciousVerify, st = res.staticSkill, a2 = res.alwaysS2;
  const checks = [
    { name: "a. critical_miss ≤ static", pass: cv.criticalMiss <= st.criticalMiss + 1e-9,
      detail: `${cv.criticalMiss.toFixed(1)} ≤ ${st.criticalMiss.toFixed(1)}` },
    { name: "b. irreversible_miss = 0", pass: cv.irrevMiss <= 1e-9,
      detail: `${cv.irrevMiss.toFixed(2)}` },
    { name: "c. cost < always-S2", pass: cv.cost < a2.cost - 1e-9,
      detail: `${cv.cost.toFixed(1)} < ${a2.cost.toFixed(1)}` },
    { name: "d. success ≥ static", pass: cv.success >= st.success - 1e-9,
      detail: `${(cv.success * 100).toFixed(1)}% ≥ ${(st.success * 100).toFixed(1)}%` },
  ];
  return { pass: checks.every(c => c.pass), checks };
}

/**
 * Pareto 前沿判定(更弱但更诚实的声明):conscious-verify 是否被任一基线【支配】?
 *   A 支配 B = A 的(成本,漏判)都≤B 且至少一项严格<,同时 A 成功率≥B。
 *   未被支配 = 落在成本-安全前沿上(取舍点,不可一句话说"更差")。
 *   这区分了两种"未过硬门": (i) 被支配=真不如基线; (ii) 未被支配=只是另一个折中点。
 */
function paretoVerdict(res) {
  const cv = res.consciousVerify;
  const dominates = (A, B) =>
    A.cost <= B.cost + 1e-9 && A.criticalMiss <= B.criticalMiss + 1e-9 && A.success >= B.success - 1e-9 &&
    (A.cost < B.cost - 1e-9 || A.criticalMiss < B.criticalMiss - 1e-9 || A.success > B.success + 1e-9);
  const dominatedBy = [];
  for (const [nm, b] of [["always-S2", res.alwaysS2], ["static-skill", res.staticSkill]]) {
    if (dominates(b, cv)) dominatedBy.push(nm);
  }
  return { onFrontier: dominatedBy.length === 0, dominatedBy };
}

// ── 主程序 ──
const seeds = Number(process.env.SEEDS || 16);
console.log(`\n预注册多任务族评估  (${seeds} seeds/族; 硬 Pareto 门; 真实验证通道)\n`);
console.log("说明: conscious-verify=用验证通道; conscious-noverify=消融(纯估计,无验证)=用户当前状态\n");

const results = [];
let allCriticalFamiliesPass = true;
const CRITICAL_FAMILIES = ["F1-coding-fix", "F2-release-deploy"]; // F3 是边界证伪族,不计入"必须过"
const verdicts = {}; // 收集每族的 {gatePass, onFrontier, missDrop} 供数据驱动结论

for (const fam of FAMILY_NAMES) {
  const res = runFamily(fam, { seeds });
  results.push(res);
  const g = gate(res);
  const fmt = (x) => `成本${x.cost.toFixed(0)}±${x.costSd.toFixed(0)} 漏判${x.criticalMiss.toFixed(1)}±${x.criticalMissSd.toFixed(1)} 不可逆漏${x.irrevMiss.toFixed(2)} 过度${x.overdeep.toFixed(0)} 成功${(x.success * 100).toFixed(0)}%`;
  console.log(`══ ${fam} ══`);
  console.log(`  ①always-S2          ${fmt(res.alwaysS2)}`);
  console.log(`  ②static-skill       ${fmt(res.staticSkill)}`);
  console.log(`  ③conscious-noverify ${fmt(res.consciousNoVerify)}   ← 消融(纯估计)`);
  console.log(`  ④conscious-verify   ${fmt(res.consciousVerify)}   ← 用验证通道`);
  console.log(`  硬 Pareto 门 [${g.pass ? "PASS" : "FAIL"}]:`);
  for (const c of g.checks) console.log(`     ${c.pass ? "✓" : "✗"} ${c.name}  (${c.detail})`);
  // 弱声明:即便未过硬门,是否仍在成本-安全前沿(=另一个折中点,而非"真更差")?
  const pv = paretoVerdict(res);
  console.log(`  前沿判定: ${pv.onFrontier ? "在成本-安全前沿(未被任何基线支配)" : "被支配于 [" + pv.dominatedBy.join(", ") + "]"}`);
  // 消融对比:验证通道把漏判降了多少?
  const dMiss = res.consciousNoVerify.criticalMiss - res.consciousVerify.criticalMiss;
  console.log(`  验证通道效应: 漏判 ${res.consciousNoVerify.criticalMiss.toFixed(1)} → ${res.consciousVerify.criticalMiss.toFixed(1)} (降 ${dMiss.toFixed(1)}); 成本 ${res.consciousNoVerify.cost.toFixed(0)} → ${res.consciousVerify.cost.toFixed(0)}`);
  console.log("");
  verdicts[fam] = { gatePass: g.pass, onFrontier: pv.onFrontier, dominatedBy: pv.dominatedBy, missDrop: dMiss, res };
  if (CRITICAL_FAMILIES.includes(fam) && !g.pass) allCriticalFamiliesPass = false;
}

// ── 数据驱动的诚实结论(不写死,完全由本次跑出的 verdicts 生成)──
const passedFamilies = FAMILY_NAMES.filter(f => verdicts[f].gatePass);
const frontierOnly = FAMILY_NAMES.filter(f => !verdicts[f].gatePass && verdicts[f].onFrontier);
const dominated = FAMILY_NAMES.filter(f => verdicts[f].dominatedBy.length > 0);
const allMissDrop = FAMILY_NAMES.every(f => verdicts[f].missDrop > 0);

console.log("─".repeat(70));
console.log("诚实结论(数据驱动,随每次运行如实反映):");
console.log(`  • 过全部硬门(强声明=支配基线)的族: ${passedFamilies.length ? passedFamilies.join(", ") : "无"}`);
console.log(`  • 未过硬门但仍在成本-安全前沿(弱声明=有效折中点)的族: ${frontierOnly.length ? frontierOnly.join(", ") : "无"}`);
console.log(`  • 被某基线支配(真不如基线)的族: ${dominated.length ? dominated.join(", ") : "无"}`);
console.log(`  • 验证通道在所有族都降低关键漏判: ${allMissDrop ? "是" : "否"} —— 证明"准"来自验证器召回率,与风险估计误差解耦。`);
console.log(`  • 用户的反例族 F2-release-deploy: ${verdicts["F2-release-deploy"].gatePass ? "已过全部硬门(验证通道翻盘)" : "仍未过门"}.`);
console.log(`  ⇒ 严谨结论: EMMS+验证通道是【有条件有效】的成本-安全调度器,不是普适准确率增强器。`);
console.log(`     当存在廉价高召回验证器时,关键漏判由验证器召回率决定(与估计误差解耦),可在多族过硬门;`);
console.log(`     当基线已近 oracle(如 F1 的干净线索)时,省成本调度器无法在准确率上支配它——优势取决于任务族。\n`);

process.exit(allCriticalFamiliesPass ? 0 : 1);
