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
// (self-contained: removed unused makeRng import from simEnv.mjs)

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
    this.igniteTh = opts.igniteTh ?? 0.45;  // 点燃阈值（惊讶超过则调 System 2）
    this.simTau = opts.simTau ?? 0.35;       // 相似度核宽（太小→原型永不匹配→记忆失效；放宽让相似情形能认出）
    this.mergeSim = opts.mergeSim ?? 0.6;    // ★合并阈值：新情形与最近原型相似度>此→合并而非新建(防膨胀)
    this.maxProto = opts.maxProto ?? 12;     // ★原型库上限（意识是稀缺的：少量稳定图式，满了淘汰最弱）
    this.lr = opts.lr ?? 0.12;
    this.mu = opts.mu0 ?? 1.0;        // 全局谨慎度 = 风险的影子价（竞争-协调的协调变量）
    this.muLr = opts.muLr ?? 0.10;
    this.consultCost = opts.consultCost ?? 0.10;   // 经济机制：一次点燃的固定代价
    this.polluteWeight = opts.polluteWeight ?? 0.6; // 经济机制：当前上下文污染对"再点燃"的抑制权重
    this.deepEwma = 0.5;
    this.canGrow = opts.canGrow ?? true;     // 能否自生原型（关掉=只能用已有=类 skill 库）
    this.canShift = opts.canShift ?? true;   // 能否中途切换活跃原型（关掉=锁死，模拟 skill 派发）
    // 自我状态 z（loop 级，被全局广播）。pollution = 本任务已累积的上下文污染(agent 自估)。
    this.z = { activeProto: -1, recentSurprise: 0.5, steps: 0, ignitions: 0, pollution: 0 };
  }

  /** 新任务开始：重置 loop 级自我状态（上下文清空）。原型库与 μ 跨任务保留。 */
  newTask() { this.z.pollution = 0; this.z.activeProto = -1; this.z.recentSurprise = 0.5; }

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
    // ★超上限：淘汰使用最少(n 最小)的原型（LFU），保持意识稀缺且稳定。
    if (this.protos.length > this.maxProto) {
      let wi = 0; for (let i = 1; i < this.protos.length; i++) if (this.protos[i].n < this.protos[wi].n) wi = i;
      if (this.protos[wi] !== proto) this.protos.splice(wi, 1);
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
   * 决策一拍：给定真实情形签名 x（长度 ≥3，[crit线索,难度线索,进度...] 同构）+ 当前真实上下文污染，
   * 用与 decide() 完全相同的【竞争-协调竞价】裁决是否点燃 System 2，并给出关键度估计。
   * @param {number[]} x         真实情形签名（前 3 维对齐 _rfeat 的 [crit,难,进度]）
   * @param {number}   pollution 当前真实上下文污染 ∈[0,1]（token 占窗比）
   * @returns {{ignite:boolean, critEst:number, theta:number, sim:number, surprise:number, protoIdx:number}}
   */
  decideAbstract(x, pollution = this.z.pollution) {
    this.z.steps++;
    const { proto, sim } = this._match(x);
    const surprise = 1 - sim;
    this.z.recentSurprise = 0.8 * this.z.recentSurprise + 0.2 * surprise;

    // ── 点燃判定 = 经济(eco) vs 稳健(rob) 显式竞价（与 decide() 一字不差的机制）──
    const critEst = proto ? proto.critEst(this._rfeat(x)) : 0.5;
    const uncert = proto ? proto.predErr * (2 - sim) : 1.0;
    const robGain = this.mu * (0.5 + critEst) * uncert;
    const ecoCost = this.consultCost + this.polluteWeight * pollution;
    const regimeShift = this.canShift && proto && this.z.activeProto !== -1 &&
      proto !== this.protos[this.z.activeProto] && sim < 0.7;
    const ignite = this.protos.length === 0 || robGain > ecoCost || regimeShift;

    const theta = this._theta(proto);
    this.z.activeProto = proto ? this.protos.indexOf(proto) : -1;
    const predErr = proto ? proto.predErr : 1.0;
    // ★透出 EMMS 竞争-协调的【原始竞价量】，供论文画"竞价裁决+μ影子价收敛"图：
    //   robGain = 稳健机制(System2)出价；ecoCost = 经济机制(System1)要价；
    //   μ = 协调两者的影子价；ignite = robGain>ecoCost 的裁决结果。
    return {
      ignite, critEst, theta, sim, surprise, predErr, mu: this.mu, protoIdx: this.z.activeProto,
      robGain, ecoCost, uncert, regimeShift, pollution,
    };
  }

  /**
   * 学习一拍：事后用观测到的真关键度 observedCrit 更新原型库（自生/细化 = 自己长 skill）。
   * ★真实落地与仿真的关键差异：仿真里点燃 System2 才免费看到真 crit，故只在点燃步学；
   * 真实里【每题都有真 pytest oracle】——升档阶梯本身就观测到了真关键度（省档过=易/要满力才过=难），
   * 故真实里【每题都学】：点燃(或库空)→自生新原型，否则→用真升档结果细化最近原型。
   * 这修掉了"点燃恒用满力→observedCrit 恒高→学不会易题"的偏置（点燃掩盖真关键度）。
   * @param {number[]} x           情形签名（与决策同一个）
   * @param {number}   observedCrit 真关键度 ∈[0,1]（真实里=实际需要的最低功率档/最高档归一化）
   * @param {boolean}  ignited      该步是否点燃（决定自生 vs 细化）
   */
  learnAbstract(x, observedCrit, ignited) {
    const { proto, sim } = this._match(x);
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
