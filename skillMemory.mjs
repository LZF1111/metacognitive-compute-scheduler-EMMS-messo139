/**
 * skillMemory.mjs —— 技能层(Skill Memory):自进化【领域语义】记忆。
 *
 * ── 一条技能记录 = 一次被【受信任执行器】验证过的解决经验 ──
 *   {
 *     repo, branch, lang, fileType, actionType,  // 仓库/分支边界 + 操作类型(结构化,用于隔离)
 *     errorSignature,                            // 真实错误签名(决策时可见,脱敏后)
 *     stackFeatures: [token...],                 // 真实堆栈/符号特征(决策时可见)
 *     patchSummary,                              // 真实修法摘要(事后内容,脱敏后;绝不进检索向量)
 *     changeFootprint: {files,hunks,loc},        // 真实改动面
 *     verification: {                            // ★可信度来自【受信任测试执行器】,非 agent 自报
 *       source, exitCode, testCmd, commitHash, patchHash, trusted
 *     },
 *     verifierResult, outcome,                   // 仅描述性标签(不单独决定可信度)
 *     injectionFlag,                             // prompt-injection 嫌疑标记(命中→修法不外发)
 *     queryEmbed                                 // ★仅由【决策前可见字段】构建(error/stack),不含 patch
 *   }
 *
 * ── 接地纪律(本轮审核要点)──
 *   1. 检索向量只用【决策前可见】的错误/堆栈/仓库语义;patch 摘要【不进】检索向量(否则稀释错误匹配)。
 *   2. 成功置信度只由【受信任执行器(exitCode===0)】的记录贡献——agent 自报 outcome=1 不算数。
 *   3. 跨仓库经验【绝不】作为可直接复用的 reusable_fix 返回,只作为"参考案例/需人工审查"。
 *   4. 明文内容先脱敏 + 大小截断 + prompt-injection 标记;按 repo/branch 隔离检索。
 */

const EMBED_DIM = 64; // 本地 embedding 维度(固定;token 哈希进这个空间)
const MAX_ERR_LEN = 512;     // errorSignature 截断上限(防超大日志撑爆记忆)
const MAX_PATCH_LEN = 2000;  // patchSummary 截断上限
const MAX_STACK_TOK = 64;    // stackFeatures token 上限

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

// ── 脱敏:把常见机密模式替换为不可逆占位,避免明文 patch/错误里带出 token/密钥 ──
const SECRET_PATTERNS = [
  [/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/g, "[REDACTED_KEY]"],         // OpenAI/Stripe 风格
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GH_TOKEN]"],       // GitHub token
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],                  // AWS Access Key
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK]"],        // Slack token
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]"], // JWT
  [/(password|passwd|secret|api[_-]?key|token|authorization|bearer)\s*[:=]\s*\S+/gi, "$1=[REDACTED]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
];

function redact(s) {
  if (!s) return s;
  let out = String(s);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

// ── prompt-injection 嫌疑检测:命中则标记,修法摘要不再作为可复用解外发(只当参考/需审查)──
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(the\s+)?(system|previous)\s+(prompt|instructions)/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /system\s*prompt\s*[:=]/i,
  /<\/?(system|instructions?)>/i,
];

function looksInjected(...fields) {
  for (const f of fields) {
    if (!f) continue;
    const s = String(f);
    for (const re of INJECTION_PATTERNS) if (re.test(s)) return true;
  }
  return false;
}

/** 截断到上限(按字符)。 */
function truncStr(s, n) { s = s == null ? "" : String(s); return s.length > n ? s.slice(0, n) : s; }

/**
 * 本地 embedding:把一组文本字段的 token 哈希进 EMBED_DIM 维 + L2 归一化。
 * 完全来自真实文本,无外部模型。★用于检索的字段只能是【决策前可见】的(error/stack/repo 语义),不含 patch。
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

/**
 * 判定一条记录是否【受信任验证通过】。
 * ★安全铁律(P0 修复): 可信度只能由【服务端验证的来源 + 退出码】派生,绝不接受调用方自带的 trusted 标志。
 *   旧实现 `if (v.trusted === true) return true` 是一个可伪造后门:
 *   任何 MCP 客户端传 {source:"untrusted-client", exit_code:1, trusted:true} 就能把失败的修复
 *   伪造成 prior_success=1 / verified_support=1,并让它作为 reusable_fix 外发,污染后续路由。
 *   修复后: trusted 永远 = (source ∈ 白名单) ∧ (exitCode === 0),与客户端字段无关。
 */
function trustedPass(rec, trustedSources) {
  const v = rec.verification;
  if (!v) return false;
  return trustedSources.includes(v.source) && v.exitCode === 0;
}

export class SkillMemory {
  /**
   * @param {object} opts
   *   k             检索近邻数(默认 7)
   *   simStrong     "强先例"相似度阈(默认 0.6):≥此才计入 support
   *   maxRecords    库上限(默认 5000;满了淘汰最旧的"未受信验证"记录优先)
   *   trustedSources 受信任执行器来源白名单(默认 ["executor"])
   */
  constructor(opts = {}) {
    this.k = opts.k ?? 7;
    this.simStrong = opts.simStrong ?? 0.6;
    this.maxRecords = opts.maxRecords ?? 5000;
    this.trustedSources = opts.trustedSources ?? ["executor"];
    /** @type {Array<object>} */
    this.records = [];
  }

  size() { return this.records.length; }

  /** 检索向量 = 仅【决策前可见字段】(repo/lang/fileType/actionType/error/stack)。★不含 patchSummary。 */
  _queryEmbedOf(rec) {
    return localEmbed([
      rec.repo, rec.lang, rec.fileType, rec.actionType,
      rec.errorSignature,
      Array.isArray(rec.stackFeatures) ? rec.stackFeatures.join(" ") : rec.stackFeatures,
    ]);
  }

  /** 把 verification 规整为统一结构,并据【受信任来源 + exitCode===0】派生 trusted。 */
  _normVerification(v) {
    if (!v || typeof v !== "object") return { source: null, exitCode: null, testCmd: null, commitHash: null, patchHash: null, trusted: false };
    const source = v.source ?? null;
    const exitCode = (typeof v.exitCode === "number") ? v.exitCode : null;
    // ★安全铁律(P0 修复): trusted 只由【服务端校验的来源 + 退出码】派生,【绝不】接受调用方自带的 v.trusted。
    //   客户端传进来的 trusted 字段被显式丢弃,避免任意客户端把失败修复伪造成"已验证"污染路由。
    const trusted = this.trustedSources.includes(source) && exitCode === 0;
    return {
      source,
      exitCode,
      testCmd: v.testCmd ? truncStr(redact(v.testCmd), 256) : null,
      commitHash: v.commitHash ? truncStr(String(v.commitHash), 64) : null,
      patchHash: v.patchHash ? truncStr(String(v.patchHash), 64) : null,
      trusted,
    };
  }

  /**
   * 追加一条技能记录。可信度由 verification(受信任执行器)决定,不由 agent 自报 outcome 决定。
   * 写入前:脱敏 + 大小截断 + prompt-injection 标记。检索向量只用决策前可见字段。
   */
  add(rec) {
    const errorSignature = truncStr(redact(rec.errorSignature), MAX_ERR_LEN);
    const patchSummary = truncStr(redact(rec.patchSummary), MAX_PATCH_LEN);
    const stackFeatures = (Array.isArray(rec.stackFeatures) ? rec.stackFeatures : [])
      .slice(0, MAX_STACK_TOK).map((t) => truncStr(redact(t), 128));
    const verification = this._normVerification(rec.verification);
    const injectionFlag = looksInjected(rec.errorSignature, rec.patchSummary, ...(stackFeatures || []));
    const r = {
      repo: rec.repo ?? "", branch: rec.branch ?? "", lang: rec.lang ?? "", fileType: rec.fileType ?? "",
      actionType: rec.actionType ?? "",
      errorSignature,
      stackFeatures,
      changeFootprint: rec.changeFootprint ?? { files: 0, hunks: 0, loc: 0 },
      patchSummary,
      verification,
      verifierResult: rec.verifierResult ?? null,                       // 描述性标签
      outcome: rec.outcome != null ? (rec.outcome ? 1 : 0) : null,      // 描述性标签
      injectionFlag,
      ts: Date.now(),
    };
    r.queryEmbed = this._queryEmbedOf(r);
    this.records.push(r);
    if (this.records.length > this.maxRecords) this._evict();
    return this.records.length;
  }

  /** 淘汰:优先删最旧的【未受信验证】记录;保住被受信任执行器验证通过的成功经验。 */
  _evict() {
    let wi = 0, worst = Infinity;
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      const score = (trustedPass(r, this.trustedSources) ? 1e9 : 0) + r.ts; // 受信验证过的几乎不删
      if (score < worst) { worst = score; wi = i; }
    }
    this.records.splice(wi, 1);
  }

  /**
   * 检索:给【决策时可见】的查询,返回可复用技能信号。
   * ★仓库边界:reusable_fix(priorFix)只可能来自【同仓库 + 受信验证 + 强相似 + 非注入】的记录;
   *   跨仓库的相似经验绝不作为 reusable_fix,只放进 referenceCase(参考案例/需人工审查)。
   * @param {object} q {repo, branch, lang, fileType, actionType, errorSignature, stackFeatures}
   * @returns {{
   *   novelty, priorSuccess, support, verifiedSupport, repoMatch,
   *   priorFix,         同仓库可直接复用修法 | null
   *   referenceCase,    跨仓库参考案例 {repo, patchSummary, sim, note} | null(需人工审查,不可直接套用)
   *   bestSim, neighbors
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
               repoMatch: 0, priorFix: null, referenceCase: null, bestSim: 0, neighbors: [] };
    }
    const scored = this.records.map((r) => ({ r, sim: cosine(qEmbed, r.queryEmbed) }));
    scored.sort((a, b) => b.sim - a.sim);
    const top = scored.slice(0, this.k);
    const bestSim = top[0].sim;
    const novelty = clamp01(1 - bestSim);

    // 同仓库(+同分支若给定)判定:仓库/分支隔离。
    const sameContext = (r) => q.repo && r.repo === q.repo && (!q.branch || !r.branch || r.branch === q.branch);

    let wSum = 0, sSum = 0, verifiedSupport = 0, support = 0;
    let priorFix = null, priorFixSim = -1;                 // 仅同仓库 + 受信验证 + 非注入
    let refCase = null, refSim = -1;                       // 跨仓库受信验证(参考用)
    for (const { r, sim } of top) {
      if (sim >= this.simStrong) support++;
      const verified = trustedPass(r, this.trustedSources);   // ★只认受信任执行器
      if (r.verification && r.verification.source != null) {
        const w = Math.max(0, sim);
        wSum += w; sSum += w * (verified ? 1 : 0);
        if (sim >= this.simStrong && verified) verifiedSupport++;
      }
      if (!verified || !r.patchSummary || r.injectionFlag) continue; // 注入嫌疑/未受信 → 不外发修法
      if (sameContext(r)) {
        if (sim > priorFixSim) { priorFix = r.patchSummary; priorFixSim = sim; }
      } else if (sim > refSim) {
        refCase = { repo: r.repo, patchSummary: r.patchSummary, sim: +sim.toFixed(4),
                    note: "cross-repo reference — needs human review, do NOT apply blindly" };
        refSim = sim;
      }
    }
    const priorSuccess = wSum > 1e-9 ? clamp01(sSum / wSum) : 0.5;
    const repoMatch = sameContext(top[0].r) ? clamp01(bestSim) : 0;

    return {
      novelty, priorSuccess, support, verifiedSupport, repoMatch,
      // ★仓库边界铁律:reusable_fix 只在【同仓库 + 强相似】时给;否则一律 null。
      priorFix: priorFixSim >= this.simStrong ? priorFix : null,
      referenceCase: refSim >= this.simStrong ? refCase : null,
      bestSim, neighbors: top,
    };
  }

  /** 序列化(持久化技能库;不含派生的 queryEmbed,加载时重算)。 */
  toJSON() {
    return this.records.map((r) => ({
      repo: r.repo, branch: r.branch, lang: r.lang, fileType: r.fileType, actionType: r.actionType,
      errorSignature: r.errorSignature, stackFeatures: r.stackFeatures,
      changeFootprint: r.changeFootprint, patchSummary: r.patchSummary,
      verification: r.verification, verifierResult: r.verifierResult, outcome: r.outcome,
      injectionFlag: r.injectionFlag, ts: r.ts,
    }));
  }

  /** 从序列化数组重建(重算 queryEmbed,保证哈希一致)。 */
  static fromJSON(arr, opts = {}) {
    const m = new SkillMemory(opts);
    for (const rec of arr || []) m.add(rec);
    return m;
  }
}
