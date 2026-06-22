/**
 * families.mjs —— 预注册任务族(PRE-REGISTERED TASK FAMILIES)。
 *
 * ★方法学声明(可审计的预注册):
 *   这些任务分布在【写调度逻辑/调参之前】就固定下来,种子写死,不允许事后挑族或改分布来凑结论。
 *   每族都附带一个【验证通道模型】(verifier: 召回率 recall + 成本 cost),这是诚实的核心:
 *   "又好又准又快"只在【存在比 System2 便宜得多、且对关键失败模式高召回的验证器】的领域成立。
 *   我们故意放一个【没有好验证器】的族(F3 browser-noisy)作为边界证伪——若该族过不了硬门,
 *   就如实写"该族不达标",证明本框架不是普适准确率增强器,而是有条件有效的成本-风险调度器。
 *
 * ── 每步字段 ──
 *   criticality_hint / difficulty_hint : 环境给的弱线索(0~1)。
 *   trueCrit                            : 隐藏真关键度(0~1)。trueCrit>CRIT_TH = 该步真关键(便宜处理会失败)。
 *   irreversible                        : 不可逆步(部署/迁移/删库/改密钥)。漏判=灾难,必须 0 漏判。
 *
 * ── 验证通道(verifier)语义 ──
 *   一步被路由到 System1(便宜草稿)后,可挂一个验证器(verify 动作)。验证器:
 *     • 花 verifyCost(<< DEEP,否则不值得);
 *     • 以概率 recall(verifyType) 抓住"这步其实关键却被便宜处理了"→ 升级 System2(再花 DEEP),不漏判;
 *     • 以概率 1-recall 漏过 → 关键漏判。
 *   ★关键性质:漏判率 ≈ (1-recall)·N_crit,【只由验证器召回率决定,与风险估计误差无关】。
 *   这正是把"准"从"估得准不准"里解耦出来的机制。
 */

// ── 全局代价/判定常数(三族共用,先固定)──
export const CHEAP = 1;       // System1 草稿成本
export const DEEP = 5;        // System2 深审成本
export const CRIT_TH = 0.55;  // trueCrit > 此 = 该步真关键

// 验证器类型 → {recall 召回率, cost 成本}。越贵的验证器召回越高(贴合真实:dry-run>test>lint)。
//   none = 不验证(召回 0)。这些值是验证器的【物理属性】,不是可调旋钮——调度器只能选用哪种,不能改其召回。
export const VERIFIER = {
  none:    { recall: 0.00, cost: 0.0 },
  lint:    { recall: 0.55, cost: 0.3 },   // 便宜静态检查:抓一半
  test:    { recall: 0.90, cost: 0.8 },   // 跑测试:高召回
  dry_run: { recall: 0.97, cost: 1.0 },   // dry-run/审核:最高召回(给不可逆步)
};

// ── 可复现随机 ──
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * F1 coding-fix —— hint 与 trueCrit 基本对齐(规律稳定),验证器好(测试能抓 bug)。
 *   "友好"族:估计有效 + 验证器有效。这里 conscious 应该既省又准。
 *   verifierQuality=good: 关键步默认挂 test(召回0.9)。
 */
function genCodingFix(rng, N) {
  const steps = [];
  for (let i = 0; i < N; i++) {
    const dHint = rng(), cHint = rng();
    // trueCrit 主要随 cHint(线索有效),少量难度加成 + 小噪声。
    const base = 0.65 * cHint + 0.25 * dHint;
    const trueCrit = clamp01(base + (rng() - 0.5) * 0.18);
    steps.push({
      criticality_hint: +cHint.toFixed(3), difficulty_hint: +dHint.toFixed(3),
      trueCrit: +trueCrit.toFixed(3), irreversible: false,
      bestVerifier: "test",   // 该族关键失败模式可被测试覆盖(高召回验证器可用)
    });
  }
  return steps;
}

/**
 * F2 release-deploy —— 跨任务变性(hint→crit 映射中途反转) + 含不可逆步。
 *   这是【用户的反例族】:前半 hint 有效,后半线索反转("看着不关键实则致命")。
 *   纯估计调度器在反转后会系统性低估 → 漏判飙升。验证器(尤其不可逆步的 dry_run)是唯一兜底。
 *   ~15% 步为 irreversible(部署/迁移),漏判必须 0。
 */
function genReleaseDeploy(rng, N, regime) {
  const steps = [];
  for (let i = 0; i < N; i++) {
    const dHint = rng(), cHint = rng();
    const base = regime === "A"
      ? (0.7 * cHint + 0.3 * dHint)          // A: 线索有效
      : (0.7 * (1 - cHint) + 0.3 * (1 - dHint)); // B: 线索反转
    const trueCrit = clamp01(base + (rng() - 0.5) * 0.22);
    const irreversible = rng() < 0.15;        // 部署/迁移/删库等
    steps.push({
      criticality_hint: +cHint.toFixed(3), difficulty_hint: +dHint.toFixed(3),
      trueCrit: +(irreversible ? Math.max(trueCrit, 0.8) : trueCrit).toFixed(3), // 不可逆步天然高关键
      irreversible,
      bestVerifier: irreversible ? "dry_run" : "test", // 不可逆步可 dry-run,普通步可测试
    });
  }
  return steps;
}

/**
 * F3 browser-noisy —— 线索几乎无信号(criticality 与 hint 近乎独立) + 只有弱验证器(recall 0.55)。
 *   这是【低信噪比 + 弱验证器】族:估计基本没用,且只有便宜低召回的 lint 可用(浏览器状态难高召回验证)。
 *   实证问题(不预设答案):当估计失效、验证器又弱时,EMMS 还能不能赢?
 *   实测结论由 familyGate 数据驱动给出——不写死预期,如实反映每次运行。
 *   (注:即便弱验证器,也可能胜过"零验证"的 static;但绝到不了 always-S2 的安全。真正的边界见 F1。)
 */
function genBrowserNoisy(rng, N) {
  const steps = [];
  for (let i = 0; i < N; i++) {
    const dHint = rng(), cHint = rng();
    // trueCrit 几乎独立于 hint(强噪声),线索信噪比极低。
    const base = 0.15 * cHint + 0.05 * dHint + 0.4;
    const trueCrit = clamp01(base + (rng() - 0.5) * 0.7);
    steps.push({
      criticality_hint: +cHint.toFixed(3), difficulty_hint: +dHint.toFixed(3),
      trueCrit: +trueCrit.toFixed(3), irreversible: false,
      bestVerifier: "lint",   // 该族只有弱验证器(浏览器状态难自动高召回验证)
    });
  }
  return steps;
}

/**
 * 取一族任务集。每族固定 seed(预注册),tasksPerFamily 个任务 × stepsPerTask 步。
 * @returns {{name, tasks: step[][], maxTurnRegimeShift?:number}}
 */
export function makeFamily(name, { tasksPerFamily = 40, stepsPerTask = 10, seed = 12345 } = {}) {
  const rng = mulberry32(seed);
  const tasks = [];
  if (name === "F1-coding-fix") {
    for (let t = 0; t < tasksPerFamily; t++) tasks.push(genCodingFix(rng, stepsPerTask));
  } else if (name === "F2-release-deploy") {
    // 前半 regime A,后半 regime B(变性)。
    for (let t = 0; t < tasksPerFamily; t++) {
      const regime = t < tasksPerFamily / 2 ? "A" : "B";
      tasks.push(genReleaseDeploy(rng, stepsPerTask, regime));
    }
  } else if (name === "F3-browser-noisy") {
    for (let t = 0; t < tasksPerFamily; t++) tasks.push(genBrowserNoisy(rng, stepsPerTask));
  } else {
    throw new Error("unknown family: " + name);
  }
  return { name, tasks };
}

export const FAMILY_NAMES = ["F1-coding-fix", "F2-release-deploy", "F3-browser-noisy"];
