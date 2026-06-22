/**
 * consciousCore.mjs —— 意识核的「会话管理 + 持久化」封装，供 MCP 服务调用。
 *
 * 设计目标：让【任何智能体】都能把"这一步该用多大算力 / 要不要停下重想"这个元认知决策，
 * 外包给这个核——而调用方完全不需要懂原型库、竞争-协调、μ 等内部机制。
 *
 * 调用方只提供【通用可观测量】（每个 agent loop 都能算出来的东西）：
 *   - criticality_hint ∈[0,1]：这步表面上看有多关键（错了会不会毁全局）
 *   - difficulty_hint  ∈[0,1]：这步表面上看有多难
 *   - progress         ∈[0,1]：在整个任务里的进度位置
 *   - context_pollution∈[0,1]：当前上下文窗口有多满/多脏（= 已用 token / 窗口；这是真实量）
 *
 * 核返回【决策】：
 *   - mode: "system1"(直觉/便宜) | "system2"(点燃/深思)，由【成本敏感期望代价】 e_cost_s1 > e_cost_s2 直接决定
 *   - criticality_estimate：核估计的真关键度
 *   - p_crit / e_cost_s1 / e_cost_s2：真实决策依据(外部审计据此理解 mode 为何如此)
 *   - rob_gain / eco_cost：等价竞价量(非判据,仅兼容旧可视化)
 *
 * 事后调用方回报【真实结果】(report_outcome / task_feedback) → 核自学，更新原型库与 μ。
 *
 * 多会话：用 sessionId 隔离不同 agent / 不同任务的 loop 级自我状态；
 * 原型库（= 自己长出的 skill）可按 "namespace" 持久化到磁盘，跨进程/跨会话复用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SelfModelAgent } from "./selfModel.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dir, "store"); // 原型库持久化目录（每个 namespace 一个 json）

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }

/**
 * 一个会话 = 一个 SelfModelAgent 实例 + 它绑定的 namespace（决定原型库存哪）。
 * loop 级自我状态（污染/活跃原型）随会话；原型库与 μ 随 namespace 持久化。
 */
export class ConsciousCore {
  constructor() {
    /** @type {Map<string,{agent:SelfModelAgent, namespace:string}>} */
    this.sessions = new Map();
    fs.mkdirSync(STORE, { recursive: true });
  }

  _storePath(ns) {
    const safe = String(ns).replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(STORE, `${safe}.json`);
  }

  /** 把磁盘上的原型库灌回一个新 agent（namespace 复用既有"技能"）。 */
  _hydrate(agent, ns) {
    const p = this._storePath(ns);
    if (!fs.existsSync(p)) return 0;
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      if (typeof data.mu === "number") agent.mu = data.mu;
      agent.protos = (data.protos || []).map((s) => ({
        protoFeat: s.protoFeat.slice(),
        policy: { theta: s.theta ?? 0.6, muBias: s.muBias ?? 0 },
        w: s.w.slice(), n: s.n ?? 1, conf: s.conf ?? 0.3, predErr: s.predErr ?? 0.5,
        critEst(rf) { let v = 0; for (let i = 0; i < this.w.length; i++) v += this.w[i] * rf[i]; return clamp01(v); },
      }));
      return agent.protos.length;
    } catch { return 0; }
  }

  /** 把会话的原型库写回磁盘（= 它积累的"技能"持久化，跨进程可复用）。 */
  persist(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return 0;
    const protos = s.agent.protos.map((p) => ({
      protoFeat: p.protoFeat, w: p.w, n: p.n, conf: p.conf, predErr: p.predErr,
      theta: p.policy.theta, muBias: p.policy.muBias,
    }));
    fs.writeFileSync(this._storePath(s.namespace), JSON.stringify({ mu: s.agent.mu, protos }, null, 2), "utf8");
    return protos.length;
  }

  /**
   * 开一个会话。namespace 决定复用哪套原型库（同 namespace = 共享/累积技能）。
   * opts 可覆盖核的超参（missPenalty/overThinkCost/polluteWeight/...），不传用经过实验标定的默认值。
   */
  openSession(sessionId, namespace = "default", opts = {}) {
    const agent = new SelfModelAgent(opts);
    const n = this._hydrate(agent, namespace);
    agent.newTask();
    // calib = 滚动校准窗口（量化"越学越聪明"）：每次 decide 记一条 pending，reportOutcome 评分。
    //   absErr  = |预测关键度 − 观测关键度|（越小=情形读得越准）
    //   correct = 决策是否"对"（深思命中真关键步 / 便宜命中非关键步）
    const calib = { window: opts.calibWindow ?? 50, log: [], pending: null, nScored: 0 };
    this.sessions.set(sessionId, { agent, namespace, calib, lastDecide: null });
    return { sessionId, namespace, loadedPrototypes: n, mu: agent.mu };
  }

  _get(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown sessionId "${sessionId}" — call open_session first`);
    return s;
  }

  /** 新任务：重置 loop 级自我状态（上下文清空），原型库与 μ 保留（跨任务记忆）。 */
  newTask(sessionId) {
    const { agent } = this._get(sessionId);
    agent.newTask();
    return { ok: true, mu: agent.mu, nPrototypes: agent.protos.length };
  }

  /**
   * 核心决策:这一步走 System1(直觉/便宜) 还是 System2(点燃/深思)。
   * mode 由【成本敏感期望代价】直接驱动:eCostS1 > eCostS2(或库空/变性)即点燃 System2。
   *   eCostS1 = μ·pCrit·missPenalty  (便宜处理的漏判期望代价)
   *   eCostS2 = consultCost·overThinkCost + (1−pCrit)·overThinkCost + 污染惩罚 (深思的期望代价)
   * @param obs {criticality_hint, difficulty_hint, progress, context_pollution}
   */
  decide(sessionId, obs = {}) {
    const s = this._get(sessionId);
    const { agent } = s;
    const x = [clamp01(obs.criticality_hint), clamp01(obs.difficulty_hint), clamp01(obs.progress)];
    const pollution = obs.context_pollution != null ? clamp01(obs.context_pollution) : agent.z.pollution;
    // 外部可声明本步的风险类别(normal/critical/irreversible)。irreversible(数据库迁移/部署/
    // 删除/密钥/回滚等不可逆步) 走硬约束强制 System2+验证,不再被成本函数折中掉。
    const riskClass = obs.irreversible ? "irreversible" : (obs.risk_class || "normal");
    const plan = agent.decideAbstract(x, pollution, { riskClass });

    // mode 由分层调度决定(硬约束→风险预算→安全窗口→成本敏感),不再是单一成本比较。
    const mode = plan.mode;

    // 要深思但上下文已脏 → 建议先整理上下文再深思。阈值随 mu 调(越谨慎越早建议整理)。
    const compactTh = clamp01(0.6 - 0.1 * (agent.mu - 1));
    const suggestCompact = mode === "system2" && pollution > compactTh;

    s.calib.pending = { x, critEst: plan.critEst, mode, theta: plan.theta };
    s.lastDecide = { x, mode };

    return {
      mode,
      ignite: mode === "system2",
      // ★分层安全调度的核心输出(外部据此知道这步走 S1/S2 还要不要验证):
      risk_class: plan.riskClass,                 // normal | critical | irreversible
      verify: plan.verify,                        // none | lint | test | dry_run | policy_check
      remaining_risk_budget: +plan.remainingRiskBudget.toFixed(4),
      decision_reason: plan.decisionReason,       // 触发本次裁决的那一层
      criticality_estimate: +plan.critEst.toFixed(4),
      threshold: +plan.theta.toFixed(4),
      familiarity: +plan.sim.toFixed(4),
      surprise: +plan.surprise.toFixed(4),
      confidence: +(1 - plan.predErr).toFixed(4),
      mu: +plan.mu.toFixed(4),
      suggest_compact: suggestCompact,
      // ★决策依据(外部审计据此理解 mode 为何如此):分层裁决,成本敏感只是最后一层。
      decision_rule: "layered: irreversible/critical hard-gate → risk-budget → safe-window → cost-sensitive",
      p_crit: plan.pCrit != null ? +plan.pCrit.toFixed(4) : null,
      p_mean: plan.pMean != null ? +plan.pMean.toFixed(4) : null,
      p_upper: plan.pUpper != null ? +plan.pUpper.toFixed(4) : null,  // 保守风险上界(裁决用它,非点估计)
      n_effective: plan.nEff,
      shift_score: plan.shiftScore != null ? +plan.shiftScore.toFixed(4) : null,
      safe_window: plan.safeWindow,
      e_cost_s1: plan.eCostS1 != null ? +plan.eCostS1.toFixed(4) : null,
      e_cost_s2: plan.eCostS2 != null ? +plan.eCostS2.toFixed(4) : null,
      regime_shift: !!plan.regimeShift,
      // 兼容旧图的等价竞价量(非 mode 判据,仅供可视化):rob_gain/eco_cost 与期望代价同向。
      rob_gain: plan.robGain != null ? +plan.robGain.toFixed(4) : null,
      eco_cost: plan.ecoCost != null ? +plan.ecoCost.toFixed(4) : null,
      _x: x, _pollution: pollution,
    };
  }

  /** 滚动校准指标（量化"越学越聪明"）：把窗口分成前/后两半比，看是否在变好。 */
  calibration(sessionId) {
    const { calib } = this._get(sessionId);
    const log = calib.log;
    const agg = (arr) => {
      if (!arr.length) return { n: 0, mae: null, accuracy: null };
      let se = 0, ok = 0;
      for (const e of arr) { se += e.absErr; ok += e.correct ? 1 : 0; }
      return { n: arr.length, mae: +(se / arr.length).toFixed(4), accuracy: +(ok / arr.length).toFixed(4) };
    };
    const mid = Math.floor(log.length / 2);
    const first = agg(log.slice(0, mid)), recent = agg(log.slice(mid));
    const overall = agg(log);
    // 是否在进步：近半 MAE 更低 且 准确率不降 = 越学越准。
    const improving = first.mae != null && recent.mae != null &&
      recent.mae <= first.mae && recent.accuracy >= first.accuracy - 0.02;
    return { scored: calib.nScored, overall, firstHalf: first, recentHalf: recent, improving };
  }

  /**
   * 事后回报：观测到的真关键度 + 该步是否走了 System2 + (可选)验证器结果。核据此自学。
   * @param outcome {criticality_hint,difficulty_hint,progress, observed_criticality, used_system2, was_deep,
   *                 verifier_passed, miss_happened}
   */
  reportOutcome(sessionId, outcome = {}) {
    const s = this._get(sessionId);
    const { agent, calib } = s;
    const x = [clamp01(outcome.criticality_hint), clamp01(outcome.difficulty_hint), clamp01(outcome.progress)];
    const observedCrit = clamp01(outcome.observed_criticality);
    const usedS2 = !!outcome.used_system2;

    // ── 校准评分（在学习之前评，反映"决策当下"的水平）──
    if (calib.pending) {
      const p = calib.pending;
      const absErr = Math.abs(p.critEst - observedCrit);
      const reallyCritical = observedCrit > p.theta;        // 以该步阈值判定真关键
      const correct = (p.mode === "system2") === reallyCritical; // 深思↔真关键 对齐则正确
      calib.log.push({ absErr, correct });
      if (calib.log.length > calib.window) calib.log.shift();
      calib.nScored++;
      calib.pending = null;
    }

    // verifier_passed: 该步若挂了便宜验证器,验证是否通过(true/false/null=没验)。
    // miss_happened:   外部可直接标注"漏判真发生了"(便宜处理了一个其实关键的步)。
    const fb = {
      verifierPassed: outcome.verifier_passed != null ? !!outcome.verifier_passed : null,
      missHappened: outcome.miss_happened != null ? !!outcome.miss_happened : undefined,
    };
    agent.learnAbstract(x, observedCrit, usedS2, fb);
    agent.addPollution(usedS2, outcome.was_deep != null ? !!outcome.was_deep : usedS2);
    return {
      ok: true, nPrototypes: agent.protos.length, pollution: +agent.z.pollution.toFixed(4),
      remaining_risk_budget: +agent.z.riskBudget.toFixed(4),
      shift_score: +(0.4 * agent.z.recentSurprise + 0.35 * agent.z.verifyFailEwma + 0.25 * Math.min(1, agent.z.residualEwma * 2)).toFixed(4),
    };
  }

  /** 任务级反馈：整任务成/败 → 调协调变量 μ（稳定性条件）。 */
  taskFeedback(sessionId, success) {
    const { agent } = this._get(sessionId);
    agent.feedback(!!success);
    const n = this.persist(sessionId); // 任务结束自动持久化技能
    return { ok: true, mu: +agent.mu.toFixed(4), nPrototypes: n };
  }

  stats(sessionId) {
    const { agent, namespace } = this._get(sessionId);
    const st = agent.stats();
    return {
      namespace, nPrototypes: st.nProto, mu: +st.mu.toFixed(4), ignitions: st.ignitions,
      steps: agent.z.steps, pollution: +agent.z.pollution.toFixed(4),
    };
  }

  /** 导出原型库（= 自己长出的 skill），可读可存档。 */
  dumpPrototypes(sessionId) {
    const { agent, namespace } = this._get(sessionId);
    return {
      namespace, mu: +agent.mu.toFixed(4),
      prototypes: agent.protos.map((p, i) => ({
        id: i, n: p.n, confidence: +p.conf.toFixed(3), predErr: +p.predErr.toFixed(3),
        situationCentroid: p.protoFeat.map((v) => +v.toFixed(3)),
        readoutWeights: p.w.map((v) => +v.toFixed(3)),
      })),
    };
  }

  closeSession(sessionId) {
    const n = this.persist(sessionId);
    this.sessions.delete(sessionId);
    return { ok: true, persistedPrototypes: n };
  }
}
