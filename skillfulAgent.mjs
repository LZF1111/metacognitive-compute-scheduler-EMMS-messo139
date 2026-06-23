/**
 * skillfulAgent.mjs —— 完整三层【竞争-协调(EMMS)】框架的组装。
 *
 * ── 用户要求 ──
 *   "都要,而且要学到代码语义、仓库边界、操作类型、真实验证结果。竞争协调机制要作为
 *    一个完整的被优化的非常好的框架。"
 *
 * ── 三层(全部通过同一个 EMMS 竞价协调,不是松散拼接)──
 *   • 元认知层 (selfModel)  : 学"该不该深思"的元策略(原型库 + μ 影子价)。小尺度单元决策。
 *   • 技能层   (skillMemory): 学【领域语义】——仓库/语言/文件类型/操作类型/错误签名/堆栈/改动面/
 *                             修法摘要/真实验证结果。给出 novelty/priorSuccess/repoMatch/可复用修法。
 *   • 介尺度簇 (可选,与 clusterAgent 同构): 子目标簇间竞争。本类聚焦元认知×技能的耦合。
 *
 * ── 竞争-协调如何把技能层纳入(关键)──
 *   skillMemory.query → {novelty, priorSuccess, repoMatch, verifiedSupport, priorFix, bestSim}
 *   作为 ctx.skill 传入 selfModel.decideAbstract,在【同一条 robBid > ecoAsk 竞价】里:
 *     - 有同仓库+真验证可复用修法 → skillReuseDiscount 降 robBid(经验复用=省深思+给 reusableFix)。
 *     - 语义陌生 novelty 高           → skillNoveltyPremium 抬 robBid(谨慎探索)。
 *     - 相似但跨仓库               → crossRepoPremium 抬 robBid(仓库边界,别盲信跨域)。
 *   于是"学到的领域经验"真正改变算力决策:见过且验证过 → 敢省;没见过/跨域 → 谨慎。
 *
 * ── 接地纪律(回应"否则只是越来越信任上游提示词")──
 *   priorSuccess 只由真实验证通过的记录加权;相似度基于真实错误/堆栈/补丁文本;
 *   学习用真实 verifierResult/outcome。提示词 critHint 仍是元认知层的一个输入,但不再是唯一证据。
 */
import { SelfModelAgent } from "./selfModel.mjs";
import { SkillMemory } from "./skillMemory.mjs";
import { ClusterIndex } from "./clusterIndex.mjs";

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : (Number.isFinite(x) ? x : 0); }

/** 去掉值为 undefined 的键(用于把回报时显式给的字段覆盖到记住的上一步语义上,而不被 undefined 抹掉)。 */
function stripUndefined(o) {
  const out = {};
  for (const k in o) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export class SkillfulAgent {
  /**
   * @param {object} opts        透传给 SelfModelAgent(含 skillReuseWeight 等技能竞价权重)。
   * @param {object} [skillOpts] 透传给 SkillMemory。
   */
  constructor(opts = {}, skillOpts = {}) {
    this.meta = new SelfModelAgent(opts);
    this.skills = new SkillMemory(skillOpts);
    this.clusters = new ClusterIndex(opts.clusterOpts || {});
    this.lastStep = null; // 上一步 decideStep 的语义,用于 learnStep 自动对齐(防遗漏字段悄悄退化)
  }

  newTask() { this.meta.newTask(); this.clusters.reset(); this.lastStep = null; }

  /**
   * 一步决策。把真实语义查询 → 技能信号 → 并入元认知 EMMS 竞价。
   * @param {object} step {
   *   // 元认知层输入(决策时可见的弱线索)
   *   critHint, dHint, progress,
   *   // 技能层输入(决策时可见的真实语义:报错先于修复,无泄漏)
   *   repo, lang, fileType, actionType, errorSignature, stackFeatures,
   *   // 风险声明(可选)
   *   riskClass, irreversible,
   * }
   * @returns 决策对象 d(含 mode/verify/技能竞价项/reusableFix/skillSignal)。
   */
  decideStep(step) {
    // 1) 技能层检索(真实语义 → 可复用经验信号)。
    const skillSignal = this.skills.query({
      repo: step.repo, lang: step.lang, fileType: step.fileType, actionType: step.actionType,
      errorSignature: step.errorSignature, stackFeatures: step.stackFeatures,
    });
    // 2) 组装进 EMMS 竞价的技能上下文。
    const skill = {
      novelty: skillSignal.novelty,
      priorSuccess: skillSignal.priorSuccess,
      repoMatch: skillSignal.repoMatch,
      verifiedSupport: skillSignal.verifiedSupport,
      bestSim: skillSignal.bestSim,
      hasReusableFix: skillSignal.priorFix != null,
      priorFix: skillSignal.priorFix,
    };
    // 2.5) ★介尺度簇层:把本步的【决策时可见耦合证据】登记进自动发现索引,拿回簇证据进同一条竞价。
    //   stepId 默认自增;调用方可显式传 step.stepId。先用技能层先验关键度初始化簇节点后果(actionPrior)。
    const stepId = step.stepId != null ? String(step.stepId) : `s${this.clusters.nodes.length}`;
    const actionPrior = this.meta.actionPriors[step.actionType] ?? (this.meta.mutatingActions.has(step.actionType) ? 0.8 : 0.3);
    let cluster = null;
    if (step.files || step.symbols || step.failingTests || step.planNode || step.stepId != null) {
      cluster = this.clusters.addStep(stepId, {
        files: step.files, symbols: step.symbols, failingTests: step.failingTests,
        coveredFiles: step.coveredFiles, planNode: step.planNode,
        critHint: step.critHint, critEst: step.critHint, actionPrior, ignited: false,
      });
    }
    // 3) 元认知层竞价决策(技能项+动作项+簇项+安全障碍全在同一条竞价里)。
    const x = [clamp01(step.critHint ?? 0.5), clamp01(step.dHint ?? 0.5), clamp01(step.progress ?? 0)];
    const d = this.meta.decideAbstract(x, this.meta.z.pollution, {
      riskClass: step.riskClass || (step.irreversible ? "irreversible" : "normal"),
      actionType: step.actionType,
      skill,
      cluster,
    });
    d.skillSignal = skillSignal;          // 完整技能检索结果(供审计)
    // ★仓库边界铁律:reusableFix 只取【同仓库 priorFix】;跨仓库经验绝不作为可直接套用的修法,
    //   只放进 referenceCase(参考案例/需人工审查)。
    d.reusableFix = skillSignal.priorFix ?? null;
    d.referenceCase = skillSignal.referenceCase ?? null;
    // 簇节点回写本步的真实关键估计 + 是否点燃,供同簇后续步聚合后果。
    if (cluster) {
      this.clusters.updateNode(stepId, { critEst: d.critEst, actionPrior, ignited: d.ignite });
      d.clusterId = cluster.clusterId; d.stepId = stepId;
    }
    // 记住本步语义,供 learnStep 默认对齐(调用方回报时可省略重复字段)。
    this.lastStep = { ...step, stepId };
    return d;
  }

  /**
   * 一步学习。事后用【真实验证结果】更新两层。
   * @param {object} step          同 decideStep 的 step。
   * @param {object} result {
   *   observedCrit,      真关键度(由真实升档/测试观测)∈[0,1]
   *   ignited,           该步是否走了 System2
   *   wasDeep,           该步是否做了深处理(默认同 ignited;影响上下文污染累计)
   *   verifierPassed,    真实验证器结果 true/false/null
   *   missHappened,      漏判是否真发生
   *   // 技能记录(事后才有的真实内容)
   *   patchSummary,      真实修法摘要(可复用 skill 本体)
   *   changeFootprint,   真实改动面 {files,hunks,loc}
   *   verifierResult,    真实验证结果标签 "test_passed"|"test_failed"|...
   *   outcome,           1 成功 / 0 失败(真测试判定)
   * }
   */
  learnStep(step = {}, result = {}) {
    // ★自动对齐:用上一步 decideStep 记住的语义补齐缺失字段(防调用方遗漏 action_type 等导致悄悄退化)。
    if (this.lastStep) step = { ...this.lastStep, ...stripUndefined(step) };
    // 1) 元认知层学习(真验证结果喂进残差/预算/原型)。
    const x = [clamp01(step.critHint ?? 0.5), clamp01(step.dHint ?? 0.5), clamp01(step.progress ?? 0)];
    this.meta.learnAbstract(x, clamp01(result.observedCrit ?? 0), !!result.ignited, {
      verifierPassed: result.verifierPassed != null ? !!result.verifierPassed : null,
      missHappened: result.missHappened,
    }, { actionType: step.actionType });
    // 上下文污染:consulted=是否走了深思(点燃),deep=是否做了深处理(默认同点燃,可由 wasDeep 覆盖)。
    const wasDeep = result.wasDeep != null ? !!result.wasDeep : !!result.ignited;
    this.meta.addPollution(!!result.ignited, wasDeep);

    // 1.5) ★介尺度簇层回灌【受信验证】判定的真关键(接地):
    //   一步若被真实结果证明为关键(漏判真发生 / 验证失败需升级 / observedCrit 高),把它标进簇,
    //   后续同簇步的 clusterPremium 据此抬升。只认真实结果,与 skillMemory 可信度纪律一致。
    if (step.stepId != null) {
      const verifiedCritical = result.missHappened === true
        || result.verifierPassed === false
        || clamp01(result.observedCrit ?? 0) >= this.meta.criticalGate;
      this.clusters.observe(String(step.stepId), verifiedCritical);
    }

    // 2) 技能层写入【真实语义经验】——仅当本步确有可记录的修法/验证结果(改动类步骤)。
    //    这是"学到特别的东西":把真实错误→真实修法→真实验证 存成可复用记录。
    const isMutating = this.meta.mutatingActions.has(step.actionType);
    const hasRealOutcome = result.verification != null || result.verifierResult != null || result.outcome != null || result.patchSummary;
    if (isMutating && hasRealOutcome) {
      this.skills.add({
        repo: step.repo, branch: step.branch, lang: step.lang, fileType: step.fileType, actionType: step.actionType,
        errorSignature: step.errorSignature, stackFeatures: step.stackFeatures,
        changeFootprint: result.changeFootprint,
        patchSummary: result.patchSummary,
        // ★可信度来自【受信任执行器】写入的结构(source/exitCode/testCmd/commit/patch hash),非 agent 自报。
        verification: result.verification,
        verifierResult: result.verifierResult,
        outcome: result.outcome,
      });
    }
    this.lastStep = null; // 本步已结算,清空对齐缓存
  }

  feedback(success) { this.meta.feedback(success); }

  stats() {
    return { ...this.meta.stats(), nSkills: this.skills.size() };
  }

  /** 持久化两层(跨会话复用元认知原型 + 领域技能)。 */
  toJSON() {
    return {
      mu: this.meta.mu,
      protos: this.meta.protos.map((p) => ({
        protoFeat: p.protoFeat, w: p.w, n: p.n, conf: p.conf, predErr: p.predErr,
        theta: p.policy.theta, muBias: p.policy.muBias,
      })),
      skills: this.skills.toJSON(),
    };
  }

  /**
   * 从 toJSON() 的快照恢复两层(跨 MCP 重启真正复用元认知原型 + 领域技能)。
   * 回应\"SkillfulAgent 有 toJSON 但没有恢复方法\":这里把元认知原型库 + μ + 技能记忆全部灌回。
   * @param {object} data    toJSON() 产物 {mu, protos, skills}
   * @param {object} [opts]      透传给 SelfModelAgent
   * @param {object} [skillOpts] 透传给 SkillMemory
   */
  static fromJSON(data = {}, opts = {}, skillOpts = {}) {
    const a = new SkillfulAgent(opts, skillOpts);
    a.restore(data);
    return a;
  }

  /** 把快照灌入当前实例(原地恢复)。 */
  restore(data = {}) {
    if (typeof data.mu === "number") this.meta.mu = data.mu;
    if (Array.isArray(data.protos)) {
      this.meta.protos = data.protos.map((s) => ({
        protoFeat: s.protoFeat.slice(),
        policy: { theta: s.theta ?? 0.6, muBias: s.muBias ?? 0 },
        w: s.w.slice(), n: s.n ?? 1, conf: s.conf ?? 0.3, predErr: s.predErr ?? 0.5,
        // critEst 按存储的 w 长度迭代(新旧维度原型混存安全)。
        critEst(rf) { let v = 0; for (let i = 0; i < this.w.length; i++) v += this.w[i] * rf[i]; return clamp01(v); },
      }));
    }
    // 技能记忆重建(重算 embedding,保证哈希一致),沿用当前实例的检索超参。
    const skillOpts = { k: this.skills.k, simStrong: this.skills.simStrong, maxRecords: this.skills.maxRecords };
    this.skills = SkillMemory.fromJSON(data.skills || [], skillOpts);
    return this;
  }
}
