/**
 * skillGateTest.mjs —— 技能层硬断言回归测试(固化"学到领域语义"的可证伪契约)。
 *
 * 不是看趋势,是对【机制本身】下硬断言。任一条不满足 → 非零退出(CI 可拦)。
 * 跑: node skillGateTest.mjs
 */
import { SkillMemory, localEmbed } from "./skillMemory.mjs";
import { SkillfulAgent } from "./skillfulAgent.mjs";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  [PASS] ${msg}`); pass++; }
  else { console.log(`  [FAIL] ${msg}`); fail++; }
}

console.log("=== 技能层硬断言 ===");

// ── A. localEmbed: 确定性 + L2 归一 + 语义相近文本相似度高 ──
{
  const a = localEmbed(["pytest", "ScopeMismatch fixture session"]);
  const b = localEmbed(["pytest", "ScopeMismatch fixture session"]);
  assert(JSON.stringify(a) === JSON.stringify(b), "localEmbed 确定性(同输入同输出)");
  let norm = 0; for (const v of a) norm += v * v;
  assert(Math.abs(Math.sqrt(norm) - 1) < 1e-9, "localEmbed L2 归一化");
  const c = localEmbed(["django", "NoReverseMatch url pattern"]);
  const dot = (u, v) => u.reduce((s, x, i) => s + x * v[i], 0);
  assert(dot(a, b) > dot(a, c), "语义相同文本相似度 > 不同文本");
}

// ── B. SkillMemory: priorSuccess 只由【真验证】记录加权;跨仓库 repoMatch 低 ──
{
  const m = new SkillMemory();
  // 同仓库 + 真验证通过 3 条
  for (let i = 0; i < 3; i++) m.add({
    repo: "pytest", lang: "python", fileType: "py", actionType: "design_patch",
    errorSignature: "ScopeMismatch fixture session function-scoped",
    stackFeatures: ["_pytest.fixtures", "resolve_fixture_function"],
    patchSummary: "降 fixture scope 到 function", verifierResult: "test_passed", outcome: 1,
  });
  const q = {
    repo: "pytest", lang: "python", fileType: "py", actionType: "design_patch",
    errorSignature: "ScopeMismatch fixture session function-scoped",
    stackFeatures: ["_pytest.fixtures", "resolve_fixture_function"],
  };
  const r = m.query(q);
  assert(r.priorSuccess > 0.8, `同仓库真验证旧解 → priorSuccess 高 (${r.priorSuccess.toFixed(2)})`);
  assert(r.verifiedSupport >= 1, `verifiedSupport ≥ 1 (${r.verifiedSupport})`);
  assert(r.priorFix != null, "返回可复用修法本体 priorFix");
  assert(r.repoMatch > 0, `同仓库 repoMatch > 0 (${r.repoMatch.toFixed(2)})`);

  // 跨仓库查同样的错误 → repoMatch 应为 0(仓库边界)
  const rCross = m.query({ ...q, repo: "flask" });
  assert(rCross.repoMatch === 0, "跨仓库查询 repoMatch = 0(仓库边界)");

  // 全失败记录不该贡献成功置信
  const m2 = new SkillMemory();
  for (let i = 0; i < 3; i++) m2.add({ ...q, patchSummary: "x", verifierResult: "test_failed", outcome: 0 });
  const r2 = m2.query(q);
  assert(r2.priorSuccess < 0.2, `全失败记录 → priorSuccess 低 (${r2.priorSuccess.toFixed(2)})`);
  assert(r2.priorFix == null, "全失败 → 无可复用修法(priorFix=null)");
}

// ── C. 淘汰: 验证通过的成功记录受保护 ──
{
  const m = new SkillMemory({ maxRecords: 3 });
  m.add({ repo: "r", actionType: "apply_patch", errorSignature: "keep me", patchSummary: "good", verifierResult: "test_passed", outcome: 1 });
  for (let i = 0; i < 5; i++) m.add({ repo: "r", actionType: "apply_patch", errorSignature: "junk " + i, verifierResult: "test_failed", outcome: 0 });
  const kept = m.toJSON().some((r) => r.errorSignature === "keep me");
  assert(kept, "满库淘汰: 真验证通过的成功记录存活(没被删)");
  assert(m.size() === 3, `库严格 ≤ maxRecords=3 (${m.size()})`);
}

// ── D. EMMS 竞价: 复用折扣降 robBid;新颖/跨仓库溢价抬 robBid;按后果缩放 ──
{
  const a = new SkillfulAgent({ mu0: 1.0 });
  // 先种一个原型(库空会强制点燃),用一个低关键只读步
  a.decideStep({ critHint: 0.2, dHint: 0.2, progress: 0.1, actionType: "read_issue", repo: "pytest", lang: "python", fileType: "py", errorSignature: "warm", stackFeatures: ["x"] });
  a.learnStep({ critHint: 0.2, dHint: 0.2, progress: 0.1, actionType: "read_issue", repo: "pytest" }, { observedCrit: 0.2, ignited: true });

  // 无技能信号的改动步
  const base = a.meta.decideAbstract([0.3, 0.3, 0.5], 0, { actionType: "design_patch" });
  // 有同仓库可复用已验证修法的同一步 → robBid 应更低(复用折扣)
  const reuse = a.meta.decideAbstract([0.3, 0.3, 0.5], 0, {
    actionType: "design_patch",
    skill: { novelty: 0.1, priorSuccess: 0.95, repoMatch: 0.9, verifiedSupport: 3, bestSim: 0.9, hasReusableFix: true },
  });
  assert(reuse.skillReuseDiscount > 0, "有可复用已验证旧解 → skillReuseDiscount > 0");
  assert(reuse.robBid < base.robBid, `复用折扣降低 robBid (${reuse.robBid.toFixed(1)} < ${base.robBid.toFixed(1)})`);

  // 高后果改动步 vs 低后果只读步, 同样 novelty=1 → 改动步溢价更大(按后果缩放)
  const novelMut = a.meta.decideAbstract([0.3, 0.3, 0.5], 0, {
    actionType: "design_patch", skill: { novelty: 1, priorSuccess: 0.5, repoMatch: 0, verifiedSupport: 0, bestSim: 0.2, hasReusableFix: false },
  });
  const novelRead = a.meta.decideAbstract([0.3, 0.3, 0.5], 0, {
    actionType: "read_issue", skill: { novelty: 1, priorSuccess: 0.5, repoMatch: 0, verifiedSupport: 0, bestSim: 0.2, hasReusableFix: false },
  });
  assert(novelMut.skillNoveltyPremium > novelRead.skillNoveltyPremium,
    `新颖溢价按后果缩放: 改动步(${novelMut.skillNoveltyPremium.toFixed(2)}) > 只读步(${novelRead.skillNoveltyPremium.toFixed(2)})`);
}

// ── E. 零回归: 不传 skill/actionType → decideAbstract 行为与无技能项一致 ──
{
  const a = new SkillfulAgent({ mu0: 1.0 });
  const d = a.meta.decideAbstract([0.5, 0.5, 0.5]); // 空库 → 点燃
  assert(d.skillNet === 0 || d.skillNet == null ? true : d.skillNet === 0, "不传 skill → skillNet 不影响竞价(=0)");
  assert(d.reusableFix == null, "不传 skill → reusableFix=null");
}

console.log(`\n${fail === 0 ? "✓ 全部" : "✗ 有失败:"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
