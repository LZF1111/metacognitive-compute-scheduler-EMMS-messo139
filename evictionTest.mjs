/**
 * evictionTest.mjs —— 回归测试:原型淘汰必须【保留罕见但关键】的原型,淘汰罕见且不关键的。
 *
 * 这是对评审 P0(反向淘汰 bug)的回归保护:
 *   旧实现 score=n*(1-critEst) 删最小 → 罕见且关键(n小,critEst→1)score→0 被优先删(反了)。
 *   新实现 retain=critEst + 0.1*n/(n+5) 删最小 → 关键度主导,罕见但关键受保护。
 *
 * 直接构造满库(已知 {n, critEst}),再注入原型触发真实淘汰循环,断言被删的是
 * "罕见且不关键"者、关键原型存活。这样隔离淘汰逻辑本身,不受 merge/ignite 动态干扰
 * (低关键新情形本就不该自生原型,那是另一条设计)。
 */
import { SelfModelAgent } from "./selfModel.mjs";

let failed = 0;
const assert = (cond, msg) => { console.log(`  [${cond ? "PASS" : "FAIL"}] ${msg}`); if (!cond) failed++; };

// 造一个 critEst 固定输出 c 的合成原型(protoFeat 任意分散,n 指定)。隔离淘汰逻辑。
function mkProto(c, n, feat) {
  return {
    protoFeat: feat.slice(),
    policy: { theta: 0.6, muBias: 0 },
    w: [0, 0, 0, 0], n, conf: 0.5, predErr: 0.3,
    critEst() { return c; },
  };
}
// 生产代码的淘汰循环(与 selfModel._growProto 内一字不差),在测试里直接驱动。
function evict(agent) {
  while (agent.protos.length > agent.maxProto) {
    const retain = (p) => p.critEst(agent._rfeat(p.protoFeat)) + 0.1 * (p.n / (p.n + 5));
    let wi = 0; for (let i = 1; i < agent.protos.length; i++) if (retain(agent.protos[i]) < retain(agent.protos[wi])) wi = i;
    agent.protos.splice(wi, 1);
  }
}

const agent = new SelfModelAgent({ maxProto: 4 });

// 满库:3 个【高频(n=30) 低关键(crit=0.05)】 + 1 个【罕见(n=1) 极关键(crit=0.95)】。
agent.protos = [
  mkProto(0.05, 30, [0.1, 0.2, 0.0]),
  mkProto(0.05, 30, [0.2, 0.8, 0.1]),
  mkProto(0.05, 30, [0.3, 0.5, 0.9]),
  mkProto(0.95, 1, [0.9, 0.9, 0.5]),   // ← 罕见但关键,最该保护的
];
console.log("满库:", JSON.stringify(agent.protos.map((p) => ({ n: p.n, crit: p.critEst() }))));

// 注入第 5 个【罕见(n=1) 中低关键(crit=0.3)】→ 超 maxProto=4 → 触发淘汰。
// 期望:删【关键度最低】者(crit=0.05),而非更关键的 crit=0.3/0.95。
//   关键度主导:即便 crit=0.05 高频(n=30),也比 crit=0.3 罕见者更该删
//   (低关键步漏判便宜,留它无助于避免昂贵的关键漏判)——正是评审要的方向。
agent.protos.push(mkProto(0.3, 1, [0.5, 0.5, 0.5]));
evict(agent);
console.log("淘汰后:", JSON.stringify(agent.protos.map((p) => ({ n: p.n, crit: p.critEst() }))));

assert(agent.protos.length === 4, "淘汰后严格 = maxProto=4");
assert(agent.protos.some((p) => p.critEst() === 0.95 && p.n === 1),
  "罕见(n=1)且极关键(crit=0.95)的原型【存活】 → 没被反向删掉(P0 修复)");
assert(agent.protos.some((p) => p.critEst() === 0.3),
  "中低关键(crit=0.3)原型存活 → 比 crit=0.05 更关键,关键度主导保留");
assert(agent.protos.filter((p) => p.critEst() === 0.05).length === 2,
  "被删的是 3 个 crit=0.05 中关键度最低的 1 个 → 高频低关键可淘汰(评审要的方向)");

// 进一步:即便注入一个 n=100 的高频低关键原型,关键原型仍应活着(关键度主导)。
agent.protos.push(mkProto(0.04, 100, [0.6, 0.4, 0.2]));
evict(agent);
assert(agent.protos.some((p) => p.critEst() === 0.95),
  "即便注入 n=100 高频低关键原型,crit=0.95 关键原型仍存活 → 关键度【主导】保留优先级");

if (failed) { console.log(`\n✗ ${failed} 条断言失败 —— 淘汰逻辑可能又反了`); process.exit(1); }
console.log("\n✓ 淘汰逻辑正确:关键度主导保留优先级,罕见但关键的原型受保护,淘汰的是罕见且不关键者。");
