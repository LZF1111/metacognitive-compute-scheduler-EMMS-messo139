/**
 * gen_fig_data.mjs —— 采集论文/README 配图所需的全部数据,统一导出为 fig_data.json。
 *
 * ★全部数据来自【真实 SWE-bench Pro 轨迹】(beta-mesoscale2/swebpReal.mjs 同一底座),
 *   与可证伪评估 eval_swebpro_clusters.mjs 用【同一引擎 / 同一真实数据 / 同一臂定义】,不分叉。
 *
 * 真实部分: 每个 instance 的共改文件集合(解析 gold patch)、每文件符号、仓库/路径/测试。
 * 建模部分: 单步 hint 噪声、System2 成功率、干扰步混入(同仓库其它真实 instance 的真实文件)。
 *
 * 输出数据块:
 *   meta           —— 数据来源/可复现参数/选中的 10 个真实实例
 *   armBars        —— 三臂(逐步/簇/always-S2)总 token / 关键漏判 / 过度深思(柱状图)
 *   learningCurve  —— 簇臂关键漏判率随会话批次下降(自校准,折线)
 *   muTrace        —— 影子价 μ 随会话收敛(EMMS 协调变量不动点,折线)
 *   biddingScatter —— 簇臂每步 (robBid, ecoAsk) 散点 + 是否点燃(EMMS 竞价裁决可视化)
 *   m1m2           —— 簇 vs 逐步 的 M1(少漏判)/M2(不多烧)配对检验(跨 seed,新图)
 *   noiseSweep     —— M1 关键漏判改善随 hint 噪声变化(可证伪鲁棒性,新图)
 *
 * 跑: node gen_fig_data.mjs   →   写 fig_data.json
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRIT_TH, S2_SUCCESS, CHEAP_TOK, DEEP_TOK,
  mulberry32, loadInstances, buildSession,
  armStep, armCluster, armAlwaysS2, pairedT, mean, std,
} from "../swebpReal.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SEL_PATH = path.join(__dir, "..", "selected10.json");

// ── 可复现参数(与 eval 默认一致) ──
const SEEDS = 24;          // 跨 seed 做配对检验(M1/M2)
const SESSIONS = 60;       // 每 seed 的多子目标会话数
const NOISE = 0.3;         // 主图所用 hint 噪声
const TRACE_SESSIONS = 120; // 单条代表性 seed 用于 μ/竞价/学习曲线的会话数(更平滑)

(async () => {
  const byRepo = await loadInstances();
  const repos = Object.entries(byRepo).filter(([, v]) => v.length >= 5).sort((a, b) => b[1].length - a[1].length);
  const repoNames = repos.map(([r, v]) => `${r.split("/").pop()}(${v.length})`);

  // ── 选中的 10 个真实实例(供 meta 展示真实来源) ──
  let selected = [];
  if (existsSync(SEL_PATH)) {
    try {
      const ids = JSON.parse(readFileSync(SEL_PATH, "utf8"));
      const flat = Object.values(byRepo).flat();
      for (const id of ids) {
        const inst = flat.find((x) => x.instance === id);
        if (inst) selected.push({ instance: id, repo: inst.repo, nfiles: inst.files.length, ftp: inst.failToPass.length });
      }
    } catch {}
  }

  // ════════════════════════════════════════════════════════════════
  // (1) 跨 seed 汇总 → 三臂柱状图 + M1/M2 配对检验
  // ════════════════════════════════════════════════════════════════
  const rowsStep = { miss: [], s2: [], tok: [], over: [], prFail: [] };
  const rowsCl = { miss: [], s2: [], tok: [], over: [], prFail: [] };
  const rowsS2 = { miss: [], s2: [], tok: [], over: [], prFail: [] };
  let totPr = 0;
  for (let s = 0; s < SEEDS; s++) {
    const rng = mulberry32(7919 + s * 31);
    const [, pool] = repos[Math.floor(rng() * repos.length)];
    const sessions = [];
    for (let i = 0; i < SESSIONS; i++) sessions.push(buildSession(pool, rng, NOISE));
    const aS = armStep(sessions), aC = armCluster(sessions), a2 = armAlwaysS2(sessions);
    totPr = aS.prTotal;
    for (const [rows, a] of [[rowsStep, aS], [rowsCl, aC], [rowsS2, a2]]) {
      rows.miss.push(a.miss); rows.s2.push(a.s2); rows.tok.push(a.tok); rows.over.push(a.over); rows.prFail.push(a.prFail);
    }
  }
  const m1 = pairedT(rowsCl.miss, rowsStep.miss);     // 簇 - 逐步 (负=簇漏判更少)
  const m2 = pairedT(rowsCl.s2, rowsStep.s2);
  const m2tok = pairedT(rowsCl.tok, rowsStep.tok);

  const armBars = [
    { name: "always-S2", tok: mean(rowsS2.tok), miss: mean(rowsS2.miss), overdeep: mean(rowsS2.over), s2: mean(rowsS2.s2), prFail: mean(rowsS2.prFail) },
    { name: "step", tok: mean(rowsStep.tok), miss: mean(rowsStep.miss), overdeep: mean(rowsStep.over), s2: mean(rowsStep.s2), prFail: mean(rowsStep.prFail) },
    { name: "cluster", tok: mean(rowsCl.tok), miss: mean(rowsCl.miss), overdeep: mean(rowsCl.over), s2: mean(rowsCl.s2), prFail: mean(rowsCl.prFail) },
  ];

  // ════════════════════════════════════════════════════════════════
  // (2) 单条代表性 seed,trace=true → μ 轨迹 / 竞价散点 / 学习曲线
  //     选样本最多的仓库,会话数加大求平滑。
  // ════════════════════════════════════════════════════════════════
  const traceRng = mulberry32(20260607);
  const [, bigPool] = repos[0]; // 样本最多的仓库
  const traceSessions = [];
  for (let i = 0; i < TRACE_SESSIONS; i++) traceSessions.push(buildSession(bigPool, traceRng, NOISE));
  const traced = armCluster(traceSessions, { trace: true });

  // μ 轨迹: 每会话末的 μ
  const muTrace = traced.muTrace.map((mu, i) => ({ session: i + 1, mu }));

  // 竞价散点: 抽样(避免 JSON 过大),保留点燃/未点燃比例
  const allScatter = traced.scatter;
  const SCATTER_CAP = 600;
  let scatter = allScatter;
  if (allScatter.length > SCATTER_CAP) {
    const stride = allScatter.length / SCATTER_CAP;
    scatter = [];
    for (let i = 0; i < allScatter.length; i += stride) scatter.push(allScatter[Math.floor(i)]);
  }

  // 学习曲线: 每 BATCH 会话聚合关键漏判率(漏判步 / 总步)
  const BATCH = 12;
  const learningCurve = [];
  for (let b = 0; b * BATCH < traced.perSessionMiss.length; b++) {
    const seg = traced.perSessionMiss.slice(b * BATCH, b * BATCH + BATCH);
    const miss = seg.reduce((a, c) => a + c.miss, 0);
    const steps = seg.reduce((a, c) => a + c.steps, 0);
    learningCurve.push({ batch: b + 1, sessionRange: `${b * BATCH + 1}-${b * BATCH + seg.length}`, missRate: +(miss / Math.max(1, steps)).toFixed(4) });
  }

  // ════════════════════════════════════════════════════════════════
  // (3) 噪声扫描 → M1 改善随 hint 噪声变化(鲁棒性/可证伪)
  // ════════════════════════════════════════════════════════════════
  const noiseLevels = [0.1, 0.2, 0.3, 0.42, 0.5];
  const noiseSweep = [];
  for (const nz of noiseLevels) {
    const cMiss = [], sMiss = [], cS2 = [], sS2 = [];
    for (let s = 0; s < SEEDS; s++) {
      const rng = mulberry32(13331 + s * 17);
      const [, pool] = repos[Math.floor(rng() * repos.length)];
      const sessions = [];
      for (let i = 0; i < SESSIONS; i++) sessions.push(buildSession(pool, rng, nz));
      const aS = armStep(sessions), aC = armCluster(sessions);
      cMiss.push(aC.miss); sMiss.push(aS.miss); cS2.push(aC.s2); sS2.push(aS.s2);
    }
    const t1 = pairedT(cMiss, sMiss);
    const baseS2 = mean(sS2), clS2 = mean(cS2);
    noiseSweep.push({
      noise: nz,
      missDelta: t1.mean, p: t1.p, winRate: t1.winRate,
      s2Ratio: +((clS2 / baseS2 - 1) * 100).toFixed(1), // 簇 S2 比逐步多百分之几
      M1pass: t1.mean < 0 && t1.p < 0.05,
      M2pass: clS2 <= baseS2 * 1.10,
    });
  }

  // ── 装配 ──
  const out = {
    meta: {
      title: "Meso-scale auto-cluster scheduler on real SWE-bench Pro trajectories",
      dataSource: "SWE-bench Pro (sweap_eval_full_v2.jsonl)",
      provenance: {
        real: "co-changed files & symbols parsed from gold patches; repo/path/tests are real",
        modeled: "per-step hint noise, System2 success rate, distractor steps (real files from other same-repo instances)",
      },
      seeds: SEEDS, sessionsPerSeed: SESSIONS, noise: NOISE, traceSessions: TRACE_SESSIONS,
      costModel: { cheapTok: CHEAP_TOK, deepTok: DEEP_TOK, critTh: CRIT_TH, s2Success: S2_SUCCESS },
      reposAvailable: repoNames,
      selected10: selected,
      generated: new Date().toISOString(),
    },
    armBars,
    m1m2: {
      subtasksPerSeed: totPr,
      M1: { name: "critical-subtask miss (cluster - step)", mean: m1.mean, t: m1.t, p: m1.p, winRate: m1.winRate, pass: m1.mean < 0 && m1.p < 0.05 },
      M2: { name: "System2 calls (cluster - step)", mean: m2.mean, t: m2.t, p: m2.p, tokenDelta: m2tok.mean,
        baseS2: mean(rowsStep.s2), clusterS2: mean(rowsCl.s2), budgetSlack: 0.10,
        pass: mean(rowsCl.s2) <= mean(rowsStep.s2) * 1.10 },
      stepMiss: { mean: mean(rowsStep.miss), std: +std(rowsStep.miss).toFixed(2) },
      clusterMiss: { mean: mean(rowsCl.miss), std: +std(rowsCl.miss).toFixed(2) },
    },
    learningCurve,
    muTrace,
    biddingScatter: scatter,
    noiseSweep,
  };

  const outPath = path.join(__dir, "fig_data.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log("wrote", outPath);
  console.log(`数据来源: 真实 SWE-bench Pro, 可用仓库 ${repos.length} 个`);
  console.log(`选中真实实例: ${selected.length} 个`);
  console.log("armBars (跨 " + SEEDS + " seed 均值):");
  for (const a of armBars) console.log(`  ${a.name.padEnd(12)} tok=${String(a.tok).padStart(8)} miss=${String(a.miss).padStart(7)} overdeep=${String(a.overdeep).padStart(7)} S2=${String(a.s2).padStart(8)}`);
  console.log(`M1 关键漏判差=${m1.mean} p=${m1.p} ${out.m1m2.M1.pass ? "✅" : "❌"}  |  M2 S2差=${m2.mean} (${out.m1m2.M2.pass ? "✅" : "❌"})`);
  console.log(`μ 轨迹点=${muTrace.length}  竞价散点=${scatter.length}/${allScatter.length}  学习曲线批次=${learningCurve.length}  噪声扫描点=${noiseSweep.length}`);
})();
