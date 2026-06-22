/**
 * clusterAgent.mjs —— beta-mesoscale2 的介尺度【子目标簇】层。
 *
 * ── 动机(用户的三尺度划分)──
 *   • 小尺度 = 最小单元 = 单步决策(System1/System2)。
 *   • 介尺度 = 单元【间】的竞争-协调。原 selfModel 把"单元"取成单步,簇是难度相近的步在
 *     共享 μ 下涌现聚到一起;本层把它【显式化】——相邻强耦合步归成一个"子目标簇",
 *     竞争-协调发生在【簇间】而非孤立步间。
 *   • 大尺度 = 整个任务。
 *
 * ── 为什么簇层有价值(贴 EMMS 的乘法耦合)──
 *   任务正确率 = Π P(step)。一个簇内若有真关键步,它在低功率下 P≈0 会清零整簇/整任务。
 *   所以一簇耦合步应【一起进浓相(System2)】,而不是各自按自己的(可能很弱/带噪的)hint 单独决策。
 *   现实里单步 hint 常不准(用户第 3 点):簇层把【簇内多个弱 hint 聚合】→ 恢复簇的潜在关键度
 *   → 救回"簇真关键但某步 hint 偏低"的漏判。这是簇层相对逐步层的核心增益,且与 EMMS 同构:
 *   簇 = 浓相的耦合单元团,不是孤立粒子。
 *
 * ── 复用同一个单元引擎(公平对比)──
 *   本层【不改】selfModel 的竞价/学习,只改"喂给单元引擎的特征 = 簇聚合特征"并加【簇内latch】:
 *   一旦簇被判关键(点燃),簇内剩余步一律 System2(耦合相不再逐步重判)。
 *   这样 A/B 的唯一自变量 = 介尺度是"逐步"还是"成簇",而非引擎本身。
 */
import { SelfModelAgent } from "./selfModel.mjs";

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

export class ClusterAgent {
  /**
   * @param {object} opts            透传给 SelfModelAgent 的构造参数(保持与逐步层一致)。
   * @param {object} [clusterOpts]   簇层参数。
   *   • aggregate: "running" | "prior"  簇内聚合方式。
   *       running = 用簇内"已见步"的 hint 滑动均值(在线,无未来信息);
   *       prior   = 簇开始时给定的簇先验(若环境提供 cluster_hint)。默认 running。
   *   • latch: 簇一旦点燃 → 剩余步强制 System2(浓相耦合)。默认 true。
   */
  constructor(opts = {}, clusterOpts = {}) {
    this.agent = new SelfModelAgent(opts);
    this.aggregate = clusterOpts.aggregate ?? "running";
    this.latch = clusterOpts.latch ?? true;
    this._resetCluster();
  }

  newTask() {
    this.agent.newTask();
    this._resetCluster();
  }

  _resetCluster() {
    this.cl = { n: 0, sumCrit: 0, sumDiff: 0, ignited: false, priorCrit: null, priorDiff: null };
  }

  /** 进入一个新子目标簇:重置簇内证据。可选给簇先验(cluster_crit_hint/cluster_diff_hint)。 */
  startCluster(prior = {}) {
    this._resetCluster();
    if (prior.cluster_crit_hint != null) this.cl.priorCrit = prior.cluster_crit_hint;
    if (prior.cluster_diff_hint != null) this.cl.priorDiff = prior.cluster_diff_hint;
  }

  /**
   * 簇内一步决策。step = {criticality_hint, difficulty_hint, progress, irreversible?, riskClass?}。
   * 关键差异:喂给单元引擎的不是【这一步的裸 hint】,而是【簇聚合 hint】(降低单步噪声);
   * 且若簇已 latch → 直接 System2。
   * @returns 单元引擎的决策对象 d(含 mode/ignite/verify/...),附 d._clusterCritEst。
   */
  decideStep(step) {
    // 1) 更新簇内证据(在线:把当前步的 hint 计入运行均值)。
    this.cl.n++;
    this.cl.sumCrit += step.criticality_hint;
    this.cl.sumDiff += step.difficulty_hint;

    // 2) 簇聚合关键度/难度估计。
    let clCrit, clDiff;
    if (this.aggregate === "prior" && this.cl.priorCrit != null) {
      clCrit = this.cl.priorCrit;
      clDiff = this.cl.priorDiff != null ? this.cl.priorDiff : this.cl.sumDiff / this.cl.n;
    } else {
      clCrit = this.cl.sumCrit / this.cl.n; // 簇内已见步的 hint 均值(聚合弱信号)
      clDiff = this.cl.sumDiff / this.cl.n;
    }

    // 3) 已 latch(簇此前已被判关键)→ 浓相耦合:整簇一起 System2,不再逐步重判。
    if (this.latch && this.cl.ignited) {
      // 仍调引擎学习路径所需的污染/状态,但强制 deep。
      const x = [clamp01(clCrit), clamp01(clDiff), step.progress ?? 0];
      const d = this.agent.decideAbstract(x, this.agent.z.pollution, {
        riskClass: step.riskClass || (step.irreversible ? "irreversible" : "normal"),
        actionType: step.actionType,
      });
      d.mode = "system2"; d.ignite = true; d._clusterLatched = true; d._clusterCritEst = clCrit;
      return d;
    }

    // 4) 正常:用【簇聚合特征】喂单元引擎竞价(而非裸单步 hint)。
    const x = [clamp01(clCrit), clamp01(clDiff), step.progress ?? 0];
    const d = this.agent.decideAbstract(x, this.agent.z.pollution, {
      riskClass: step.riskClass || (step.irreversible ? "irreversible" : "normal"),
      actionType: step.actionType,
    });
    d._clusterCritEst = clCrit; d._clusterLatched = false;
    // 簇点燃 → latch(浓相形成)。
    if (this.latch && d.ignite) this.cl.ignited = true;
    return d;
  }

  /**
   * 簇内一步学习。observedCrit = 真关键度(事后 oracle)。
   * 喂引擎时用簇聚合特征(与 decide 对齐),让原型学到的是"簇级"映射。
   */
  learnStep(step, observedCrit, ignited, fb = {}) {
    const clCrit = (this.aggregate === "prior" && this.cl.priorCrit != null)
      ? this.cl.priorCrit : this.cl.sumCrit / Math.max(1, this.cl.n);
    const clDiff = (this.aggregate === "prior" && this.cl.priorDiff != null)
      ? this.cl.priorDiff : this.cl.sumDiff / Math.max(1, this.cl.n);
    const x = [clamp01(clCrit), clamp01(clDiff), step.progress ?? 0];
    this.agent.learnAbstract(x, observedCrit, ignited, fb, { actionType: step.actionType });
  }

  addPollution(consulted, deep) { this.agent.addPollution(consulted, deep); }
  feedback(success) { this.agent.feedback(success); }
  stats() { return this.agent.stats(); }
}
