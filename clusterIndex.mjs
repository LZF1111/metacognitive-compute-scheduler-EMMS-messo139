/**
 * clusterIndex.mjs —— 介尺度【子目标簇】的【自动发现】层(在线 union-find)。
 *
 * ── 这一层要修的病(评审与用户的核心质疑)──
 *   旧 clusterAgent.mjs 的簇边界是【外层 agent 手喂】(必须显式 startCluster())。
 *   于是它证明的是"已知边界后,把边界内弱信号平均会更稳"——边界发现(真实里最难的一步)被当成输入,
 *   是循环论证。所以它一接真实就没法部署。
 *
 * ── 这一层怎么做"真"──
 *   簇【从决策时可见的真实信号里自动长出来】,绝不使用任何事后 oracle:
 *     (1) 文件重叠   : 两步触碰的文件集合 Jaccard ≥ 阈 → 连边(改同一批文件 = 强耦合子目标)。
 *     (2) 符号重叠   : 两步触碰的符号(函数/类/import)集合 Jaccard ≥ 阈 → 连边。
 *     (3) 测试失败传播: 一个失败测试覆盖的源文件 → 触碰这些文件的步,彼此连边
 *                       (失败测试把"该一起修的步"标定成一簇 —— 真实 agent 最强的耦合信号,且决策时可见)。
 *     (4) 计划父节点 : planner 给出的子任务 id(若有)→ 同父连边。
 *   连通分量 = 一个子目标簇。全部用 union-find 在线维护(每来一步只增量并边)。
 *
 * ── 它如何进入【同一条 EMMS 竞价】(不是旁路) ──
 *   对当前步给出【簇耦合证据】供 selfModel.decideAbstract 当一个【影子价/障碍项】(与 skill/action 同构):
 *     • coupling          : 簇的耦合强度 ∈[0,1](规模 + 边密度饱和)。
 *     • peerStakes        : 同簇其它步的最大后果(crit 估计 / 动作先验 / 已被判关键)。
 *     • peerIgnited       : 同簇是否已有步点燃(latch 倾向的连续版,不是硬 latch)。
 *     • peerVerifiedCrit  : 同簇是否有【受信验证】判定为真关键的步(接地于真实结果,事后回灌)。
 *   语义: 一步【单看 hint 平平】但属于一个【高后果且强耦合】的簇 → clusterPremium 抬 robBid → 整簇倾向一起进浓相。
 *   这正是"别被逐步噪声 hint 骗过去漏掉关键子任务",但簇是【自动发现】的,不是手喂。
 *
 * ── 接地纪律 ──
 *   连边只用【决策前可见】的 files/symbols/failingTests/planNode;簇的"真关键"标定只在 observe() 里
 *   用【受信验证结果】事后回灌(peerVerifiedCrit),与 skillMemory 的可信度纪律一致。
 */

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : (Number.isFinite(x) ? x : 0); }

function jaccard(aSet, bSet) {
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  const [small, large] = aSet.size <= bSet.size ? [aSet, bSet] : [bSet, aSet];
  for (const v of small) if (large.has(v)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union > 0 ? inter / union : 0;
}

export class ClusterIndex {
  /**
   * @param {object} opts
   *   fileJaccardTh   文件集合 Jaccard 连边阈(默认 0.34:至少约 1/3 重叠才算同子目标)
   *   symbolJaccardTh 符号集合 Jaccard 连边阈(默认 0.34)
   *   couplingSat     耦合饱和常数(默认 3:簇内边数 e → e/(e+sat) 饱和到 (0,1))
   *   maxSteps        在线索引最大步数(默认 2000,超出按最旧淘汰,防内存膨胀)
   */
  constructor(opts = {}) {
    this.fileJaccardTh = opts.fileJaccardTh ?? 0.34;
    this.symbolJaccardTh = opts.symbolJaccardTh ?? 0.34;
    this.couplingSat = opts.couplingSat ?? 3;
    this.maxSteps = opts.maxSteps ?? 2000;
    this.reset();
  }

  /** 新任务:清空索引(簇是任务内的子目标结构,不跨任务)。 */
  reset() {
    this.nodes = [];                 // [{id, files:Set, symbols:Set, planNode, critHint, critEst, actionPrior, ignited, verifiedCritical}]
    this.parent = [];                // union-find 父指针(按 nodes 下标)
    this.rank = [];
    this.edges = [];                 // [[i,j,reason]] 仅审计用
    this.idToIdx = new Map();        // stepId -> nodes 下标
    this.testToFiles = new Map();    // failingTest -> Set(覆盖的文件) (跨步累积:失败传播)
    this.planToIdx = new Map();      // planNode -> [下标...]
  }

  _find(i) {
    while (this.parent[i] !== i) { this.parent[i] = this.parent[this.parent[i]]; i = this.parent[i]; }
    return i;
  }
  _union(i, j, reason) {
    const ri = this._find(i), rj = this._find(j);
    if (ri === rj) return;
    if (this.rank[ri] < this.rank[rj]) { this.parent[ri] = rj; }
    else if (this.rank[ri] > this.rank[rj]) { this.parent[rj] = ri; }
    else { this.parent[rj] = ri; this.rank[ri]++; }
    this.edges.push([i, j, reason]);
  }

  /**
   * 登记一步【决策时可见】的耦合证据,并增量连边。返回该步的簇证据(供竞价用)。
   * @param {string} stepId
   * @param {object} ev {
   *   files: string[],          本步触碰的文件(决策时可见)
   *   symbols: string[],        本步触碰的符号/函数/类/import(决策时可见)
   *   failingTests: string[],   当前已知失败的测试 id(决策时可见;失败传播信号)
   *   coveredFiles: string[],   可选:当前失败测试覆盖到的源文件(若 agent 能从覆盖率/路径给出)
   *   planNode: string,         可选:planner 子任务 id
   *   critHint, critEst, actionPrior, ignited  本步的后果线索(用于簇聚合后果)
   * }
   */
  addStep(stepId, ev = {}) {
    const files = new Set((ev.files || []).map(String));
    const symbols = new Set((ev.symbols || []).map(String));
    const planNode = ev.planNode != null ? String(ev.planNode) : null;
    const node = {
      id: stepId, files, symbols, planNode,
      critHint: clamp01(ev.critHint ?? 0), critEst: clamp01(ev.critEst ?? 0),
      actionPrior: clamp01(ev.actionPrior ?? 0), ignited: !!ev.ignited,
      verifiedCritical: false,
    };
    const idx = this.nodes.length;
    this.nodes.push(node);
    this.parent.push(idx); this.rank.push(0);
    this.idToIdx.set(stepId, idx);

    // (3) 失败测试传播:累积 test→覆盖文件;本步触碰的文件若被任一失败测试覆盖 → 与该测试此前的步连边。
    const failing = (ev.failingTests || []).map(String);
    const covered = new Set((ev.coveredFiles || []).map(String));
    for (const t of failing) {
      let cf = this.testToFiles.get(t);
      if (!cf) { cf = new Set(); this.testToFiles.set(t, cf); }
      for (const f of covered) cf.add(f);
      for (const f of files) cf.add(f);   // 本步在处理这个失败测试 → 它触碰的文件也归该测试的传播集
    }

    // 与已有步增量连边(文件/符号重叠 + 失败测试共享 + 同 plan 父节点)。
    for (let j = 0; j < idx; j++) {
      const other = this.nodes[j];
      if (jaccard(files, other.files) >= this.fileJaccardTh) { this._union(idx, j, "file-overlap"); continue; }
      if (jaccard(symbols, other.symbols) >= this.symbolJaccardTh) { this._union(idx, j, "symbol-overlap"); continue; }
    }
    // 失败测试传播:本步文件命中某失败测试的覆盖集 → 与同覆盖集里的其它步连边。
    for (const t of failing) {
      const cf = this.testToFiles.get(t);
      if (!cf) continue;
      for (let j = 0; j < idx; j++) {
        const other = this.nodes[j];
        let hit = false;
        for (const f of other.files) if (cf.has(f)) { hit = true; break; }
        if (hit) this._union(idx, j, "test-failure-propagation");
      }
    }
    // 计划父节点:同 plan 子任务连边。
    if (planNode) {
      const peers = this.planToIdx.get(planNode);
      if (peers) for (const j of peers) this._union(idx, j, "plan-node");
      else this.planToIdx.set(planNode, []);
      this.planToIdx.get(planNode).push(idx);
    }

    if (this.nodes.length > this.maxSteps) this._evictOldest();
    return this.clusterEvidence(stepId);
  }

  /** 简单淘汰:超限时丢弃最旧一步(不影响近期在线决策;真实任务步数远小于上限)。 */
  _evictOldest() {
    // union-find 不便删除单点;实践中任务级 reset 已足够。此处仅防极端长会话内存膨胀:整体重建近 maxSteps/2 步。
    const keep = this.nodes.slice(-Math.floor(this.maxSteps / 2));
    this.reset();
    // 重放保留的步(用其原始证据无法完整还原边,简化:仅重建节点+文件/符号边)。
    for (const n of keep) {
      const idx = this.nodes.length;
      this.nodes.push(n); this.parent.push(idx); this.rank.push(0); this.idToIdx.set(n.id, idx);
      for (let j = 0; j < idx; j++) {
        const o = this.nodes[j];
        if (jaccard(n.files, o.files) >= this.fileJaccardTh || jaccard(n.symbols, o.symbols) >= this.symbolJaccardTh) this._union(idx, j, "rebuild");
      }
    }
  }

  /** 当前步所属簇的全部成员下标。 */
  _members(idx) {
    const root = this._find(idx);
    const out = [];
    for (let i = 0; i < this.nodes.length; i++) if (this._find(i) === root) out.push(i);
    return out;
  }

  /**
   * 事后回灌【受信验证】判定的真关键:让"同簇有受信验证为真关键的步"成为接地证据,
   * 后续同簇步的 clusterPremium 据此抬升(与 skillMemory 可信度纪律一致:只认真实结果)。
   * @param {string} stepId
   * @param {boolean} verifiedCritical 该步是否被受信验证判定为真关键(如:升级深审后测试才过 / 漏判真发生)
   */
  observe(stepId, verifiedCritical) {
    const idx = this.idToIdx.get(stepId);
    if (idx == null) return;
    if (verifiedCritical) this.nodes[idx].verifiedCritical = true;
  }

  /**
   * 给当前步的【簇耦合证据】(供 EMMS 竞价当影子价/障碍项)。
   * @returns {{
   *   clusterId, size, coupling, peerMaxCrit, peerMaxStakes, peerIgnited, peerVerifiedCritical, edgeReasons
   * }}
   */
  clusterEvidence(stepId) {
    const idx = this.idToIdx.get(stepId);
    if (idx == null) return { clusterId: null, size: 1, coupling: 0, peerMaxCrit: 0, peerMaxStakes: 0, peerIgnited: false, peerVerifiedCritical: false, edgeReasons: [] };
    const members = this._members(idx);
    const root = this._find(idx);
    const size = members.length;
    // 簇内边数(只统计两端都在本簇的边)。
    let intra = 0; const reasons = new Set();
    for (const [i, j, r] of this.edges) if (this._find(i) === root && this._find(j) === root) { intra++; reasons.add(r); }
    const coupling = clamp01(intra / (intra + this.couplingSat)); // 边越多越耦合,饱和到 (0,1)
    let peerMaxCrit = 0, peerMaxStakes = 0, peerIgnited = false, peerVerifiedCritical = false;
    for (const m of members) {
      if (m === idx) continue;
      const n = this.nodes[m];
      peerMaxCrit = Math.max(peerMaxCrit, n.critEst, n.critHint);
      peerMaxStakes = Math.max(peerMaxStakes, n.critEst, n.actionPrior);
      if (n.ignited) peerIgnited = true;
      if (n.verifiedCritical) peerVerifiedCritical = true;
    }
    return { clusterId: root, size, coupling: +coupling.toFixed(4), peerMaxCrit: +peerMaxCrit.toFixed(4),
             peerMaxStakes: +peerMaxStakes.toFixed(4), peerIgnited, peerVerifiedCritical, edgeReasons: [...reasons] };
  }

  /** 更新某步的后果线索(decideStep 拿到 critEst/ignite 后回写,供同簇后续步聚合)。 */
  updateNode(stepId, { critEst, actionPrior, ignited } = {}) {
    const idx = this.idToIdx.get(stepId);
    if (idx == null) return;
    const n = this.nodes[idx];
    if (critEst != null) n.critEst = clamp01(critEst);
    if (actionPrior != null) n.actionPrior = clamp01(actionPrior);
    if (ignited != null) n.ignited = !!ignited;
  }

  /** 审计:导出当前所有簇(成员 stepId + 规模 + 耦合)。 */
  dump() {
    const seen = new Map();
    for (let i = 0; i < this.nodes.length; i++) {
      const r = this._find(i);
      if (!seen.has(r)) seen.set(r, []);
      seen.get(r).push(this.nodes[i].id);
    }
    return [...seen.entries()].map(([root, ids]) => ({ clusterId: root, size: ids.length, members: ids }));
  }
}
