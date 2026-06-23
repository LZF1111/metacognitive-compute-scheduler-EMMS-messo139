/**
 * 自我模型 / 全局工作空间 —— selfModel.mjs
 *

 *
 * 一个原型 = {protoFeat:情形质心, policy:{theta,muBias}, conf, n}。它就是"被压缩成直觉的 skill"。
 */
// (self-contained: no external imports)

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

/** 情形签名间的距离（高斯核相似度用）。
 *  ★长度健壮:原型库可能混有不同维度的签名(旧持久化 3 维 + 新版含动作维)。
 *  按【较短者】求和 → 旧原型在动作维上不参与判别(优雅降级),不会读到 undefined 产生 NaN。 */
function dist2(a, b) { const m = Math.min(a.length, b.length); let s = 0; for (let i = 0; i < m; i++) { const d = a[i] - b[i]; s += d * d; } return s; }

/**
 * ★自我模型智能体。
 * 在 agent loop 的每一步：
 *   1) 读情形签名 x（环境给的弱线索）→ 在原型库里找最匹配的原型（注意力聚焦）。
 *   2) 计算【惊讶】= 1 - 最佳匹配相似度（没有原型解释得了当前情形 = 高惊讶）。
 *   3) 惊讶低 → 用该原型的策略【直觉处理】（System 1，安静）。
 *      惊讶高 → 点燃：全局广播 + System 2 审视 + 要么细化已有原型、要么新建原型（自生 skill）。
 *   4) loop 级：维护自我状态 z（当前活跃原型 id、近期惊讶水平、谨慎度 μ），用于察觉中途变性。
 */
export class SelfModelAgent {
  constructor(opts = {}) {
    this.protos = [];                 // 原型库（自己长出的 skill）
    this.simTau = opts.simTau ?? 0.18;       // 相似度核宽：太大→不同关键度的情形被并成一个原型(欠分化)；太小→原型永不复用。0.18 让易/难题各自成型。
    this.mergeSim = opts.mergeSim ?? 0.7;    // ★合并阈值：新情形与最近原型相似度>此→合并而非新建(防膨胀)。配合 simTau 让真正相似的才合并。
    this.maxProto = opts.maxProto ?? 12;     // ★原型库上限（意识是稀缺的：少量稳定图式，满了淘汰最弱）
    this.lr = opts.lr ?? 0.12;
    this.mu = opts.mu0 ?? 1.0;        // 全局谨慎度 = 风险的影子价（竞争-协调的协调变量）
    this.muLr = opts.muLr ?? 0.10;
    this.consultCost = opts.consultCost ?? 0.10;   // 经济机制：一次点燃的固定代价
    this.polluteWeight = opts.polluteWeight ?? 0.6; // 经济机制：当前上下文污染对"再点燃"的抑制权重
    // ── 成本敏感决策参数(直接对齐真实代价的不对称性)──
    //   missPenalty = 漏判一个关键步的代价(System1处理了关键步→失败→还得升级重做,很贵)。
    //   overThinkCost = 在非关键步过度深思的代价(浪费算力+污染上下文)。
    //   真实里 missPenalty >> overThinkCost(漏判要重做,过度只是浪费),故点燃判定本就该偏谨慎。
    this.missPenalty = opts.missPenalty ?? 6;      // 漏判关键步的代价(complexTask: 1次便宜白跑+5强模型重做)
    this.overThinkCost = opts.overThinkCost ?? 4;  // 非关键步过度深思的代价(complexTask: 浪费4)
    // ── 安全约束【作为障碍项/影子价进入竞争-协调竞价】(不是绕过竞价的 if-else 覆盖)──
    //   旧版只有一条软竞价,missPenalty 再大也只是偏好,会在某些 regime 拿安全换成本。
    //   新版把约束写进稳健机制的出价:硬约束=∞障碍, 风险预算=绑定约束的影子价。均衡可行域内退化为原竞价。
    this.criticalGate = opts.criticalGate ?? 0.75; // 风险上界 pUpper 超此 → 当作 hard-critical(∞障碍)
    // verifyGate = 挂便宜验证器的风险上界阈。原则:验证是廉价保险,期望收益 pUpper·recall·missPenalty
    //   > verifyCost 即值得 → 阈 ≈ verifyCost/(recall·missPenalty) ≈ 0.8/(0.9·6) ≈ 0.15。故默认 0.15(非任意)。
    this.verifyGate = opts.verifyGate ?? 0.15;
    this.kUpper = opts.kUpper ?? 0.5;              // pUpper 相对 pMean 的不确定度膨胀(陌生/原型不准→上界更高)
    this.kSample = opts.kSample ?? 0.25;           // 小样本膨胀:原型样本少(nEff 小)→上界更高(保守)
    this.shiftTh = opts.shiftTh ?? 0.6;            // 残差式变性探测阈(综合陌生度/验证失败率/关键度残差)
    this.safeWindowLen = opts.safeWindowLen ?? 3;  // 检测到变性后进入的"安全探索窗口"步数(期间稳健机制溢价)
    this.hardBarrier = opts.hardBarrier ?? 1e6;    // 硬约束的障碍权重(→∞ 的有限近似):使稳健出价必然压过经济要价
    this.budgetSoft = opts.budgetSoft ?? 1.0;      // 风险预算的软区宽度:剩余预算<此则影子价连续抬升(线性逼近∞)
    // 风险预算 = 每任务能容忍的"累计未验证漏判风险"总额(单位:Σ pUpper)。
    //   不是单步门:它随便宜步累加 pUpper 而耗尽。剩余越紧→影子价越高(连续抬升稳健出价),耗尽→∞。
    //   足够宽裕(默认2.5)使其只作后备保险,正常步由 ROB-vs-ECO 成本敏感竞价主导(复现旧版省成本的好处)。
    this.riskBudget0 = opts.riskBudget0 ?? 2.5;
    // ── ★改进1: 代码修改类动作不能仅靠风险估计降级 → 动作类型【硬约束】(与 pUpper 正交) ──
    //   病根: 那 2 次 design_patch 漏判 = critHint 被压低 + μ 衰减 → pUpper 没过 criticalGate → 无障碍 → 降 System1。
    //   修法: 凡"改动代码/状态"的动作(写码/打补丁/设计补丁/应用patch/编辑),不论风险估计多低,
    //         一律【至少强制 verify=test】;且把动作语义当作竞价里的稳健溢价(actionPremium),
    //         默认不强制点燃(允许 System1 起草)但必须验证——把"猜对没有"变成"测过了"。
    //   mutatingActions = 触发强制 test 的动作集合; actionPriors = 各动作类型的先验关键度(语义信号)。
    this.mutatingActions = new Set(opts.mutatingActions ?? [
      "write_code", "apply_patch", "design_patch", "edit_file", "refactor", "delete", "migrate_schema",
    ]);
    this.actionPriors = opts.actionPriors ?? {
      // 改动代码/状态类:先验关键度高(语义上就该谨慎),与上游 critHint 解耦。
      write_code: 0.8, apply_patch: 0.85, design_patch: 0.85, edit_file: 0.7, refactor: 0.75,
      delete: 0.95, migrate_schema: 0.95,
      // 只读/检索/分诊类:先验低(可大胆 System1)。
      read_issue: 0.2, retrieve: 0.2, locate: 0.35, triage: 0.25, run_test: 0.4, inspect: 0.3,
    };
    // forceVerifyMutating: 改动类动作是否强制至少 test(默认 true=回应用户"代码修改步骤应至少强制 test")。
    this.forceVerifyMutating = opts.forceVerifyMutating ?? true;    // ── ★按操作类型分派【验证策略】(回应\"design_patch/apply_patch/run_test 应是不同验证策略\")──
    //   不同动作的\"正确验证\"不同:设计补丁要先评审+干跑,应用补丁/写码要跑测试,删除/迁移不可逆要干跑+策略检查,
    //   跑测试本身就是验证(不必再套一层)。这张表是【改动类动作 → 验证动作】的语义映射,
    //   仍受 verify 选型主流程约束(irreversible/critical 的硬验证优先级更高)。
    this.actionVerifier = opts.actionVerifier ?? {
      design_patch: "review",       // 设计补丁:先人审/方案评审(改动面大,语义错代价高)
      apply_patch: "test",          // 应用补丁:跑测试确认没回归
      write_code: "test",           // 写新代码:跑测试
      edit_file: "test",            // 编辑文件:跑测试
      refactor: "test",             // 重构:跑测试(行为不变断言)
      delete: "dry_run",            // 删除:干跑确认影响面(不可逆)
      migrate_schema: "dry_run",    // schema 迁移:干跑(不可逆)
      run_test: "none",             // 跑测试动作本身即验证,不再叠加
    };
    // actionPremiumWeight: 改动类动作给稳健出价的语义溢价权重(随 actionPrior 抬高 robBid,但非∞,不强制点燃)。
    this.actionPremiumWeight = opts.actionPremiumWeight ?? 0.5;
    // ── ★技能层(领域语义)信号进入同一 EMMS 竞价的权重(完整框架的第三个证据源)──
    //   skillReuseWeight  : 有【同仓库+真验证】可复用修法 → 降 robBid(经验复用=不必每次重新深思,直接省)。
    //   skillNoveltyWeight: 语义上没见过(novelty 高) → 抬 robBid(陌生要谨慎探索,无经验可依)。
    //   crossRepoWeight   : 有相似先例但来自【不同仓库】 → 抬 robBid(仓库边界:不可盲信跨域经验)。
    //   这三项是约束/激励进入经济均衡的标准做法,与已有 actionPremium/budgetShadow 同构,由 μ 协调。
    //   不传 ctx.skill → 三项全 0 → 退化为纯元认知竞价(零回归)。
    this.skillReuseWeight = opts.skillReuseWeight ?? 0.4;
    this.skillNoveltyWeight = opts.skillNoveltyWeight ?? 0.3;
    this.crossRepoWeight = opts.crossRepoWeight ?? 0.5;
    this.deepEwma = 0.5;
    this.canGrow = opts.canGrow ?? true;     // 能否自生原型（关掉=只能用已有=类 skill 库）
    this.canShift = opts.canShift ?? true;   // 能否中途切换活跃原型（关掉=锁死，模拟 skill 派发）
    // 自我状态 z（loop 级，被全局广播）。pollution = 本任务已累积的上下文污染(agent 自估)。
    //   residualEwma  = 关键度预测残差的滑动均值(预测越来越不准 = 可能变性);
    //   verifyFailEwma= 最近 verifier/升级失败率(行为层面的变性信号,比相似度更可靠);
    //   safeWindow    = 安全探索窗口剩余步数; riskBudget = 本任务剩余风险预算。
    this.z = { activeProto: -1, recentSurprise: 0.5, steps: 0, ignitions: 0, pollution: 0,
               residualEwma: 0, verifyFailEwma: 0, safeWindow: 0, riskBudget: this.riskBudget0 };
  }

  /** 新任务开始：重置 loop 级自我状态（上下文清空）。原型库与 μ 跨任务保留。 */
  newTask() {
    this.z.pollution = 0; this.z.activeProto = -1; this.z.recentSurprise = 0.5;
    this.z.residualEwma = 0; this.z.verifyFailEwma = 0; this.z.safeWindow = 0;
    this.z.riskBudget = this.riskBudget0;
  }

  /** 情形签名 → [crit线索, 难度线索, 进度]。环境只给弱线索；真关键度隐藏。 */
  _feat(step) { return [step.critHint, step.dHint, step.i / step.n]; }
  /** 读出用特征（带偏置项 1，泛化为任意维:让原型能学仕射映射,如 regime B 的 crit=1-dHint,
   *  以及【动作类型】维。旧 3 维签名 → [1,c,d,p] 与历史完全一致(零回归)。 */
  _rfeat(x) { return [1, ...x]; }

  /**
   * ★改进2(语义经验):动作类型特征。把"这步在干什么"编进情形签名,让原型【按动作分化】、
   * 读出能学到"design_patch 本身就关键(与 critHint 无关)"——直接修"只信 critHint"的病根。
   *   返回 [mutates, actionPrior]:
   *     mutates    ∈{0,1} 是否改动代码/状态(写码/打补丁/设计补丁/编辑=1);
   *     actionPrior∈[0,1] 该动作类型的先验关键度(语义信号,独立于上游 critHint)。
   *   不传 actionType → [0,0] → 签名退化为旧 3 维,SGD 在动作维拿不到梯度 → 行为不变(零回归)。
   */
  _actionVec(ctx = {}) {
    const a = ctx.actionType;
    if (!a) return [0, 0];
    const mutates = this.mutatingActions.has(a) ? 1 : 0;
    const prior = this.actionPriors[a] ?? (mutates ? 0.8 : 0.3);
    return [mutates, prior];
  }

  /** 把基础签名 x(前3维 [crit,难,进度]) 与动作维拼成完整内部签名。 */
  _xFull(x, ctx = {}) { return [x[0], x[1], x[2], ...this._actionVec(ctx)]; }

  /** 找最匹配原型 + 相似度。无原型则返回 null。 */
  _match(x) {
    let best = null, bestSim = 0;
    for (const p of this.protos) {
      const sim = Math.exp(-dist2(x, p.protoFeat) / (2 * this.simTau));
      if (sim > bestSim) { bestSim = sim; best = p; }
    }
    return { proto: best, sim: bestSim };
  }

  _theta(p) {
    // 原型自带策略偏置 + 全局谨慎度调制（μ 大→阈值低→更爱深处理）。
    const base = p ? p.policy.theta : 0.6;
    return clamp01(base - 0.20 * Math.tanh(this.mu - 1) + (p ? p.policy.muBias : 0));
  }

  decide(step) {
    this.z.steps++;
    const x = this._feat(step);
    const { proto, sim } = this._match(x);
    const surprise = 1 - sim;                       // 没原型能解释 = 高惊讶
    this.z.recentSurprise = 0.8 * this.z.recentSurprise + 0.2 * surprise;

    let activeProto = proto;
    let consulted = false;

    // ── 点燃判定 = System1(经济) vs System2(稳健) 的【显式竞争-协调】 ──
    // 这正是 EMMS"竞争中的协调"搬到 agent loop 的 System1/System2 边界：
    //   • 经济机制(eco)：想省、不点燃、不污染上下文。代价倾向 → min。
    //   • 稳健机制(rob)：想点燃深审看准关键步。风险倾向 → min。
    // 两者无法同时满足，由谨慎度 μ（风险的影子价）协调出工作点。
    //
    // 稳健机制的【点燃收益】= μ · 关键性权重 · 不确定度
    //   不确定度 uncert 主导：原型越没把握(predErr 高)/情形越陌生(sim 低)，点燃信息增益越大。
    //   关键性权重 (0.5+critEst)：可能关键的步加权，但不让低 critEst 完全压死点燃(否则漏判)。
    const critEst = proto ? proto.critEst(this._rfeat(x)) : 0.5;
    const uncert = proto ? proto.predErr * (2 - sim) : 1.0;
    const robGain = this.mu * (0.5 + critEst) * uncert;
    // 经济机制的【点燃代价】= 固定深审成本 + λ·当前上下文污染（污染越重越不该再点燃，避免自毒）。
    const ecoCost = this.consultCost + this.polluteWeight * this.z.pollution;
    // 协调：稳健收益 > 经济代价 才点燃。库空必点燃(无图式可依)；变性强制重审。
    const regimeShift = this.canShift && proto && this.z.activeProto !== -1 &&
      proto !== this.protos[this.z.activeProto] && sim < 0.7;
    const ignite = this.protos.length === 0 || robGain > ecoCost || regimeShift;

    if (ignite) {
      this.z.ignitions++;
      consulted = true;                              // 调 System 2（昂贵深审 + 污染上下文）
      const trueCrit = step.crit;                    // System 2 看清真关键度（深度分析结论）
      // ★原型生长要有节制：只有当情形与最近原型都【不够像】(sim<mergeSim)才新建，
      // 否则合并进最近原型。意识是稀缺的：少量稳定图式，不是每步一个。
      const needNew = !proto || sim < this.mergeSim;
      if (needNew && this.canGrow) {
        activeProto = this._growProto(x, trueCrit);  // 自生新原型（自己写 skill）
      } else if (proto) {
        this._refine(proto, x, trueCrit);            // 合并/细化已有原型
        activeProto = proto;
      } else {
        activeProto = null;
      }
    }

    this.z.activeProto = this.protos.indexOf(activeProto);
    const theta = this._theta(activeProto);
    // 处理深度：点燃时用 System 2 看清的真关键度；否则用活跃原型(可能切换后)的仿射读出。
    const critForDepth = consulted ? step.crit
      : (activeProto ? activeProto.critEst(this._rfeat(x)) : critEst);
    const deep = critForDepth > theta;
    this.deepEwma = 0.97 * this.deepEwma + 0.03 * (deep ? 1 : 0);
    // loop 级：更新自我状态的上下文污染估计（点燃最毒，深处理次之，浅处理轻微）。
    this.z.pollution += (consulted ? 0.022 : 0) + (deep ? 0.010 : 0.002);
    return { deep, consulted };
  }

  _growProto(x, trueCrit) {
    // 原型携带仕射读出 critEst(rfeat)（带偏置，能表达 crit=1-dHint 等）+ 自身校准度 predErr。
    // 权重长度随签名维度动态确定(3维→len4 同历史;含动作维→更长)。先验:偏置小 + 信 crit 线索。
    const w = new Array(this._rfeat(x).length).fill(0); w[0] = 0.1; w[1] = 0.6;
    const proto = {
      protoFeat: x.slice(),
      policy: { theta: 0.6, muBias: 0 },
      w, n: 1, conf: 0.3, predErr: 0.5,   // predErr 高=该原型还不可靠
      critEst(rf) { let s = 0; for (let i = 0; i < this.w.length; i++) s += this.w[i] * rf[i]; return clamp01(s); },
    };
    this._sgd(proto, x, trueCrit);
    this.protos.push(proto);
    // 超上限淘汰:不是纯 LFU(只看使用频率 n)。纯 LFU 会先删"罕见但极关键"的原型
    //   (n 小但 critEst 高),正是最不该忘的。
    // ★保留优先级 retain = critEst(主导,∈[0,1]) + 0.1·n/(n+5)(次要使用项,≤0.1):
    //   关键度【主导】——高关键原型(critEst→1)retain 高,即使罕见(n 小)也受保护;
    //   只有在关键度相近时,使用频率才作次要加权(高频常用图式更值得留)。
    //   淘汰 retain 【最低】者 = 既罕见又不关键的真·边角废原型(该删的)。
    while (this.protos.length > this.maxProto) {
      const retain = (p) => p.critEst(this._rfeat(p.protoFeat)) + 0.1 * (p.n / (p.n + 5));
      let wi = 0; for (let i = 1; i < this.protos.length; i++) if (retain(this.protos[i]) < retain(this.protos[wi])) wi = i;
      this.protos.splice(wi, 1);
    }
    return proto;
  }

  _refine(proto, x, trueCrit) {
    // 质心向当前情形滑动（原型覆盖区扩张）+ 读出权重 SGD。
    for (let i = 0; i < proto.protoFeat.length; i++) proto.protoFeat[i] += 0.15 * (x[i] - proto.protoFeat[i]);
    this._sgd(proto, x, trueCrit);
    proto.n++;
    proto.conf = Math.min(1, proto.conf + 0.05);
  }

  _sgd(proto, x, trueCrit) {
    const rf = this._rfeat(x);
    const pred = proto.critEst(rf);
    const err = trueCrit - pred;
    for (let i = 0; i < proto.w.length; i++) proto.w[i] += this.lr * err * rf[i];
    proto.predErr = 0.85 * proto.predErr + 0.15 * Math.abs(err); // 校准度自监控
  }

  /**
   * loop 级反馈 = 竞争-协调的【稳定性条件】，调整影子价 μ（同 solveByCompetitionGame 的 ROB 调价）。
   *   • 任务失败 → 稳健机制索要更多算力 → μ 涨价（更爱点燃/更谨慎）。
   *     方向看 deepEwma：之前已深思很多还失败→是污染害的→反而降 μ(别再自毒)；深思不足→升 μ。
   *   • 任务成功 → 经济机制让价 → μ 轻降（省下点燃，逼近"恰好不破"的工作点）。
   * 不动点 = 两机制竞争协调出的折中价，与最早 EMMS / mesoscaleAllocator 同一机制。
   */
  feedback(success) {
    let step;
    if (success) step = -0.3;
    else step = this.deepEwma > 0.5 ? -1 : +1;
    this.mu = Math.max(0.3, Math.min(4, this.mu + this.muLr * step));
  }

  stats() { return { nProto: this.protos.length, mu: this.mu, ignitions: this.z.ignitions }; }

  // ─────────────────────────────────────────────────────────────────────────
  // ★真实落地接口（与仿真 decide() 同一机制，但情形签名/关键度来自真实可观测量）
  //
  // 仿真里 _feat 从 step.critHint 等合成线索取签名、点燃时用 step.crit 当免费 oracle；
  // 真实里【没有免费 oracle】：签名 x 来自题面可观测特征(测试数/题面长/stub长/历史档)，
  // 关键度只能【事后】用"这题真正需要的最低功率档"观测到（跑过真 pytest 才知道）。
  // 故把"决策"与"学习"显式拆成两拍：decideAbstract(决策时) → 真跑 → learnAbstract(事后)。
  //
  // 点燃(ignite) 在真实里 = 调用 System 2（强模型 best-of-N 深审）；不点燃 = System 1（单候选直写）。
  // 上下文污染 pollution 在真实里【就是真的】= 本会话累计 token 占窗比，由外部传入（非仿真单位）。
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 决策一拍 = 一次【竞争-协调均衡】(EMMS / solveByCompetitionGame 同构),不是分层 if-else 覆盖。
   *
   * 两个机制就"这步要不要点燃 System2"竞价,由影子价 μ 协调:
   *   稳健机制(ROB) 出价 robBid = μ·pCrit·missPenalty  ← 基础:漏判风险×谨慎影子价
   *                              + 安全约束的【障碍项】(见下)
   *   经济机制(ECO) 要价 ecoAsk = 固定深审 + 非关键步白深思 + 上下文污染惩罚
   *   裁决: robBid > ecoAsk ⟺ 点燃。两机制的不动点 = 折中工作点(同最早 EMMS)。
   *
   * 安全约束【进入同一个竞价】而非绕过它——这是约束进入经济均衡的标准做法:
   *   • 硬约束(不可逆 irreversible / 风险上界 pUpper≥criticalGate) = 障碍权重→∞ 的极限,
   *     使 robBid 必然压过 ecoAsk → 等价于"强制点燃",但仍是同一条竞价式。
   *   • 风险预算 = 绑定约束的影子价:剩余预算越紧,其影子价越高(连续抬升 robBid),耗尽→∞。
   *   • 变性探索期 = 稳健机制临时溢价(均衡里的不确定性溢价)。
   * 正常步(可行域内部)所有障碍项=0 → 退化为纯 ROB-vs-ECO 成本敏感竞价(复现已验证的省成本行为)。
   *
   * 另给出 verify 动作(与点燃决策正交的执行附件): 把"猜对没有"变成"检查过了"。
   *
   * @param {number[]} x         真实情形签名（前 3 维对齐 _rfeat 的 [crit,难,进度]）
   * @param {number}   pollution 当前真实上下文污染 ∈[0,1]（token 占窗比）
   * @param {object}   [ctx]     可选上下文: {riskClass:"normal"|"critical"|"irreversible", actionType:string}
   * @returns {{ignite,mode,verify,riskClass,robBid,ecoAsk,pMean,pUpper,...}}
   */
  decideAbstract(x, pollution = this.z.pollution, ctx = {}) {
    this.z.steps++;
    // ★改进2: 把动作类型并入情形签名 → 原型按动作分化(design_patch 自成高关键原型,不再被 critHint 牵着走)。
    //   不传 actionType → 动作维=[0,0] → xf 退化为旧 3 维签名 → 行为不变(零回归)。
    const xf = this._xFull(x, ctx);
    const actionVec = this._actionVec(ctx);
    const isMutating = actionVec[0] === 1;
    const actionPrior = actionVec[1];
    const { proto, sim } = this._match(xf);
    const surprise = 1 - sim;
    this.z.recentSurprise = 0.8 * this.z.recentSurprise + 0.2 * surprise;

    // ── 风险均值 pMean 与保守上界 pUpper(不再拿单个点估计直接当概率)──
    //   pMean  = 原型读出的关键风险(点估计);
    //   uncert = 原型不准(predErr)×陌生度(2-sim) → 越不确定越大;
    //   nEff   = 原型有效样本数(越少越不可信); 新/稀有/突变后原型 → 上界自动抬高,短期多用 System2。
    const pMean = proto ? proto.critEst(this._rfeat(xf)) : 0.5;
    const uncert = proto ? proto.predErr * (2 - sim) : 1.0;
    const nEff = proto ? proto.n : 0;
    const sampleInflate = this.kSample / Math.sqrt(1 + nEff);  // 小样本→大;样本多→趋0
    const pUpper = clamp01(pMean + this.kUpper * uncert * (1 - pMean) + sampleInflate);
    // pCrit 保留为"被不确定度上偏的关键概率"(驱动基础竞价),与 pUpper 同向。
    const pCrit = clamp01(pMean + 0.5 * uncert * (1 - pMean));

    // ── 残差式变性探测(比"只看相似度"更可靠):综合陌生度 + 验证失败率 + 关键度残差 EWMA ──
    const shiftScore = 0.4 * surprise + 0.35 * this.z.verifyFailEwma + 0.25 * Math.min(1, this.z.residualEwma * 2);
    const protoSwitch = this.canShift && proto && this.z.activeProto !== -1 &&
      proto !== this.protos[this.z.activeProto] && sim < 0.7;
    const regimeShift = protoSwitch || shiftScore > this.shiftTh;
    if (regimeShift && this.z.safeWindow <= 0) this.z.safeWindow = this.safeWindowLen; // 开启安全探索窗口

    // ── 风险类标签(供 verify 选型 + 审计):外部声明 irreversible 最高;否则 pUpper 超 criticalGate 视为 critical。
    const declaredClass = ctx.riskClass || "normal";
    const riskClass = declaredClass === "irreversible" ? "irreversible"
      : (declaredClass === "critical" || pUpper >= this.criticalGate) ? "critical" : "normal";
    const riskLoss = pUpper;  // 归一化漏判风险(用上界,保守)

    // ── 竞争-协调竞价(EMMS):稳健出价 robBid vs 经济要价 ecoAsk,由影子价 μ 协调 ──
    //   基础出价/要价 = 旧 eCostS1/eCostS2(保留已验证的成本敏感竞争,正常步只看它俩)。
    const robBase = this.mu * pCrit * this.missPenalty;            // 稳健基础出价:漏判风险×影子价μ
    const ecoAsk = this.consultCost * this.overThinkCost +        // 经济要价:深审+白深思+污染惩罚
                   (1 - pCrit) * this.overThinkCost +
                   this.polluteWeight * pollution * this.overThinkCost;
    // 安全约束作为【障碍项】加进稳健出价(硬约束=障碍权重→∞;绑定约束=影子价飙升):
    const barrierIrrev = declaredClass === "irreversible" ? this.hardBarrier : 0; // 不可逆:∞障碍
    const barrierCrit = riskClass === "critical" ? this.hardBarrier : 0;          // 关键上界:∞障碍
    //   风险预算影子价:剩余预算 slack 越紧出价越高(连续),耗尽(≤0)→∞。比"突变门"更像经济均衡。
    const slack = this.z.riskBudget;
    const budgetShadow = slack <= 0 ? this.hardBarrier
      : riskLoss * this.missPenalty * Math.max(0, 1 - slack / this.budgetSoft);
    const windowPremium = this.z.safeWindow > 0 ? this.hardBarrier : 0;           // 变性探索期:稳健溢价
    // ★改进1(语义溢价): 改动代码/状态类动作给稳健出价一个【与风险估计正交】的溢价(actionPrior 驱动),
    //   不论 critHint 多低/μ 多小都抬高 robBid。非∞(不强制点燃,允许 System1 起草),但叠加强制 test 兜底。
    const actionPremium = isMutating
      ? this.actionPremiumWeight * actionPrior * this.missPenalty : 0;
    // ── ★技能层(领域语义)三个竞价项: 经验复用折扣(降价) + 新颖溢价(涨价) + 跨仓库溢价(涨价) ──
    //   skill = {novelty, priorSuccess, repoMatch, verifiedSupport, hasReusableFix} 由 skillMemory.query 给出。
    //   全部接地于【真实验证结果】(priorSuccess 只由真测试通过的记录加权),不是上游提示词。
    const skill = ctx.skill || null;
    let skillReuseDiscount = 0, skillNoveltyPremium = 0, crossRepoPremium = 0;
    if (skill) {
      // 复用折扣: 有同仓库+真验证+高成功率的可复用修法 → 降 robBid(直接复用经验,省深思)。
      //   折扣 ∝ repoMatch · priorSuccess · 验证支持度饱和。只在确有可复用解时减价。
      if (skill.hasReusableFix && skill.verifiedSupport > 0) {
        const support = skill.verifiedSupport / (skill.verifiedSupport + 2); // 饱和到 (0,1)
        skillReuseDiscount = this.skillReuseWeight * (skill.repoMatch ?? 0) * (skill.priorSuccess ?? 0) * support * this.missPenalty;
      }
      // 新颖溢价: 语义陌生(novelty 高,没见过类似错误/堆栈) → 抬 robBid(谨慎探索)。
      //   ★优化: 按【后果】缩放(stakes = max(pCrit, actionPrior))。读 issue 等低后果步即便陌生也别浪费深思;
      //   只有"陌生【且】高后果"(没见过的改动/关键步)才付全额溢价。避免新颖溢价对只读步过度开火。
      const stakes = Math.max(pCrit, isMutating ? actionPrior : 0);
      skillNoveltyPremium = this.skillNoveltyWeight * clamp01(skill.novelty ?? 0) * stakes * this.missPenalty;
      // 跨仓库溢价: 有相似先例但 repoMatch 低(经验来自别的仓库) → 抬 robBid(仓库边界,别盲信跨域)。
      //   同样按后果缩放: 跨仓库经验只在高后果步才值得谨慎升级。
      const crossRepo = clamp01((skill.bestSim ?? 0) - (skill.repoMatch ?? 0)); // 相似但不同仓库的程度
      crossRepoPremium = this.crossRepoWeight * crossRepo * stakes * this.missPenalty;
    }
    const skillNet = skillNoveltyPremium + crossRepoPremium - skillReuseDiscount; // 净技能竞价调制
    const robBid = Math.max(0, robBase + barrierIrrev + barrierCrit + budgetShadow + windowPremium
      + actionPremium + skillNet);
    // 裁决:库空(无图式可竞价)直接点燃;否则稳健出价 > 经济要价 ⟺ 点燃。
    const ignite = this.protos.length === 0 || robBid > ecoAsk;
    const mode = ignite ? "system2" : "system1";
    // 决策依据 = 竞价里哪一项主导(供审计):障碍项主导=安全约束绑定;否则=纯成本敏感竞价。
    let reason;
    if (this.protos.length === 0) reason = "empty-library";
    else if (barrierIrrev > 0) reason = "irreversible-barrier";
    else if (barrierCrit > 0) reason = "critical-barrier";
    else if (slack <= 0) reason = "risk-budget-exhausted";
    else if (windowPremium > 0) reason = "safe-exploration-window";
    else if (budgetShadow > 0 && robBid > ecoAsk && robBase <= ecoAsk) reason = "risk-budget-pressure";
    else if (isMutating && robBid > ecoAsk && robBase + budgetShadow <= ecoAsk) reason = "mutating-action-premium";
    else if (skillReuseDiscount > 0 && !ignite) reason = "skill-reuse-discount";
    else if ((skillNoveltyPremium > 0 || crossRepoPremium > 0) && ignite && robBase <= ecoAsk) reason = "skill-novelty/cross-repo-premium";
    else reason = ignite ? "rob-bid>eco-ask" : "eco-ask>rob-bid";
    // 走便宜路(System1)且没挂验证器 → 从风险预算里扣这步的未验证风险上界。
    //   预算耗尽 = 累计未验证风险够多 → 影子价 budgetShadow 飙升压过经济要价。验证过的步不扣。
    this._pendingSpend = riskLoss;  // 实际是否扣由 learnAbstract 据真实路径/验证结果决定

    // ── verify 动作(与点燃决策正交): 高风险步强制验证;System1 但风险上界不低 → 挂便宜验证器 ──
    let verify = "none";
    if (riskClass === "irreversible") verify = "dry_run";       // 不可逆步: dry-run/审核
    else if (riskClass === "critical") verify = "test";          // 关键步: 跑测试
    // ★改进1(强制兜底)+ 按操作类型分派验证策略: 凡改动代码/状态的动作,不论被降成 System1,
    //   也【至少强制验证】——直接回应\"代码修改步骤不能仅靠风险估计降级\"。具体验证动作按动作类型分派
    //   (design_patch→review 评审; apply_patch/write_code/edit_file/refactor→test; delete/migrate_schema→dry_run;
    //    run_test→none 本身即验证)。未登记的改动动作回退到 test(保守)。
    else if (isMutating && this.forceVerifyMutating) {
      const a = ctx.actionType;
      verify = (a && a in this.actionVerifier) ? this.actionVerifier[a] : "test";
    }
    else if (mode === "system1" && pUpper >= this.verifyGate) verify = "lint"; // 普通但不放心: 便宜静态检查

    const theta = this._theta(proto);
    this.z.activeProto = proto ? this.protos.indexOf(proto) : -1;
    const predErr = proto ? proto.predErr : 1.0;
    return {
      ignite, mode, verify, riskClass, decisionReason: reason,
      critEst: pMean, theta, sim, surprise, predErr, mu: this.mu, protoIdx: this.z.activeProto,
      // 竞价量(均衡的核心):robBid=稳健总出价(含障碍), ecoAsk=经济要价, robBase=稳健基础出价。
      robBid, ecoAsk, robBase, budgetShadow,
      // 兼容旧图的等价别名:eCostS1=robBase, eCostS2=ecoAsk(正常步竞价就是这两者比较)。
      eCostS1: robBase, eCostS2: ecoAsk, robGain: robBid, ecoCost: ecoAsk,
      uncert, regimeShift, shiftScore, pollution, safeWindow: this.z.safeWindow,
      remainingRiskBudget: this.z.riskBudget,
      pCrit, pMean, pUpper, nEff,
      // ★动作语义(改进1+2): 改动类动作标志 + 先验关键度 + 语义溢价 + 强制验证与否(供审计/服务器调度)。
      isMutating, actionPrior, actionPremium,
      forcedVerify: (isMutating && this.forceVerifyMutating && verify !== "none" && riskClass === "normal"),
      // ★技能层(领域语义): 三个进竞价的技能项 + 可复用修法本体(供 agent 直接参考旧解)。
      skillReuseDiscount, skillNoveltyPremium, crossRepoPremium, skillNet,
      reusableFix: skill ? (skill.priorFix ?? null) : null,
    };
  }

  /**
   * 学习一拍：事后用观测到的真关键度 observedCrit 更新原型库（自生/细化 = 自己长 skill）。
   * ★真实落地与仿真的关键差异：仿真里点燃 System2 才免费看到真 crit，故只在点燃步学；
   * 真实里【每题都有真 pytest oracle】——升档阶梯本身就观测到了真关键度（省档过=易/要满力才过=难），
   * 故真实里【每题都学】：点燃(或库空)→自生新原型，否则→用真升档结果细化最近原型。
   * 这修掉了"点燃恒用满力→observedCrit 恒高→学不会易题"的偏置（点燃掩盖真关键度）。
   *
   * 同时维护分层调度的状态:
   *   • 关键度预测残差 → residualEwma(预测越来越不准 = 变性信号,喂给 shiftScore);
   *   • verifier 失败 → verifyFailEwma(行为层变性信号) + 消耗本步风险预算(漏判真发生→预算扣更多);
   *   • 安全探索窗口步数递减。
   * @param {number[]} x            情形签名（与决策同一个）
   * @param {number}   observedCrit 真关键度 ∈[0,1]
   * @param {boolean}  ignited      该步是否点燃（决定自生 vs 细化）
   * @param {object}   [fb]         可选事后反馈 {verifierPassed:boolean|null, missHappened:boolean}
   * @param {object}   [ctx]        与决策同一个上下文 {actionType} —— 让原型在动作维上也学到映射。
   */
  learnAbstract(x, observedCrit, ignited, fb = {}, ctx = {}) {
    // ★改进2: 学习时也带动作维(与 decideAbstract 的 xf 对齐),否则动作原型永远拿不到 SGD 梯度。
    const xf = this._xFull(x, ctx);
    const { proto, sim } = this._match(xf);
    // 预测残差(用决策前原型的读出) → 喂残差式变性探测器。
    const predBefore = proto ? proto.critEst(this._rfeat(xf)) : 0.5;
    const residual = Math.abs(observedCrit - predBefore);
    this.z.residualEwma = 0.8 * this.z.residualEwma + 0.2 * residual;
    // verifier 行为信号 + 风险预算消耗。
    if (fb.verifierPassed === false) this.z.verifyFailEwma = 0.7 * this.z.verifyFailEwma + 0.3;
    else if (fb.verifierPassed === true) this.z.verifyFailEwma = 0.7 * this.z.verifyFailEwma;
    // 风险预算是累计账本:只有"便宜处理(System1)且没被验证通过"的步才花预算(花掉它当时的风险上界);
    //   走 System2 或验证通过的步不花(风险已被深审/检查掉),还略微回补预算(信誉恢复)。
    const verified = fb.verifierPassed === true;
    const spent = this._pendingSpend ?? observedCrit;
    this._pendingSpend = null;
    if (!ignited && !verified) {
      this.z.riskBudget = Math.max(-1, this.z.riskBudget - spent);
      // 漏判真发生(便宜处理了其实关键的步) → 额外重扣,加速后续强制升级。
      const missHappened = fb.missHappened ?? (observedCrit > 0.6);
      if (missHappened) this.z.riskBudget -= 0.5;
    } else {
      this.z.riskBudget = Math.min(this.riskBudget0, this.z.riskBudget + 0.15); // 安全步缓慢回补
    }
    if (this.z.safeWindow > 0) this.z.safeWindow--;

    const needNew = !proto || sim < this.mergeSim;
    if (ignited) this.z.ignitions++;
    if ((ignited && needNew) || !proto) {
      if (this.canGrow) this._growProto(xf, observedCrit);
    } else {
      this._refine(proto, xf, observedCrit); // 非点燃也用真升档结果细化（真实每题有 oracle）
    }
  }

  /** 真实里由外部累加上下文污染（点燃最毒/深处理次之/浅处理轻微，与 decide() 同权重）。 */
  addPollution(consulted, deep) {
    this.z.pollution += (consulted ? 0.022 : 0) + (deep ? 0.010 : 0.002);
    this.deepEwma = 0.97 * this.deepEwma + 0.03 * (deep ? 1 : 0);
  }
}
