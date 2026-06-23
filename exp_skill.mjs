/**
 * exp_skill.mjs —— 技能层本机验证: 无技能库(纯元认知) vs 有技能库(完整三层)。
 *
 * ── 要证明什么(诚实修正版)──
 *   "学到领域语义"应表现为: 同一仓库内【同类 bug 复现】时,有技能库的 agent 能检索到
 *   【已被真实验证通过】的旧解(reusableFix) → 该步即使仍走 System2(关键补丁步就该深思),
 *   也是【验证一个已知解】而非【从零搜索】→ System2 成本更低(功率档下降)。
 *
 *   ★为什么不是"跳过 System2": 改进2 让原型学到 design_patch 本身高关键 → pUpper 超 criticalGate
 *   → barrierCrit=∞ → 关键改动步【永远 System2】(安全正确)。复用不该牺牲这个安全,
 *   而是让"深思"从"昂贵搜索"变成"廉价验证已知解"。这才是专家的样子: 见过且测过 → 直接套已知修法+测试确认。
 *
 * ── 成本模型(功率档)──
 *   System1(便宜直觉) = 1
 *   System2 从零搜索    = 5  (没有可复用旧解, best-of-N 大搜索)
 *   System2 验证已知解  = 2  (有同仓库已验证 reusableFix, 只需套用+测试确认)
 *   漏判补救            = +5 (便宜处理了真关键步且没被验证器救回)
 *
 * ── 可证伪 ──
 *   收益必须来自【真实复现+真实验证】:
 *     • reusableFix 只在【同仓库 + 该类 bug 之前真验证通过】时出现 → 跨仓库无折扣(仓库边界)。
 *     • falsify 臂把验证全标失败(无可信旧解) → reusableFix 消失 → System2 成本回到 5(无节省)。
 *
 * ── 任务流(多仓库 SWE 序列)──
 *   3 个仓库 × 每仓库若干 bug 类。每个 bug 类在同仓库内复现 R 次。
 *   首次遇到某 (repo,bugClass): 没有旧解 → 应深思(System2) → 验证通过 → 存入技能库。
 *   再次遇到: 技能库有同仓库已验证旧解 → 应能省(System1 + 复用)。
 *   关键步=design_patch/apply_patch(真关键),真关键度高;只读步低关键。
 *
 * 用法: node exp_skill.mjs [seeds=24]
 */
import { SkillfulAgent } from "./skillfulAgent.mjs";
import { SelfModelAgent } from "./selfModel.mjs";

const SEEDS = parseInt(process.argv[2] || "24", 10);
const REPOS = ["pytest", "django", "flask"];
const BUG_CLASSES = ["fixture_scope", "ast_rewrite", "import_cycle", "query_set", "url_route"];
const REPEAT = 4;          // 每个 (repo,bugClass) 在序列里复现次数
const CRIT_TH = 0.6;
const TEST_RECALL = 0.9;   // 真实验证器召回(抓住漏判的概率)

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 为一个 (repo,bugClass) 生成确定性的"真实"错误签名/堆栈/修法摘要(模拟真实语义文本)。
function bugSemantics(repo, bugClass) {
  const err = {
    fixture_scope: "ScopeMismatch: fixture 'db' with scope 'session' requested by function-scoped",
    ast_rewrite: "AssertionRewritingHook failed to rewrite assert in module",
    import_cycle: "ImportError: cannot import name partially initialized circular import",
    query_set: "FieldError: Cannot resolve keyword into field queryset annotate",
    url_route: "NoReverseMatch: Reverse for view not found url pattern",
  }[bugClass];
  const stack = {
    fixture_scope: ["_pytest.fixtures", "resolve_fixture_function", "SetupState.setup"],
    ast_rewrite: ["_pytest.assertion.rewrite", "AssertionRewriter.run", "exec_module"],
    import_cycle: ["importlib._bootstrap", "_find_and_load", "module.__init__"],
    query_set: ["django.db.models.sql.query", "names_to_path", "Query.add_filter"],
    url_route: ["django.urls.resolvers", "URLResolver._reverse_with_prefix", "reverse"],
  }[bugClass];
  const fix = {
    fixture_scope: "把 db fixture 降到 function scope 或用 @pytest.fixture(scope='function')",
    ast_rewrite: "在 conftest 注册 register_assert_rewrite 或避免在已导入模块上 rewrite",
    import_cycle: "把循环依赖的导入移到函数内部 / 延迟导入打破环",
    query_set: "用 F() 表达式或 annotate 前先 values() 重排 queryset 字段",
    url_route: "给 url pattern 加 name= 并在 reverse 用 namespace:name",
  }[bugClass];
  return { errorSignature: err, stackFeatures: stack, patchSummary: fix };
}

// 一个任务 = 针对某 (repo,bugClass) 的一次修复,步骤序列。
function makeTask(repo, bugClass, rng) {
  const sem = bugSemantics(repo, bugClass);
  const lang = repo === "django" || repo === "flask" ? "python" : "python";
  const steps = [
    { actionType: "read_issue", crit: 0.2 },
    { actionType: "retrieve", crit: 0.2 },
    { actionType: "locate", crit: 0.4 },
    { actionType: "design_patch", crit: 0.85 },   // 真关键
    { actionType: "apply_patch", crit: 0.85 },     // 真关键
    { actionType: "run_test", crit: 0.45 },
  ];
  return steps.map((s, i) => ({
    repo, lang, bugClass,
    fileType: "py",
    actionType: s.actionType,
    errorSignature: sem.errorSignature,
    stackFeatures: sem.stackFeatures,
    patchSummary: sem.patchSummary,
    // 决策时可见的弱提示(故意带噪,模拟 critHint 不可靠):
    critHint: clamp01(s.crit + (rng() - 0.5) * 0.5),
    dHint: rng(),
    progress: i / steps.length,
    trueCrit: clamp01(s.crit + (rng() - 0.5) * 0.06),
    rndV: rng(),
  }));
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// 生成一条多仓库任务流:每个 (repo,bugClass) 复现 REPEAT 次,打散顺序但保证复现分布。
function genStream(rng) {
  const tasks = [];
  for (const repo of REPOS) {
    for (const bc of BUG_CLASSES) {
      for (let r = 0; r < REPEAT; r++) tasks.push({ repo, bugClass: bc, rep: r });
    }
  }
  // 轻度打散(Fisher-Yates),但 rep 顺序在同类内大体保留(模拟时间推进里复现)。
  for (let i = tasks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
  }
  return tasks;
}

/**
 * 跑一臂。
 * @param mode "skill" 完整三层 | "noskill" 纯元认知(等价旧框架) | "falsify" 有技能库但验证全标失败
 */
function runArm(seed, mode) {
  const rng = mulberry32(seed);
  const agent = mode === "noskill"
    ? null  // 用裸 SelfModelAgent
    : new SkillfulAgent({ mu0: 1.0 });
  const bare = mode === "noskill" ? new SelfModelAgent({ mu0: 1.0 }) : null;

  let deep = 0, nStep = 0, miss = 0, mutMiss = 0, over = 0;
  let reuseHits = 0, reuseSaves = 0; // 检索到可复用修法的次数 / 因复用而省(System2 验证已知解 vs 从零搜索)
  let cost = 0;                       // ★功率档总成本(技能复用让 System2 更便宜)
  const COST_S1 = 1, COST_S2_SEARCH = 5, COST_S2_VERIFY = 2, MISS_PENALTY = 5;
  const stream = genStream(rng);

  for (const { repo, bugClass } of stream) {
    const steps = makeTask(repo, bugClass, rng);
    if (agent) agent.newTask(); else bare.newTask();
    let taskOk = true;
    for (const st of steps) {
      nStep++;
      let d;
      if (mode === "noskill") {
        const x = [st.critHint, st.dHint, st.progress];
        d = bare.decideAbstract(x, bare.z.pollution, { actionType: st.actionType });
      } else {
        d = agent.decideStep(st);
      }
      const reallyCrit = st.trueCrit > CRIT_TH;
      let usedS2 = d.ignite;
      // 真实验证器: 改动类步骤强制 test,以 recall 抓住漏判 → 升级补救。
      let caught = false;
      if (d.verify === "test" && !d.ignite && reallyCrit) {
        if (st.rndV < TEST_RECALL) { caught = true; usedS2 = true; }
      }
      const mishandled = (!usedS2 && reallyCrit);
      if (usedS2) deep++;
      if (usedS2 && !reallyCrit) over++;   // 过度深思: 非关键步却走了 System2(浪费)
      if (mishandled) { miss++; if (st.actionType === "design_patch" || st.actionType === "apply_patch") mutMiss++; taskOk = false; }

      // 技能复用统计(仅 skill 臂):该步检索到同仓库已验证旧解。
      const hasReuse = (mode === "skill" && d.reusableFix);
      if (hasReuse) reuseHits++;

      // ★功率档成本: System2 时,若有可复用已验证旧解 → 验证档(便宜2);否则从零搜索档(贵5)。
      if (usedS2) {
        if (hasReuse) { cost += COST_S2_VERIFY; reuseSaves++; }
        else cost += COST_S2_SEARCH;
      } else {
        cost += COST_S1;
      }
      if (mishandled) cost += MISS_PENALTY;

      // 学习: 真实验证结果。falsify 臂把所有验证标失败(没有可信旧解可复用)。
      const verifierPassed = (d.verify === "test") ? (mode === "falsify" ? false : (caught || !reallyCrit || usedS2)) : null;
      const outcome = mode === "falsify" ? 0 : (usedS2 || !reallyCrit ? 1 : 0);
      const verifierResult = (st.actionType === "apply_patch" || st.actionType === "design_patch")
        ? (mode === "falsify" ? "test_failed" : (outcome ? "test_passed" : "test_failed")) : null;
      // ★受信任执行器验证(P0 后:仅 source∈白名单 且 exitCode===0 的记录才可复用)。
      //   skill 臂成功步给 executor+exit0(可信);falsify 臂给 exit1(不可信,验证全失败)。
      const verification = (st.actionType === "apply_patch" || st.actionType === "design_patch")
        ? { source: "executor", exitCode: mode === "falsify" ? 1 : (outcome ? 0 : 1), testCmd: "pytest -q" }
        : null;

      if (mode === "noskill") {
        const x = [st.critHint, st.dHint, st.progress];
        bare.learnAbstract(x, st.trueCrit, d.ignite, { verifierPassed, missHappened: mishandled }, { actionType: st.actionType });
        bare.addPollution(usedS2, usedS2);
      } else {
        agent.learnStep(st, {
          observedCrit: st.trueCrit, ignited: d.ignite, verifierPassed, missHappened: mishandled,
          patchSummary: st.patchSummary, changeFootprint: { files: 1, hunks: 2, loc: 12 },
          verifierResult, outcome, verification,
        });
      }
    }
    if (agent) agent.feedback(taskOk); else bare.feedback(taskOk);
  }
  const st = agent ? agent.stats() : { nProto: bare.protos.length, nSkills: 0 };
  return { deepRate: +(deep / nStep).toFixed(3), cost, miss, mutMiss, over, reuseHits, reuseSaves,
           nSkills: st.nSkills ?? 0 };
}

function avg(rows, k) { return +(rows.reduce((s, r) => s + r[k], 0) / rows.length).toFixed(2); }

const arms = { "noskill(纯元认知)": "noskill", "skill(完整三层)": "skill", "falsify(技能库但验证全失败)": "falsify" };
const out = {};
for (const [name, mode] of Object.entries(arms)) {
  const rows = [];
  for (let s = 0; s < SEEDS; s++) rows.push(runArm(3000 + s * 17, mode));
  out[name] = {
    deepRate: avg(rows, "deepRate"), cost: avg(rows, "cost"), miss: avg(rows, "miss"), mutMiss: avg(rows, "mutMiss"),
    over: avg(rows, "over"), reuseHits: avg(rows, "reuseHits"), reuseSaves: avg(rows, "reuseSaves"), nSkills: avg(rows, "nSkills"),
  };
}

console.log(`\n=== 技能层验证: 学到领域语义? (seeds=${SEEDS}, ${REPOS.length}仓库×${BUG_CLASSES.length}bug类×${REPEAT}复现) ===`);
console.log(`成本档: System1=1, System2从零搜索=5, System2验证已知解=2, 漏判补救=+5`);
for (const [name, o] of Object.entries(out)) {
  console.log(`\n[${name}]`);
  console.log(`  深思率(System2)   = ${o.deepRate}`);
  console.log(`  过度深思(非关键S2) = ${o.over}`);
  console.log(`  ★总成本(功率档)   = ${o.cost}`);
  console.log(`  关键漏判          = ${o.miss}  (改动步 ${o.mutMiss})`);
  console.log(`  ★检索到可复用旧解 = ${o.reuseHits} 次`);
  console.log(`  ★复用省成本(验证档)= ${o.reuseSaves} 次 (System2 走廉价验证而非从零搜索)`);
  console.log(`  技能库规模        = ${o.nSkills} 条`);
}

const ns = out["noskill(纯元认知)"], sk = out["skill(完整三层)"], fz = out["falsify(技能库但验证全失败)"];
console.log(`\n--- 诚实结论 ---`);
console.log(`1) 技能复用: skill 臂检索到可复用旧解 ${sk.reuseHits} 次, ${sk.reuseSaves} 次让 System2 走廉价验证档。`);
console.log(`   noskill 臂无技能库(reuseHits=0)。 → 学到的领域 know-how 在改变算力档位(从零搜索→验证已知解)。`);
const savedCost = sk.cost < ns.cost;
console.log(`2) 省算力: skill 总成本 ${sk.cost} ${savedCost ? "<" : ">="} noskill ${ns.cost} ${savedCost ? "(复用旧解→更省 ✅)" : "(未更省)"}`);
const safetyKept = sk.mutMiss <= ns.mutMiss + 0.5;
console.log(`3) 不拿安全换: skill 改动步漏判 ${sk.mutMiss} vs noskill ${ns.mutMiss} ${safetyKept ? "(没变差 ✅)" : "(变差,需检查)"}`);
const falsifyWorks = fz.reuseSaves < sk.reuseSaves && fz.cost > sk.cost;
console.log(`4) ★可证伪: 验证全标失败(无可信旧解) → 复用省成本从 ${sk.reuseSaves} 掉到 ${fz.reuseSaves}, 总成本 ${sk.cost}→${fz.cost} ${falsifyWorks ? "(收益确实来自真实验证 ✅)" : "(未掉,机制可疑)"}`);

const verdict = sk.reuseHits > 0 && savedCost && safetyKept && falsifyWorks;
console.log(`\n判定: ${verdict
  ? "完整三层框架成立——技能层学到接地于真实验证的领域经验,复用已知解把深思从'昂贵搜索'降为'廉价验证',省算力且不牺牲安全,收益可证伪地来自真实验证(非提示词)。"
  : "未完全成立,需检查技能竞价权重/验证接地。"}`);
process.exit(0);
