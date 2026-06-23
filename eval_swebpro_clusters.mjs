/**
 * eval_swebpro_clusters.mjs —— 介尺度【自动簇发现】在【真实 SWE-bench Pro 轨迹】上的可证伪评估。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 正面回答两个硬指标(也是介尺度层唯一算数的证明):
 *   (M1) 少漏关键子任务: 簇路由的 critical-subtask miss  <  逐步路由的 miss
 *   (M2) 没靠多烧强模型: 簇路由的 System2 调用数 / 估算 token  不显著高于逐步基线
 * 两个【同时】成立才算赢(只少漏判但狂烧 S2 = 无脑升级换成功率,不算)。
 *
 * ★诚实边界(与 swebpReal.mjs 头部一致):
 *   真实: 每个 instance 的共改文件集合(解析 gold patch)、每文件符号、仓库/路径/测试。
 *   建模: 单步 hint 噪声、System2 成功率、干扰步混入(同仓库其它真实 instance 的真实文件)。
 *   簇边界【不喂】,两臂都看不到 pr 标签;簇臂只能靠真实文件/符号重叠在线发现 →
 *     发现对 = 救回"看着平平但其实关键"的同 PR 步(M1↑);乱聚 = 浪费 S2(M2↓被惩罚)。非循环论证。
 *
 * 臂逻辑/数据加载全部复用 swebpReal.mjs(与配图 gen_fig_data.mjs 同一底座,不分叉)。
 *
 * 用法: node eval_swebpro_clusters.mjs [--data <jsonl>] [--seeds 20] [--sessions 60] [--noise 0.3]
 */
import path from "node:path";
import {
  DEFAULT_DATA, CRIT_TH, S2_SUCCESS, CHEAP_TOK, DEEP_TOK,
  mulberry32, loadInstances, buildSession,
  armStep, armCluster, armAlwaysS2, pairedT, mean,
} from "./swebpReal.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const DATA = arg("--data", DEFAULT_DATA);
const SEEDS = parseInt(arg("--seeds", "20"), 10);
const SESSIONS = parseInt(arg("--sessions", "60"), 10);
const NOISE = parseFloat(arg("--noise", "0.3"));

(async () => {
  console.log(`[eval] 载入真实 SWE-bench Pro 轨迹: ${path.basename(DATA)}`);
  let byRepo;
  try { byRepo = await loadInstances(DATA); }
  catch (e) { console.error("[eval] " + e.message); process.exit(2); }
  const repos = Object.entries(byRepo).filter(([, v]) => v.length >= 5).sort((a, b) => b[1].length - a[1].length);
  console.log(`[eval] 多文件 PR 子目标可用仓库: ${repos.map(([r, v]) => `${r.split("/").pop()}(${v.length})`).join(", ")}`);

  const rowsStep = { miss: [], s2: [], tok: [], prFail: [] };
  const rowsCl = { miss: [], s2: [], tok: [], prFail: [] };
  const rowsS2 = { miss: [], s2: [], tok: [], prFail: [] };
  let totPr = 0;

  for (let s = 0; s < SEEDS; s++) {
    const rng = mulberry32(7919 + s * 31);
    const [, pool] = repos[Math.floor(rng() * repos.length)];
    const sessions = [];
    for (let i = 0; i < SESSIONS; i++) sessions.push(buildSession(pool, rng, NOISE));

    const aS = armStep(sessions), aC = armCluster(sessions), a2 = armAlwaysS2(sessions);
    totPr = aS.prTotal;
    rowsStep.miss.push(aS.miss); rowsStep.s2.push(aS.s2); rowsStep.tok.push(aS.tok); rowsStep.prFail.push(aS.prFail);
    rowsCl.miss.push(aC.miss); rowsCl.s2.push(aC.s2); rowsCl.tok.push(aC.tok); rowsCl.prFail.push(aC.prFail);
    rowsS2.miss.push(a2.miss); rowsS2.s2.push(a2.s2); rowsS2.tok.push(a2.tok); rowsS2.prFail.push(a2.prFail);
  }

  console.log(`\n=== 真实 SWE-bench Pro 轨迹上的介尺度评估 (seeds=${SEEDS}, sessions/seed=${SESSIONS}, hint噪声=±${NOISE}) ===`);
  console.log(`代价模型(估算token): System1=${CHEAP_TOK}, System2=${DEEP_TOK}; 真关键阈=${CRIT_TH}; S2成功率=${S2_SUCCESS}`);
  console.log(`\n指标(每 seed 汇总,均值):`);
  console.log(`  ${"臂".padEnd(12)} 关键漏判↓   S2调用数↓   估算token↓   子任务失败↓`);
  const fmt = (n, r) => `${n.padEnd(12)} ${String(mean(r.miss)).padEnd(10)} ${String(mean(r.s2)).padEnd(10)} ${String(mean(r.tok)).padEnd(11)} ${mean(r.prFail)}/${totPr}`;
  console.log(`  ${fmt("step(逐步)", rowsStep)}`);
  console.log(`  ${fmt("cluster(簇)", rowsCl)}`);
  console.log(`  ${fmt("always-S2", rowsS2)}`);

  const m1 = pairedT(rowsCl.miss, rowsStep.miss);
  const m2 = pairedT(rowsCl.s2, rowsStep.s2);
  const m2tok = pairedT(rowsCl.tok, rowsStep.tok);
  console.log(`\n── 配对检验(簇 vs 逐步, 每 seed 配对) ──`);
  console.log(`  (M1) 关键漏判差 = ${m1.mean}  t=${m1.t}  p=${m1.p}  簇更少的seed占比=${m1.winRate}%`);
  console.log(`  (M2) S2调用差   = ${m2.mean}  t=${m2.t}  p=${m2.p}   |  token差=${m2tok.mean} (p=${m2tok.p})`);

  const s2BudgetSlack = 0.10;
  const baseS2 = mean(rowsStep.s2);
  const clS2 = mean(rowsCl.s2);
  const M1pass = m1.mean < 0 && m1.p < 0.05;
  const M2pass = clS2 <= baseS2 * (1 + s2BudgetSlack);
  console.log(`\n── 硬判定 ──`);
  console.log(`  M1 少漏关键子任务: ${M1pass ? "✅ PASS" : "❌ FAIL"} (簇漏判${M1pass ? "显著少于" : "未显著少于"}逐步)`);
  console.log(`  M2 没多烧强模型 : ${M2pass ? "✅ PASS" : "❌ FAIL"} (簇 S2=${clS2} ≤ 逐步 S2=${baseS2}×${1 + s2BudgetSlack})`);
  console.log(`  介尺度层结论    : ${M1pass && M2pass ? "✅ 在真实轨迹上同时满足 M1+M2 — 介尺度增益成立(非无脑升级)"
    : "❌ 未同时满足 — 介尺度层在此设定下未被证明(如实报告)"}`);
  process.exit(M1pass && M2pass ? 0 : 1);
})();
