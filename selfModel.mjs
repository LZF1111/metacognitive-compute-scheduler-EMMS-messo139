/**
 * 自我模型 / 全局工作空间 —— selfModel.mjs
 *
 * 野心（用户原话）：比 skill 更优雅，能【替代 skill】；让直觉/记忆产生一种"意识"，
 * 这个意识在 agent loop 级别，把长程任务（无论复杂简单）处理得非常好，甚至超过预设 skill。
 *
 * ── "意识"在这里的严肃计算含义（不神秘化，诚实标注）──
 * 锚点：全局工作空间理论(GWT, Baars/Dehaene) + 注意力图式(AST, Graziano)。
 *   • 全局工作空间：一个被所有竞争机制共享的【自我状态 z】，平时用直觉(System 1)安静地跑；
 *   • 点燃(ignition)：当【惊讶】超阈值，全局广播 → 调动 System 2 重新审视 → 更新自我模型；
 *   • 自我建模：它持续维护"我现在处于哪种情形(regime)、进展如何、该用哪种模式"。
 * 这是【功能性】的自我建模+全局整合+惊讶驱动广播，不是现象学意识。下不主张后者。
 *
 * ── 为什么能替代 skill（结构性，不是调参）──
 * skill = 人预先写死的 (触发条件 → 固定步骤)，是【外部注入的静态文本、策略空间里的冻结点】。
 * 本架构 = 从经验自己长出的【原型库 prototypes】（= 自己长出的 skill）+ 连续策略：
 *   1. 泛化：新情形可由已有原型【内插/外推】，skill 只在预想情形命中。
 *   2. 自生：遇到没有原型能解释的情形 → 当场【新建原型】（自己写 skill）。
 *   3. 仲裁：多个原型竞争时由全局工作空间按相似度+置信【协调】，而非 skill 的硬触发误派发。
 *   4. ★中途变性(regime shift)：长程任务会变性，skill 一旦派发就锁死；自我模型靠【惊讶】
 *      当场察觉并切换原型——这正是 loop 级意识该发光处。
 *
 * 一个原型 = {protoFeat:情形质心, policy:{theta,muBias}, conf, n}。它就是"被压缩成直觉的 skill"。
 */
// (self-contained: no external imports)

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

/** 情形签名间的距离（高斯核相似度用）。 */
function dist2(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s; }

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
  /** 读出用特征（带偏置项 1，让原型能学仕射映射，如 regime B 的 crit=1-dHint）。 */
  _rfeat(x) { return [1, x[0], x[1], x[2]]; }

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
    const w = [0.1, 0.6, 0, 0]; // 先验：偏置小 + 信 crit 线索
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
   * @param {object}   [ctx]     可选上下文: {riskClass:"normal"|"critical"|"irreversible"}
   * @returns {{ignite,mode,verify,riskClass,robBid,ecoAsk,pMean,pUpper,...}}
   */
  decideAbstract(x, pollution = this.z.pollution, ctx = {}) {
    this.z.steps++;
    const { proto, sim } = this._match(x);
    const surprise = 1 - sim;
    this.z.recentSurprise = 0.8 * this.z.recentSurprise + 0.2 * surprise;

    // ── 风险均值 pMean 与保守上界 pUpper(不再拿单个点估计直接当概率)──
    //   pMean  = 原型读出的关键风险(点估计);
    //   uncert = 原型不准(predErr)×陌生度(2-sim) → 越不确定越大;
    //   nEff   = 原型有效样本数(越少越不可信); 新/稀有/突变后原型 → 上界自动抬高,短期多用 System2。
    const pMean = proto ? proto.critEst(this._rfeat(x)) : 0.5;
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
    const robBid = robBase + barrierIrrev + barrierCrit + budgetShadow + windowPremium;
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
    else reason = ignite ? "rob-bid>eco-ask" : "eco-ask>rob-bid";
    // 走便宜路(System1)且没挂验证器 → 从风险预算里扣这步的未验证风险上界。
    //   预算耗尽 = 累计未验证风险够多 → 影子价 budgetShadow 飙升压过经济要价。验证过的步不扣。
    this._pendingSpend = riskLoss;  // 实际是否扣由 learnAbstract 据真实路径/验证结果决定

    // ── verify 动作(与点燃决策正交): 高风险步强制验证;System1 但风险上界不低 → 挂便宜验证器 ──
    let verify = "none";
    if (riskClass === "irreversible") verify = "dry_run";       // 不可逆步: dry-run/审核
    else if (riskClass === "critical") verify = "test";          // 关键步: 跑测试
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
   */
  learnAbstract(x, observedCrit, ignited, fb = {}) {
    const { proto, sim } = this._match(x);
    // 预测残差(用决策前原型的读出) → 喂残差式变性探测器。
    const predBefore = proto ? proto.critEst(this._rfeat(x)) : 0.5;
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
      if (this.canGrow) this._growProto(x, observedCrit);
    } else {
      this._refine(proto, x, observedCrit); // 非点燃也用真升档结果细化（真实每题有 oracle）
    }
  }

  /** 真实里由外部累加上下文污染（点燃最毒/深处理次之/浅处理轻微，与 decide() 同权重）。 */
  addPollution(consulted, deep) {
    this.z.pollution += (consulted ? 0.022 : 0) + (deep ? 0.010 : 0.002);
    this.deepEwma = 0.97 * this.deepEwma + 0.03 * (deep ? 1 : 0);
  }
}
