/**
 * swebpReal.mjs —— 真实 SWE-bench Pro 轨迹的【唯一】共享评估底座。
 *
 * eval_swebpro_clusters.mjs(可证伪 M1/M2 判定)与 figures/gen_fig_data.mjs(出版配图)
 * 都从这里取数据/臂逻辑,保证两处【同一引擎、同一真实数据、同一臂定义】,不发生分叉。
 *
 * 诚实边界(与 eval 头部一致):
 *   真实: 每个 instance 的共改文件集合(解析 gold patch)、每文件符号、仓库/路径/测试。
 *   建模: 单步 hint 噪声、System2 成功率、干扰步混入(用同仓库其它真实 instance 的真实文件)。
 *   簇边界【不喂】,两臂都看不到 pr 标签;簇臂只能靠真实文件/符号重叠在线发现。
 */
import { SelfModelAgent } from "./selfModel.mjs";
import { ClusterIndex } from "./clusterIndex.mjs";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA = path.join(__dir, "data", "sweap_eval_full_v2.jsonl");

// ── 共享常量(代价/阈值/成功率) ──
export const CRIT_TH = 0.6;        // 真关键度阈值
export const S2_SUCCESS = 0.9;     // System2 把关键步做对的概率(建模假设)
export const CHEAP_TOK = 1, DEEP_TOK = 8;  // 估算: System1≈1, System2(best-of-N)≈8 单位 token

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// ── 解析 gold patch 的真实共改文件(排除测试文件) ──
export function parsePatchedFiles(patch) {
  const files = [];
  for (const m of patch.matchAll(/diff --git a\/(\S+) b\/\S+/g)) {
    const f = m[1];
    if (/(^|\/)(test|tests|spec|__tests__)(\/|$)|_test\.|\.test\.|\.spec\./i.test(f)) continue;
    files.push(f);
  }
  return [...new Set(files)];
}

// ── 解析每个文件触碰的真实符号(语言无关近似) ──
const SYMBOL_RE = /\b(?:function|def|class|func|fn|method|const|let|var|public|private|static)\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*(?=\()/g;
export function parseSymbolsByFile(patch) {
  const byFile = {};
  let cur = null;
  for (const line of patch.split("\n")) {
    const dm = line.match(/^diff --git a\/(\S+) b\//);
    if (dm) { cur = dm[1]; byFile[cur] = byFile[cur] || new Set(); continue; }
    if (!cur) continue;
    if (line[0] !== "+" && line[0] !== " ") continue;
    const body = line.slice(1);
    for (const m of body.matchAll(SYMBOL_RE)) {
      const sym = m[1] || m[2];
      if (sym && sym.length >= 3 && !/^(the|and|for|return|if|else|this|self|true|false|null|void|int|str)$/.test(sym)) {
        byFile[cur].add(sym);
      }
    }
  }
  const out = {};
  for (const f of Object.keys(byFile)) out[f] = [...byFile[f]].slice(0, 24);
  return out;
}

// ── 载入真实 instances → 每个 = 一个 PR 子目标(多文件) ──
export async function loadInstances(file = DEFAULT_DATA, limit = 4000) {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到数据文件: ${file}\n  请确认 SWE-bench Pro 的 sweap_eval_full_v2.jsonl 在该路径。`);
  }
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  const byRepo = {};
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o.patch) continue;
    const files = parsePatchedFiles(o.patch);
    if (files.length < 2) continue;
    const symbolsByFile = parseSymbolsByFile(o.patch);
    let ftp = o.FAIL_TO_PASS;
    if (typeof ftp === "string") { try { ftp = JSON.parse(ftp); } catch { ftp = []; } }
    byRepo[o.repo] = byRepo[o.repo] || [];
    byRepo[o.repo].push({ instance: o.instance_id, repo: o.repo, files, symbolsByFile,
      failToPass: Array.isArray(ftp) ? ftp : [] });
    if (++n >= limit) break;
  }
  return byRepo;
}

// ── PR 子目标 → 步序列(每个被改文件=一步,真关键) ──
export function prToSteps(pr, rng, noise) {
  const clCrit = 0.7 + rng() * 0.25;
  return pr.files.map((f) => {
    const trueCrit = clamp01(clCrit + (rng() - 0.5) * 0.12);
    const cHint = clamp01(trueCrit + (rng() - 0.5) * 2 * noise);
    const dHint = clamp01(0.4 + 0.4 * rng());
    return {
      pr: pr.instance, repo: pr.repo, file: f,
      files: [f], symbols: pr.symbolsByFile[f] || [],
      critHint: +cHint.toFixed(3), dHint: +dHint.toFixed(3), trueCrit: +trueCrit.toFixed(3),
      actionType: "edit_file", rndS2: rng(),
    };
  });
}

// ── 干扰步: 同仓库其它真实 instance 的真实文件,低关键 ──
export function distractorStep(pool, rng, noise) {
  const pr = pool[Math.floor(rng() * pool.length)];
  const f = pr.files[Math.floor(rng() * pr.files.length)];
  const trueCrit = 0.15 + rng() * 0.25;
  const cHint = clamp01(trueCrit + (rng() - 0.5) * 2 * noise);
  return {
    pr: "distractor:" + pr.instance, repo: pr.repo, file: f,
    files: [f], symbols: (pr.symbolsByFile[f] || []),
    critHint: +cHint.toFixed(3), dHint: +(0.3 + 0.3 * rng()).toFixed(3), trueCrit: +trueCrit.toFixed(3),
    actionType: "edit_file", rndS2: rng(), isDistractor: true,
  };
}

// ── 多子目标会话: 2~3 个真实 PR + 干扰步,交错打乱 ──
export function buildSession(pool, rng, noise) {
  const k = 2 + Math.floor(rng() * 2);
  const prs = [];
  const used = new Set();
  for (let i = 0; i < k && prs.length < k; i++) {
    const idx = Math.floor(rng() * pool.length);
    if (used.has(idx)) continue; used.add(idx);
    prs.push(pool[idx]);
  }
  let steps = [];
  for (const pr of prs) steps = steps.concat(prToSteps(pr, rng, noise));
  const nDist = Math.floor(steps.length * 0.5);
  for (let i = 0; i < nDist; i++) steps.push(distractorStep(pool, rng, noise));
  for (let i = steps.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [steps[i], steps[j]] = [steps[j], steps[i]]; }
  const total = steps.length;
  steps.forEach((s, i) => { s.progress = +(i / total).toFixed(3); });
  return steps;
}

// ── 执行一步 ──
export function execStep(st, goDeep) {
  const reallyCritical = st.trueCrit > CRIT_TH;
  if (goDeep) {
    if (reallyCritical) return { tok: DEEP_TOK, criticalMiss: st.rndS2 < S2_SUCCESS ? 0 : 1, overdeep: 0, usedS2: true };
    return { tok: DEEP_TOK, criticalMiss: 0, overdeep: 1, usedS2: true };
  }
  if (reallyCritical) return { tok: CHEAP_TOK, criticalMiss: 1, overdeep: 0, usedS2: false };
  return { tok: CHEAP_TOK, criticalMiss: 0, overdeep: 0, usedS2: false };
}

export function newAcc() { return { tok: 0, miss: 0, over: 0, s2: 0, steps: 0, prFail: 0, prTotal: 0 }; }

// ── 臂: 逐步路由。trace=true 时额外采集 μ/竞价散点/批次误判(供配图) ──
export function armStep(sessions, { trace = false } = {}) {
  const agent = new SelfModelAgent({ mu0: 1.0 });
  const acc = newAcc();
  const muTrace = [], scatter = [], perSessionMiss = [];
  for (let si = 0; si < sessions.length; si++) {
    const steps = sessions[si];
    agent.newTask();
    const prMiss = {}; let sessMiss = 0;
    for (const st of steps) {
      const x = [st.critHint, st.dHint, st.progress];
      const d = agent.decideAbstract(x, agent.z.pollution, { actionType: st.actionType });
      const r = execStep(st, d.ignite);
      acc.tok += r.tok; acc.miss += r.criticalMiss; acc.over += r.overdeep; if (r.usedS2) acc.s2++; acc.steps++;
      sessMiss += r.criticalMiss;
      if (trace) scatter.push({ robGain: +d.robBid.toFixed(4), ecoCost: +d.ecoAsk.toFixed(4), ignite: d.ignite ? 1 : 0, trueCritical: st.trueCrit > CRIT_TH ? 1 : 0 });
      agent.learnAbstract(x, st.trueCrit, r.usedS2, { missHappened: !!r.criticalMiss }, { actionType: st.actionType });
      agent.addPollution(r.usedS2, r.usedS2);
      if (!st.isDistractor) prMiss[st.pr] = (prMiss[st.pr] || 0) + r.criticalMiss;
    }
    for (const pr of Object.keys(prMiss)) { acc.prTotal++; if (prMiss[pr] > 0) acc.prFail++; }
    agent.feedback(Object.values(prMiss).every((m) => m === 0));
    if (trace) { muTrace.push(+agent.mu.toFixed(4)); perSessionMiss.push({ miss: sessMiss, steps: steps.length }); }
  }
  return trace ? { acc, muTrace, scatter, perSessionMiss } : acc;
}

// ── 臂: 自动簇发现 + 簇溢价进同一条竞价 ──
export function armCluster(sessions, { trace = false } = {}) {
  const agent = new SelfModelAgent({ mu0: 1.0 });
  const acc = newAcc();
  const muTrace = [], scatter = [], perSessionMiss = [];
  for (let si = 0; si < sessions.length; si++) {
    const steps = sessions[si];
    agent.newTask();
    const idx = new ClusterIndex();
    const prMiss = {}; let sid = 0; let sessMiss = 0;
    for (const st of steps) {
      const stepId = "s" + (sid++);
      const actionPrior = agent.actionPriors[st.actionType] ?? 0.7;
      const cl = idx.addStep(stepId, { files: st.files, symbols: st.symbols, critHint: st.critHint, critEst: st.critHint, actionPrior });
      const x = [st.critHint, st.dHint, st.progress];
      const d = agent.decideAbstract(x, agent.z.pollution, { actionType: st.actionType, cluster: cl });
      const r = execStep(st, d.ignite);
      idx.updateNode(stepId, { critEst: d.critEst, actionPrior, ignited: d.ignite });
      acc.tok += r.tok; acc.miss += r.criticalMiss; acc.over += r.overdeep; if (r.usedS2) acc.s2++; acc.steps++;
      sessMiss += r.criticalMiss;
      if (trace) scatter.push({ robGain: +d.robBid.toFixed(4), ecoCost: +d.ecoAsk.toFixed(4), ignite: d.ignite ? 1 : 0, trueCritical: st.trueCrit > CRIT_TH ? 1 : 0, clusterPremium: +(d.clusterPremium ?? 0).toFixed(4) });
      agent.learnAbstract(x, st.trueCrit, r.usedS2, { missHappened: !!r.criticalMiss }, { actionType: st.actionType });
      agent.addPollution(r.usedS2, r.usedS2);
      idx.observe(stepId, !!r.criticalMiss || st.trueCrit >= CRIT_TH);
      if (!st.isDistractor) prMiss[st.pr] = (prMiss[st.pr] || 0) + r.criticalMiss;
    }
    for (const pr of Object.keys(prMiss)) { acc.prTotal++; if (prMiss[pr] > 0) acc.prFail++; }
    agent.feedback(Object.values(prMiss).every((m) => m === 0));
    if (trace) { muTrace.push(+agent.mu.toFixed(4)); perSessionMiss.push({ miss: sessMiss, steps: steps.length }); }
  }
  return trace ? { acc, muTrace, scatter, perSessionMiss } : acc;
}

// ── 臂: always-System2(M2 上界) ──
export function armAlwaysS2(sessions) {
  const acc = newAcc();
  for (const steps of sessions) {
    const prMiss = {};
    for (const st of steps) {
      const r = execStep(st, true);
      acc.tok += r.tok; acc.miss += r.criticalMiss; acc.over += r.overdeep; acc.s2++; acc.steps++;
      if (!st.isDistractor) prMiss[st.pr] = (prMiss[st.pr] || 0) + r.criticalMiss;
    }
    for (const pr of Object.keys(prMiss)) { acc.prTotal++; if (prMiss[pr] > 0) acc.prFail++; }
  }
  return acc;
}

// ── 统计工具 ──
export function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export function pairedT(a, b) {
  const n = a.length, diff = a.map((v, i) => v - b[i]);
  const md = diff.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(diff.reduce((s, x) => s + (x - md) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n), t = se > 0 ? md / se : 0;
  const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  const p = 2 * (1 - Phi(Math.abs(t)));
  return { mean: +md.toFixed(2), t: +t.toFixed(2), p: +p.toFixed(4), winRate: +(diff.filter((x) => x < 0).length / n * 100).toFixed(0) };
}
export function mean(a) { return +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2); }
export function std(a) { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); }
