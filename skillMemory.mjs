/**
 * skillMemory.mjs —— 技能层(Skill Memory):自进化【领域语义】记忆。
 *
 * ── 为什么要它(用户质疑)──
 *   原 selfModel 进化的是元认知调度策略(该不该深思),caseMemory 只存抽象特征向量+成功率,
 *   两者都【学不到领域 know-how】(pytest 这个 bug 怎么修、这个 repo 的边界、这类报错的套路)。
 *   skillMemory 存【真实语义内容】并可复用——这才是"学到特别的东西"。
 *
 * ── 一条技能记录 = 一次被真实验证过的解决经验 ──
 *   {
 *     repo, lang, fileType, actionType,        // 仓库边界 + 操作类型(结构化)
 *     errorSignature,                           // 真实错误签名(报错文本/异常类型)
 *     stackFeatures: [token...],                // 真实堆栈/符号特征(函数名/文件名/异常)
 *     changeFootprint: {files,hunks,loc},       // 真实改动面(规模)
 *     patchSummary,                             // 真实修法摘要(可复用的"skill"本体)
 *     verifierResult,                           // ★真实验证结果(test_passed/test_failed/...)
 *     outcome,                                  // 1 成功 / 0 失败(由真实测试判定)
 *     embed                                     // 本地 embedding(token 哈希,不调付费模型)
 *   }
 *
 * ── 接地纪律(不退回"只信上游 hint")──
 *   • priorSuccess 只由【真实验证器通过的记录】加权——经验的可信度来自真测试,不是提示词。
 *   • 检索相似度基于【真实错误/堆栈/补丁文本】的本地 embedding——语义来自真实代码内容。
 *   • 跨仓库(repo 不匹配)会降低支持度并触发稳健溢价(仓库边界=不可盲信跨域经验)。
 *   • 不含本步结果(无泄漏):errorSignature/stack 是决策时可见的(报错先于修复)。
 */

const EMBED_DIM = 64; // 本地 embedding 维度(固定;token 哈希进这个空间)

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : (Number.isFinite(x) ? x : 0); }

/** 把任意字符串切成 token(小写、按非字母数字/下划线/点 分隔,保留 . 以抓住 a.b.c 符号路径)。 */
function tokenize(s) {
  if (!s) return [];
  return String(s).toLowerCase().split(/[^a-z0-9_.]+/).filter((t) => t.length > 1);
}

/** 确定性字符串哈希(FNV-1a 变体)→ 非负整数。 */
function hashTok(t) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/**
 * 本地 embedding:把一组文本字段的 token 哈希进 EMBED_DIM 维 + L2 归一化。
 * 这是"代码语义"的接地表示——完全来自真实文本(错误/堆栈/补丁/仓库/符号),无外部模型。
 */
export function localEmbed(fields) {
  const v = new Float64Array(EMBED_DIM);
  for (const f of fields) {
    for (const t of tokenize(f)) {
      const h = hashTok(t);
      const idx = h % EMBED_DIM;
      const sign = (h & 1) ? 1 : -1; // 符号哈希,降低碰撞偏置
      v[idx] += sign;
    }
  }
  let norm = 0; for (let i = 0; i < EMBED_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(EMBED_DIM); for (let i = 0; i < EMBED_DIM; i++) out[i] = v[i] / norm;
  return out;
}

function cosine(a, b) {
  let dot = 0; const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) dot += a[i] * b[i];
  return dot; // 两者已 L2 归一化 → 点积即余弦
}

export class SkillMemory {
  /**
   * @param {object} opts
   *   k             检索近邻数(默认 7)
   *   simStrong     "强先例"相似度阈(默认 0.6):≥此才计入 support
   *   maxRecords    库上限(默认 5000;满了淘汰最旧的失败记录优先)
   */
  constructor(opts = {}) {
    this.k = opts.k ?? 7;
    this.simStrong = opts.simStrong ?? 0.6;
    this.maxRecords = opts.maxRecords ?? 5000;
    /** @type {Array<object>} */
    this.records = [];
  }

  size() { return this.records.length; }

  /** 为一条记录构建语义 embedding(仓库+符号+错误+补丁摘要+操作类型)。 */
  _embedOf(rec) {
    return localEmbed([
      rec.repo, rec.lang, rec.fileType, rec.actionType,
      rec.errorSignature,
      Array.isArray(rec.stackFeatures) ? rec.stackFeatures.join(" ") : rec.stackFeatures,
      rec.patchSummary,
    ]);
  }

  /**
   * 追加一条【已被真实验证】的技能记录。outcome/verifierResult 来自真测试,不是估计。
   * 决策时不可见的字段(patchSummary/outcome/verifierResult)只在这里写入,query 不泄漏它们做相似度。
   */
  add(rec) {
    const r = {
      repo: rec.repo ?? "", lang: rec.lang ?? "", fileType: rec.fileType ?? "",
      actionType: rec.actionType ?? "",
      errorSignature: rec.errorSignature ?? "",
      stackFeatures: rec.stackFeatures ?? [],
      changeFootprint: rec.changeFootprint ?? { files: 0, hunks: 0, loc: 0 },
      patchSummary: rec.patchSummary ?? "",
      verifierResult: rec.verifierResult ?? null,   // 真实验证结果
      outcome: rec.outcome != null ? (rec.outcome ? 1 : 0) : null,
      ts: Date.now(),
    };
    r.embed = this._embedOf(r);
    this.records.push(r);
    if (this.records.length > this.maxRecords) this._evict();
    return this.records.length;
  }

  /** 淘汰:优先删最旧的"未验证或失败"记录;保住被真实验证通过的成功经验。 */
  _evict() {
    let wi = 0, worst = Infinity;
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      // 保留分:验证通过的成功记录最高;失败/未验证的旧记录最低。
      const verified = r.verifierResult === "test_passed" || r.outcome === 1;
      const score = (verified ? 1e9 : 0) + r.ts; // 验证过的几乎不删;否则按时间(旧的先删)
      if (score < worst) { worst = score; wi = i; }
    }
    this.records.splice(wi, 1);
  }

  /**
   * 检索:给【决策时可见】的查询(报错/堆栈/仓库/操作类型),返回可复用技能信号。
   * @param {object} q {repo, lang, fileType, actionType, errorSignature, stackFeatures}
   * @returns {{
   *   novelty,          与最近邻不相似度 [0,1](没见过→1)
   *   priorSuccess,     相似度×【真实验证】加权成功率 [0,1](强先例→趋 1/0)
   *   support,          强近邻数(sim≥simStrong)
   *   verifiedSupport,  其中被真实验证通过的近邻数(经验可信度)
   *   repoMatch,        最强近邻是否同仓库(仓库边界信号)[0,1]
   *   priorFix,         最佳【已验证】近邻的修法摘要(可复用的 skill 本体)| null
   *   bestSim,          最高相似度
   *   neighbors         top-k 近邻(含 sim)
   * }}
   */
  query(q) {
    const qEmbed = localEmbed([
      q.repo, q.lang, q.fileType, q.actionType,
      q.errorSignature,
      Array.isArray(q.stackFeatures) ? q.stackFeatures.join(" ") : q.stackFeatures,
    ]);
    if (this.records.length === 0) {
      return { novelty: 1, priorSuccess: 0.5, support: 0, verifiedSupport: 0,
               repoMatch: 0, priorFix: null, bestSim: 0, neighbors: [] };
    }
    const scored = this.records.map((r) => ({ r, sim: cosine(qEmbed, r.embed) }));
    scored.sort((a, b) => b.sim - a.sim);
    const top = scored.slice(0, this.k);
    const bestSim = top[0].sim;
    const novelty = clamp01(1 - bestSim);

    // ★真实验证加权成功率:只有【被真测试验证过】的记录才贡献置信,且按相似度加权。
    let wSum = 0, sSum = 0, verifiedSupport = 0, support = 0;
    let priorFix = null, priorFixSim = -1;
    for (const { r, sim } of top) {
      if (sim >= this.simStrong) support++;
      const verified = r.verifierResult === "test_passed" || r.outcome === 1;
      const isVerifiedRecord = r.verifierResult != null || r.outcome != null;
      if (isVerifiedRecord) {
        const w = Math.max(0, sim);
        wSum += w; sSum += w * (verified ? 1 : 0);
        if (sim >= this.simStrong && verified) verifiedSupport++;
      }
      // 可复用 skill 本体:取相似度最高且【验证通过】的修法摘要。
      if (verified && r.patchSummary && sim > priorFixSim) { priorFix = r.patchSummary; priorFixSim = sim; }
    }
    const priorSuccess = wSum > 1e-9 ? clamp01(sSum / wSum) : 0.5;
    // 仓库边界:最强近邻是否同仓库(同仓库经验更可信;跨仓库要打折/触发稳健溢价)。
    const repoMatch = (q.repo && top[0].r.repo === q.repo) ? clamp01(bestSim) : 0;

    return { novelty, priorSuccess, support, verifiedSupport, repoMatch,
             priorFix: priorFixSim >= this.simStrong ? priorFix : null,
             bestSim, neighbors: top };
  }

  /** 序列化(持久化技能库:跨进程/跨会话复用学到的领域经验)。 */
  toJSON() {
    return this.records.map((r) => ({
      repo: r.repo, lang: r.lang, fileType: r.fileType, actionType: r.actionType,
      errorSignature: r.errorSignature, stackFeatures: r.stackFeatures,
      changeFootprint: r.changeFootprint, patchSummary: r.patchSummary,
      verifierResult: r.verifierResult, outcome: r.outcome, ts: r.ts,
    }));
  }

  /** 从序列化数组重建(重算 embedding,保证哈希一致)。 */
  static fromJSON(arr, opts = {}) {
    const m = new SkillMemory(opts);
    for (const rec of arr || []) m.add(rec);
    return m;
  }
}
