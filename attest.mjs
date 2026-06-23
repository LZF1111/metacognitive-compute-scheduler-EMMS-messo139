/**
 * attest.mjs —— 受信任执行器【密码学背书】(executor attestation)。
 *
 * ── 这一层要修的病(审核 P0,精确版)──
 *   旧"信任"只是检查 `verification = {source:"executor", exitCode:0}` —— 而 source/exitCode
 *   都是【调用方明文提供】的字段。任何 MCP 客户端只要在 report_outcome 里塞
 *   {"source":"executor","exit_code":0} 就能把一个【未真正跑过测试 / 测试其实失败】的修法
 *   伪造成 verified_support=1 + reusable_fix,污染后续路由。这不是\"信任来源\",是\"信任自报\"。
 *
 * ── 正确做法:只有持有【服务端密钥】的隔离执行器能产出可验证签名 ──
 *   1. 调度器(server)进程持有一个【仅服务端可见】的 attestation 密钥(env EMMS_ATTEST_SECRET,
 *      或进程启动时随机生成、绝不外发)。MCP 客户端【拿不到】这个密钥。
 *   2. 真正跑测试的【隔离执行器】(本进程内的 LocalExecutor,或带共享密钥的独立 sidecar)在测试
 *      跑完后,对【规范化的结果载荷】(source|exitCode|testCmd|commitHash|patchHash|nonce|ts)做
 *      HMAC-SHA256 签名 → attestation token。
 *   3. report_outcome 收到 verification 时,调度器用同一密钥【重算 HMAC 并常时间比较】:
 *        • 签名不匹配 → 拒绝(无法伪造,因为没有密钥)。
 *        • nonce 已用过 → 拒绝(防重放:别人截获一个真 token 反复刷)。
 *        • ts 超出新鲜窗口(默认 ±300s)→ 拒绝(防陈旧 token)。
 *      只有【三者全过】才授予 trusted=true。source/exitCode 不再是\"信任的理由\",签名才是。
 *
 * ── 威胁模型(明确边界)──
 *   • 防住: 远端/不可信 MCP 客户端伪造 {source:executor, exit_code:0}(没有密钥 → 签不出有效 token)。
 *   • 防住: 重放一个旧的真 token(nonce 一次性 + ts 窗口)。
 *   • 不防(且不主张防): 如果攻击者攻破了调度器进程本身、或拿到了密钥,则 attestation 失效——
 *     这与任何 HMAC 方案一致。生产部署应把执行器放进独立沙箱/容器,密钥经 KMS 注入,
 *     执行器只在【真实测试退出码】上签名(见 LocalExecutor.runAndAttest 的契约)。
 *   • 这【不是】远端 attestation/TEE 证明;它把"可伪造的自报"升级为"需密钥的签名+防重放",
 *     是单机/共享密钥部署下可落地的最小正确实现。真·分布式 attestation(执行器侧 TEE 签名 +
 *     调度器侧验证证书链)是明确的后续工作。
 */

import crypto from "node:crypto";

const ATTEST_VERSION = "v1";
const DEFAULT_FRESHNESS_MS = 300_000; // ±5 分钟新鲜窗口
const NONCE_TTL_MS = 600_000;         // 已用 nonce 至少保留 10 分钟(覆盖新鲜窗口)

/** 规范化要签名的载荷:固定字段、固定顺序、稳定序列化(防止字段重排绕过)。 */
export function canonicalPayload(v = {}) {
  const norm = {
    ver: ATTEST_VERSION,
    source: v.source ?? null,
    exitCode: (typeof v.exitCode === "number") ? v.exitCode
            : (typeof v.exit_code === "number") ? v.exit_code : null,
    testCmd: v.testCmd ?? v.test_cmd ?? null,
    commitHash: v.commitHash ?? v.commit_hash ?? null,
    patchHash: v.patchHash ?? v.patch_hash ?? null,
    nonce: v.nonce ?? null,
    ts: (typeof v.ts === "number") ? v.ts : null,
  };
  // 稳定 JSON(键已固定顺序),作为 HMAC 明文。
  return JSON.stringify(norm);
}

/** 用密钥对载荷算 HMAC-SHA256(hex)。密钥只在服务端/执行器之间共享。 */
export function signPayload(secret, v) {
  return crypto.createHmac("sha256", secret).update(canonicalPayload(v)).digest("hex");
}

/** 常时间比较两个 hex 签名(防时序侧信道)。 */
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch { return false; }
}

/**
 * Attestor —— 调度器侧持有密钥,签发&校验执行器背书。
 *
 * 用法(单机/共享密钥):
 *   const att = new Attestor(secret);                 // server 启动时创建(secret 来自 env 或随机)
 *   const exec = new LocalExecutor(att);              // 隔离执行器,绑定同一 attestor
 *   const v = exec.runAndAttest({exitCode, testCmd}); // 真实跑完测试 → 带签名的 verification
 *   att.verify(v) === true                            // report_outcome 里校验
 */
export class Attestor {
  /**
   * @param {string|Buffer} secret 共享密钥。缺省随机生成(进程内有效,重启失效——只对本进程签发的 token 有效)。
   * @param {object} opts {freshnessMs, trustedSources}
   */
  constructor(secret, opts = {}) {
    this.secret = secret || crypto.randomBytes(32).toString("hex");
    this.freshnessMs = opts.freshnessMs ?? DEFAULT_FRESHNESS_MS;
    this.trustedSources = opts.trustedSources ?? ["executor"];
    this._usedNonces = new Map(); // nonce -> expireAt(ms),一次性防重放
  }

  /** 由【执行器】调用:对真实测试结果签名,产出可外发的 verification(含 nonce/ts/sig)。 */
  issue(v = {}) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const ts = Date.now();
    const base = {
      source: v.source ?? "executor",
      exitCode: (typeof v.exitCode === "number") ? v.exitCode
              : (typeof v.exit_code === "number") ? v.exit_code : null,
      testCmd: v.testCmd ?? v.test_cmd ?? null,
      commitHash: v.commitHash ?? v.commit_hash ?? null,
      patchHash: v.patchHash ?? v.patch_hash ?? null,
      nonce, ts,
    };
    const sig = signPayload(this.secret, base);
    return { ...base, attestation: { ver: ATTEST_VERSION, sig } };
  }

  _gcNonces(now) {
    if (this._usedNonces.size < 4096) return;
    for (const [n, exp] of this._usedNonces) if (exp <= now) this._usedNonces.delete(n);
  }

  /**
   * 校验一条 verification 是否为【真·受信任执行器】签发且未重放。
   * @returns {{trusted:boolean, reason:string}}
   *   reason ∈ no-verification / bad-source / no-attestation / bad-signature / replayed-nonce / stale-timestamp / ok
   */
  verify(v) {
    if (!v || typeof v !== "object") return { trusted: false, reason: "no-verification" };
    const source = v.source ?? null;
    if (!this.trustedSources.includes(source)) return { trusted: false, reason: "bad-source" };
    const att = v.attestation;
    if (!att || typeof att.sig !== "string") return { trusted: false, reason: "no-attestation" };

    const now = Date.now();
    const ts = (typeof v.ts === "number") ? v.ts : NaN;
    if (!Number.isFinite(ts) || Math.abs(now - ts) > this.freshnessMs) {
      return { trusted: false, reason: "stale-timestamp" };
    }
    // ★关键:用服务端密钥重算签名并常时间比较。客户端没有密钥 → 伪造的 sig 必不匹配。
    const expect = signPayload(this.secret, v);
    if (!timingSafeEqualHex(att.sig, expect)) return { trusted: false, reason: "bad-signature" };

    // 防重放:nonce 一次性。
    const nonce = v.nonce ?? null;
    if (!nonce) return { trusted: false, reason: "bad-signature" };
    if (this._usedNonces.has(nonce)) return { trusted: false, reason: "replayed-nonce" };
    this._gcNonces(now);
    this._usedNonces.set(nonce, now + NONCE_TTL_MS);

    return { trusted: true, reason: "ok" };
  }
}

/**
 * LocalExecutor —— 进程内隔离执行器的【引用实现】。
 *   契约: caller 给出【真实测试退出码】(由 runAndAttest 的 runner 真跑得到),
 *   执行器只对这个真实结果签名。它持有 attestor(=密钥),所以能签;MCP 客户端不持有。
 *
 *   生产: 把它换成独立沙箱/容器里的 sidecar,经共享密钥(KMS 注入)签名;runner 真跑 pytest。
 *   这里给的是最小可跑实现,用于本仓库的本地复核与测试。
 */
export class LocalExecutor {
  constructor(attestor) {
    if (!(attestor instanceof Attestor)) throw new Error("LocalExecutor 需要一个 Attestor 实例(持有密钥)");
    this.attestor = attestor;
  }

  /**
   * 真跑一个 runner(返回 {exitCode})并对真实退出码签名。
   * @param {object} meta {testCmd, commitHash, patchHash, source}
   * @param {() => ({exitCode:number}) | number} runner 真实执行测试的函数(同步返回退出码或 {exitCode})。
   */
  runAndAttest(meta = {}, runner) {
    let exitCode = null;
    if (typeof runner === "function") {
      const r = runner();
      exitCode = (typeof r === "number") ? r : (r && typeof r.exitCode === "number" ? r.exitCode : null);
    } else if (typeof meta.exitCode === "number") {
      exitCode = meta.exitCode; // 已在外部真跑、把真实退出码交进来(执行器只背书真实结果)
    }
    return this.attestor.issue({
      source: meta.source ?? "executor",
      exitCode,
      testCmd: meta.testCmd ?? null,
      commitHash: meta.commitHash ?? null,
      patchHash: meta.patchHash ?? null,
    });
  }
}
