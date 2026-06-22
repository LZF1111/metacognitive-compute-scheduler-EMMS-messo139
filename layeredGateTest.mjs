// 分层安全调度的硬约束/验证动作/风险预算回归测试。
import { ConsciousCore } from "./consciousCore.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  [PASS]", msg); } else { fail++; console.log("  [FAIL]", msg); } };

const c = new ConsciousCore({ store: null });
c.openSession("t", "ns-layered-" + Date.now(), {});

// 先用一批"低关键+验证通过"的便宜步把原型学熟(否则空库恒 System2)。
for (let i = 0; i < 12; i++) {
  c.decide("t", { criticality_hint: 0.1, difficulty_hint: 0.1, progress: i / 12 });
  c.reportOutcome("t", { criticality_hint: 0.1, difficulty_hint: 0.1, progress: i / 12,
    observed_criticality: 0.1, used_system2: false, verifier_passed: true });
}

// 1) 普通低关键步 → 应走 System1(成本敏感层)。
const norm = c.decide("t", { criticality_hint: 0.1, difficulty_hint: 0.1, progress: 0.5 });
ok(norm.mode === "system1", `普通低关键步走 System1 (mode=${norm.mode}, reason=${norm.decision_reason})`);

// 2) 外部声明 irreversible → 无论关键度多低,硬约束强制 System2 + dry_run 验证。
const irr = c.decide("t", { criticality_hint: 0.1, difficulty_hint: 0.1, progress: 0.5, irreversible: true });
ok(irr.mode === "system2", `irreversible 步强制 System2 (mode=${irr.mode})`);
ok(irr.risk_class === "irreversible", `irreversible 步 risk_class=irreversible (=${irr.risk_class})`);
ok(irr.verify === "dry_run", `irreversible 步挂 dry_run 验证 (verify=${irr.verify})`);
ok(irr.decision_reason === "irreversible-hard-gate", `触发硬约束层 (reason=${irr.decision_reason})`);

// 3) 外部声明 critical → 强制 System2 + test 验证。
const crit = c.decide("t", { criticality_hint: 0.1, difficulty_hint: 0.1, progress: 0.5, risk_class: "critical" });
ok(crit.mode === "system2" && crit.verify === "test", `critical 步 System2+test (mode=${crit.mode}, verify=${crit.verify})`);

// 4) 风险预算应随便宜未验证步耗尽 → 连续高风险便宜步最终强制升级。
const fresh = new ConsciousCore({ store: null });
fresh.openSession("u", "ns-budget-" + Date.now(), {});
for (let i = 0; i < 8; i++) { // 先学一个"中高关键但被便宜处理"的原型,抬高 pUpper
  fresh.decide("u", { criticality_hint: 0.55, difficulty_hint: 0.5, progress: 0.3 });
  fresh.reportOutcome("u", { criticality_hint: 0.55, difficulty_hint: 0.5, progress: 0.3,
    observed_criticality: 0.55, used_system2: false, verifier_passed: null });
}
let sawBudgetGate = false;
for (let i = 0; i < 30; i++) {
  const d = fresh.decide("u", { criticality_hint: 0.55, difficulty_hint: 0.5, progress: 0.3 });
  if (d.decision_reason === "risk-budget-exhausted") sawBudgetGate = true;
  fresh.reportOutcome("u", { criticality_hint: 0.55, difficulty_hint: 0.5, progress: 0.3,
    observed_criticality: 0.55, used_system2: d.mode === "system2", verifier_passed: d.verify !== "none" ? false : null });
}
ok(sawBudgetGate, "累计未验证风险耗尽预算后触发 risk-budget-exhausted 升级");

// 5) decide 透出分层字段齐全。
ok(["risk_class", "verify", "remaining_risk_budget", "p_upper", "shift_score"].every(k => norm[k] !== undefined),
  "decide 透出 risk_class/verify/remaining_risk_budget/p_upper/shift_score");

console.log(fail === 0 ? `\n\u2713 分层安全调度全部 ${pass} 条断言通过` : `\n\u2717 ${fail} 条断言失败`);
process.exit(fail === 0 ? 0 : 1);
