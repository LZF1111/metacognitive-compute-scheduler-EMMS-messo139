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
import { SkillfulAgent } from "./skillfulAgent.mjs";
import { Attestor, LocalExecutor } from "./attest.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dir, "store"); // 原型库 + 技能库持久化目录（每个 namespace 一个 json）

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }

/**
 * 一个会话 = 一个 SkillfulAgent 实例（元认知层 meta + 技能层 skills）+ 它绑定的 namespace。
 * loop 级自我状态（污染/活跃原型）随会话；元认知原型库 + μ + 技能记忆随 namespace 持久化。
 */
export class ConsciousCore {
  constructor(opts = {}) {
    /** @type {Map<string,{agent:SkillfulAgent, namespace:string}>} */
    this.sessions = new Map();
    fs.mkdirSync(STORE, { recursive: true });
    // ── ★受信任执行器【密码学背书】(P0 attestation) ──
    //   密钥来自 env EMMS_ATTEST_SECRET(生产经 KMS 注入);缺省进程内随机(只对本进程签发的 token 有效)。
    //   MCP 客户端【拿不到】密钥 → 无法伪造 {source:executor,exit_code:0}。详见 attest.mjs。
    //   opts.insecureTrustFallback=true 才允许在【完全没有 attestor】时退回明文 source+exitCode(仅本地实验)。
    const secret = opts.attestSecret ?? process.env.EMMS_ATTEST_SECRET ?? null;
    this.attestor = (opts.attestor instanceof Attestor) ? opts.attestor
      : new Attestor(secret, { trustedSources: opts.trustedSources });
    this.executor = new LocalExecutor(this.attestor); // 进程内引用执行器(对真实退出码签名)
    this.insecureTrustFallback = !!opts.insecureTrustFallback; // 默认 false = 必须验签
  }


  _storePath(ns) {
    const safe = String(ns).replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(STORE, `${safe}.json`);
  }

  /** 把磁盘上的快照（元认知原型库 + μ + 技能记忆）灌回一个 SkillfulAgent（namespace 复用全部经验）。 */
  _hydrate(agent, ns) {
    const p = this._storePath(ns);
    if (!fs.existsSync(p)) return { protos: 0, skills: 0 };
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      // 兼容旧格式（只有 {mu, protos}，无 skills）：restore 会把缺失的 skills 当空库处理。
      agent.restore({ mu: data.mu, protos: data.protos || [], skills: data.skills || [] });
      return { protos: agent.meta.protos.length, skills: agent.skills.size() };
    } catch { return { protos: 0, skills: 0 }; }
  }

  /** 把会话的【元认知原型库 + μ + 技能记忆】整体写回磁盘（跨进程/跨会话真正复用）。 */
  persist(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return 0;
    const snap = s.agent.toJSON(); // {mu, protos, skills}
    fs.writeFileSync(this._storePath(s.namespace), JSON.stringify(snap, null, 2), "utf8");
    return (snap.protos?.length ?? 0);
  }

  /**
   * 开一个会话。namespace 决定复用哪套原型库（同 namespace = 共享/累积技能）。
   * opts 可覆盖核的超参（missPenalty/overThinkCost/polluteWeight/...），不传用经过实验标定的默认值。
   */
  openSession(sessionId, namespace = "default", opts = {}) {
    // ★把服务端 attestor 注入技能层:信任只能来自有效签名(除非显式开 insecureTrustFallback)。
    const skillOpts = {
      ...(opts.skillOpts || {}),
      attestor: this.attestor,
      requireAttestation: !this.insecureTrustFallback,
    };
    const agent = new SkillfulAgent(opts, skillOpts);
    const loaded = this._hydrate(agent, namespace);
    agent.newTask();
    // calib = 滚动校准窗口（量化"越学越聪明"）：每次 decide 记一条 pending，reportOutcome 评分。
    //   absErr  = |预测关键度 − 观测关键度|（越小=情形读得越准）
    //   correct = 决策是否"对"（深思命中真关键步 / 便宜命中非关键步）
    const calib = { window: opts.calibWindow ?? 50, log: [], pending: null, nScored: 0 };
    this.sessions.set(sessionId, { agent, namespace, calib, lastDecide: null });
    return { sessionId, namespace, loadedPrototypes: loaded.protos, loadedSkills: loaded.skills, mu: agent.meta.mu };
  }

  _get(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown sessionId "${sessionId}" — call open_session first`);
    return s;
  }

  /** 新任务：重置 loop 级自我状态（上下文清空），原型库/技能/μ 保留（跨任务记忆）。 */
  newTask(sessionId) {
    const { agent } = this._get(sessionId);
    agent.newTask();
    return { ok: true, mu: agent.meta.mu, nPrototypes: agent.meta.protos.length, nSkills: agent.skills.size() };
  }

  /**
   * 核心决策:这一步走 System1(直觉/便宜) 还是 System2(点燃/深思),并给出验证策略。
   * mode 由【竞争-协调均衡】(EMMS)裁决:稳健出价 robBid vs 经济要价 ecoAsk,由影子价 μ 协调。
   * ★三层全部进入同一条竞价(不是旁路):
   *   元认知层 = robBase + 安全障碍/预算影子价;
   *   动作层   = actionPremium(改动类动作语义溢价) + 按动作类型分派的验证策略;
   *   技能层   = 复用折扣(同仓库+真验证可复用修法→降 robBid) / 新颖溢价 / 跨仓库溢价。
   * @param obs {criticality_hint, difficulty_hint, progress, context_pollution, risk_class, irreversible,
   *             action_type, repo, lang, file_type, error_signature, stack_features}
   */
  decide(sessionId, obs = {}) {
    const s = this._get(sessionId);
    const { agent } = s;
    const critHint = clamp01(obs.criticality_hint);
    const dHint = clamp01(obs.difficulty_hint);
    const progress = clamp01(obs.progress);
    // 上下文污染是真实量(已用 token/窗口);不传则沿用 loop 级累计值。
    if (obs.context_pollution != null) agent.meta.z.pollution = clamp01(obs.context_pollution);
    const pollution = agent.meta.z.pollution;
    const riskClass = obs.irreversible ? "irreversible" : (obs.risk_class || "normal");

    // ★三层决策:技能检索(repo/语言/文件类型/操作类型/错误签名/堆栈)→技能信号→并入 EMMS 竞价。
    //   决策时可见字段(报错先于修复,无泄漏);改动类动作按 actionVerifier 分派验证策略。
    const step = {
      critHint, dHint, progress,
      repo: obs.repo, branch: obs.branch, lang: obs.lang, fileType: obs.file_type,
      actionType: obs.action_type,
      errorSignature: obs.error_signature,
      stackFeatures: obs.stack_features,
      riskClass, irreversible: obs.irreversible,
      // ★介尺度簇层(自动发现)的决策时可见耦合证据:文件/符号重叠 + 失败测试传播 + 计划父节点。
      //   传了任一项即激活簇层;都不传 → 簇项=0(零回归,退化为微观逐步路由)。
      stepId: obs.step_id,
      files: obs.files, symbols: obs.symbols,
      failingTests: obs.failing_tests, coveredFiles: obs.covered_files,
      planNode: obs.plan_node,
    };
    const plan = agent.decideStep(step);
    const mode = plan.mode;

    // 要深思但上下文已脏 → 建议先整理上下文再深思。阈值随 mu 调(越谨慎越早建议整理)。
    const compactTh = clamp01(0.6 - 0.1 * (agent.meta.mu - 1));
    const suggestCompact = mode === "system2" && pollution > compactTh;

    s.calib.pending = { x: [critHint, dHint, progress], critEst: plan.critEst, mode, theta: plan.theta };
    s.lastDecide = { mode, actionType: obs.action_type };

    return {
      mode,
      ignite: mode === "system2",
      // ★安全约束竞价的核心输出(外部据此知道这步走 S1/S2 还要不要验证):
      risk_class: plan.riskClass,                 // normal | critical | irreversible
      verify: plan.verify,                        // none | lint | test | dry_run | review
      remaining_risk_budget: +plan.remainingRiskBudget.toFixed(4),
      decision_reason: plan.decisionReason,       // 竞价里哪一项主导(障碍/预算影子价/动作溢价/技能项/纯成本竞价)
      criticality_estimate: +plan.critEst.toFixed(4),
      threshold: +plan.theta.toFixed(4),
      familiarity: +plan.sim.toFixed(4),
      surprise: +plan.surprise.toFixed(4),
      confidence: +(1 - plan.predErr).toFixed(4),
      mu: +plan.mu.toFixed(4),
      suggest_compact: suggestCompact,
      // ★决策依据(外部审计据此理解 mode 为何如此):一条竞争-协调竞价,安全约束折进稳健出价的障碍/影子价。
      decision_rule: "EMMS bid: ignite ⟺ robBid > ecoAsk (safety/action/skill constraints enter robBid as barrier/shadow-price)",
      p_crit: plan.pCrit != null ? +plan.pCrit.toFixed(4) : null,
      p_mean: plan.pMean != null ? +plan.pMean.toFixed(4) : null,
      p_upper: plan.pUpper != null ? +plan.pUpper.toFixed(4) : null,  // 保守风险上界(裁决用它,非点估计)
      n_effective: plan.nEff,
      shift_score: plan.shiftScore != null ? +plan.shiftScore.toFixed(4) : null,
      safe_window: plan.safeWindow,
      e_cost_s1: plan.eCostS1 != null ? +plan.eCostS1.toFixed(4) : null,
      e_cost_s2: plan.eCostS2 != null ? +plan.eCostS2.toFixed(4) : null,
      regime_shift: !!plan.regimeShift,
      // ★竞价量(均衡的核心,mode 判据就是它俩比较):rob_bid=稳健总出价(含安全障碍/影子价), eco_ask=经济要价。
      rob_bid: plan.robBid != null ? +plan.robBid.toFixed(4) : null,
      eco_ask: plan.ecoAsk != null ? +plan.ecoAsk.toFixed(4) : null,
      rob_base: plan.robBase != null ? +plan.robBase.toFixed(4) : null,    // 稳健基础出价(不含约束,=旧 eCostS1)
      budget_shadow: plan.budgetShadow != null ? +plan.budgetShadow.toFixed(4) : null, // 风险预算影子价
      // ★动作层(改动类动作语义):是否改动类 + 先验关键度 + 动作溢价 + 是否被强制验证。
      is_mutating: !!plan.isMutating,
      action_prior: plan.actionPrior != null ? +plan.actionPrior.toFixed(4) : null,
      action_premium: plan.actionPremium != null ? +plan.actionPremium.toFixed(4) : null,
      forced_verify: !!plan.forcedVerify,
      // ★技能层(领域语义):三个进竞价的技能项 + 可复用修法本体 + 检索信号(novelty/同仓库/已验证支持度)。
      skill_reuse_discount: plan.skillReuseDiscount != null ? +plan.skillReuseDiscount.toFixed(4) : null,
      skill_novelty_premium: plan.skillNoveltyPremium != null ? +plan.skillNoveltyPremium.toFixed(4) : null,
      cross_repo_premium: plan.crossRepoPremium != null ? +plan.crossRepoPremium.toFixed(4) : null,
      // ★仓库边界:reusable_fix 只在【同仓库+受信验证+强相似】时给;跨仓库一律 null。
      reusable_fix: plan.reusableFix ?? null,
      // ★跨仓库只能给【参考案例】(需人工审查,不可直接套用),绝不作为 reusable_fix。
      reference_case: plan.referenceCase ?? null,
      skill_signal: plan.skillSignal ? {
        novelty: +(plan.skillSignal.novelty ?? 0).toFixed(4),
        prior_success: +(plan.skillSignal.priorSuccess ?? 0).toFixed(4),
        repo_match: +(plan.skillSignal.repoMatch ?? 0).toFixed(4),
        verified_support: plan.skillSignal.verifiedSupport ?? 0,
        best_sim: +(plan.skillSignal.bestSim ?? 0).toFixed(4),
      } : null,
      // ★介尺度簇层(自动发现子目标簇 → 同一条竞价里的耦合溢价):
      //   cluster_premium 进了 rob_bid;cluster 是审计证据(簇 id/规模/耦合强度/同簇是否受验证关键)。
      cluster_premium: plan.clusterPremium != null ? +plan.clusterPremium.toFixed(4) : null,
      cluster: plan.clusterEvidence ? {
        cluster_id: plan.clusterEvidence.clusterId,
        size: plan.clusterEvidence.size,
        coupling: plan.clusterEvidence.coupling,
        peer_max_stakes: plan.clusterEvidence.peerMaxStakes,
        peer_ignited: plan.clusterEvidence.peerIgnited,
        peer_verified_critical: plan.clusterEvidence.peerVerifiedCritical,
        edge_reasons: plan.clusterEvidence.edgeReasons,
      } : null,
      // 兼容旧图别名:rob_gain=rob_bid, eco_cost=eco_ask。
      rob_gain: plan.robBid != null ? +plan.robBid.toFixed(4) : null,
      eco_cost: plan.ecoAsk != null ? +plan.ecoAsk.toFixed(4) : null,
      _step: step, _pollution: pollution,
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
   * 事后回报：观测到的真关键度 + 该步是否走了 System2 + (可选)验证器结果 + (可选)真实修法内容。
   * ★三层学习:元认知层用 verifier_passed/miss 更新原型/残差/预算;技能层在【改动类动作且有真实结果】时
   *   把 {真实错误→真实修法→真实验证结果} 存成可复用记录(这才是\"学到领域经验\",非数值原型)。
   * @param outcome {criticality_hint,difficulty_hint,progress, observed_criticality, used_system2, was_deep,
   *                 verifier_passed, miss_happened,
   *                 action_type, repo, lang, file_type, error_signature, stack_features,  // 技能记录键(同 decide)
   *                 patch_summary, change_footprint, verifier_result, outcome}            // 技能记录值(事后真实内容)
   */
  reportOutcome(sessionId, outcome = {}) {
    const s = this._get(sessionId);
    const { agent, calib } = s;
    const critHint = clamp01(outcome.criticality_hint);
    const dHint = clamp01(outcome.difficulty_hint);
    const progress = clamp01(outcome.progress);
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

    // step = 与 decide 同一情形/语义键。★调用方可只传【变化量】(结果/验证),语义键由
    //   agent.learnStep 用上一步 decide 记住的 lastStep 自动对齐(防遗漏 action_type 等导致悄悄退化)。
    //   仅当调用方显式传了某语义字段时才覆盖(用 undefined 表示\"不覆盖,沿用上一步\")。
    const step = {
      critHint, dHint, progress,
      repo: outcome.repo, branch: outcome.branch, lang: outcome.lang, fileType: outcome.file_type,
      actionType: outcome.action_type,
      errorSignature: outcome.error_signature, stackFeatures: outcome.stack_features,
      stepId: outcome.step_id,   // ★介尺度:回灌真关键标定到对应子目标簇(与 decide_step 同 step_id)
    };
    // result = 真实事后结果。★技能可信度来自【受信任执行器密码学背书】的 verification
    //   {source,exit_code,test_cmd,commit_hash,patch_hash, nonce, ts, attestation:{sig}}。
    //   ★安全(P0/attestation):【绝不】透传客户端自带的 trusted——信任只由 attestor 验签(skillMemory 内)派生。
    //   nonce/ts/attestation 必须原样透传给 skillMemory,否则无法验签 → trusted=false。
    const v = outcome.verification;
    const verification = v ? {
      source: v.source, exitCode: (typeof v.exit_code === "number" ? v.exit_code : v.exitCode),
      testCmd: v.test_cmd ?? v.testCmd, commitHash: v.commit_hash ?? v.commitHash, patchHash: v.patch_hash ?? v.patchHash,
      nonce: v.nonce, ts: v.ts, attestation: v.attestation,
    } : undefined;
    const result = {
      observedCrit, ignited: usedS2,
      wasDeep: outcome.was_deep != null ? !!outcome.was_deep : usedS2,
      verifierPassed: outcome.verifier_passed != null ? !!outcome.verifier_passed : null,
      missHappened: outcome.miss_happened != null ? !!outcome.miss_happened : undefined,
      patchSummary: outcome.patch_summary,
      changeFootprint: outcome.change_footprint,
      verification,
      verifierResult: outcome.verifier_result,
      outcome: outcome.outcome,
    };
    // 只传了变化量时,把 undefined 的语义键剔掉,让 learnStep 能用 lastStep 对齐。
    const stepKeysGiven = (outcome.action_type !== undefined || outcome.repo !== undefined || outcome.error_signature !== undefined);
    const alignedStep = stepKeysGiven ? step : {
      critHint: outcome.criticality_hint !== undefined ? critHint : undefined,
      dHint: outcome.difficulty_hint !== undefined ? dHint : undefined,
      progress: outcome.progress !== undefined ? progress : undefined,
    };
    // 三层学习(元认知 learnAbstract + 污染累计 + 技能库写真实经验,全在 learnStep 内)。
    const skillsBefore = agent.skills.size();
    agent.learnStep(alignedStep, result);
    const skillAdded = agent.skills.size() > skillsBefore;
    return {
      ok: true, nPrototypes: agent.meta.protos.length, nSkills: agent.skills.size(), skill_recorded: skillAdded,
      pollution: +agent.meta.z.pollution.toFixed(4),
      remaining_risk_budget: +agent.meta.z.riskBudget.toFixed(4),
      shift_score: +(0.4 * agent.meta.z.recentSurprise + 0.35 * agent.meta.z.verifyFailEwma + 0.25 * Math.min(1, agent.meta.z.residualEwma * 2)).toFixed(4),
    };
  }

  /**
   * ★受信任执行器背书签发(P0 attestation 的服务端入口)。
   *   只有【与调度器同进程/共享密钥】的隔离执行器能调到这里拿到有效签名 token。
   *   契约: caller 必须把【真实测试退出码】交进来(执行器只对真实结果签名)。
   *   远端 MCP 客户端即使能调用本工具,也只能拿到\"对它自报退出码的签名\"——但生产部署应把本工具
   *   限定为【仅本地执行器可达】(不暴露给不可信客户端);本仓库默认进程内执行器走 this.executor。
   * @param {object} args {exit_code|exitCode, test_cmd, commit_hash, patch_hash, source}
   * @returns {object} 带 {nonce, ts, attestation:{sig}} 的 verification,回 report_outcome 时原样带上即被信任。
   */
  issueAttestation(args = {}) {
    const exitCode = (typeof args.exit_code === "number") ? args.exit_code
                   : (typeof args.exitCode === "number") ? args.exitCode : null;
    return this.executor.runAndAttest({
      source: args.source ?? "executor",
      exitCode,
      testCmd: args.test_cmd ?? args.testCmd ?? null,
      commitHash: args.commit_hash ?? args.commitHash ?? null,
      patchHash: args.patch_hash ?? args.patchHash ?? null,
    });
  }

  /** 任务级反馈：整任务成/败 → 调协调变量 μ（稳定性条件），并自动持久化技能。 */
  taskFeedback(sessionId, success) {
    const { agent } = this._get(sessionId);
    agent.feedback(!!success);
    const n = this.persist(sessionId); // 任务结束自动持久化(元认知原型 + 技能记忆)
    return { ok: true, mu: +agent.meta.mu.toFixed(4), nPrototypes: n };
  }

  stats(sessionId) {
    const { agent, namespace } = this._get(sessionId);
    const st = agent.stats();
    return {
      namespace, nPrototypes: st.nProto, nSkills: st.nSkills, mu: +st.mu.toFixed(4), ignitions: st.ignitions,
      steps: agent.meta.z.steps, pollution: +agent.meta.z.pollution.toFixed(4),
    };
  }

  /** 导出元认知原型库 + 技能库（可读可存档，用于审计/迁移）。 */
  dumpPrototypes(sessionId) {
    const { agent, namespace } = this._get(sessionId);
    return {
      namespace, mu: +agent.meta.mu.toFixed(4),
      prototypes: agent.meta.protos.map((p, i) => ({
        id: i, n: p.n, confidence: +p.conf.toFixed(3), predErr: +p.predErr.toFixed(3),
        situationCentroid: p.protoFeat.map((v) => +v.toFixed(3)),
        readoutWeights: p.w.map((v) => +v.toFixed(3)),
      })),
      // ★技能库(领域经验):每条 = 真实错误→修法→受信验证结果(脱敏后可审计)。
      skills: agent.skills.toJSON().map((r, i) => ({
        id: i, repo: r.repo, branch: r.branch, lang: r.lang, fileType: r.fileType, actionType: r.actionType,
        errorSignature: r.errorSignature, patchSummary: r.patchSummary,
        verification: r.verification, verifierResult: r.verifierResult, outcome: r.outcome,
        injectionFlag: r.injectionFlag,
      })),
    };
  }

  closeSession(sessionId) {
    const n = this.persist(sessionId);
    this.sessions.delete(sessionId);
    return { ok: true, persistedPrototypes: n };
  }

  /** 导出当前任务【自动发现】的子目标簇(成员步 + 规模 + 耦合),用于审计介尺度结构。 */
  dumpClusters(sessionId) {
    const { agent } = this._get(sessionId);
    const clusters = agent.clusters ? agent.clusters.dump() : [];
    return { nClusters: clusters.length, clusters };
  }
}