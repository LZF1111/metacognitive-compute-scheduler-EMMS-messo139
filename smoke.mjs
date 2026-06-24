/**
 * smoke.mjs —— 起一个真实 MCP 客户端，spawn server.mjs，跑完整握手 + 多步任务，验证协议与决策。
 * 不依赖任何 SDK，自己按行收发 JSON-RPC，模拟"任意智能体如何调度这个框架"。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
// ★smoke simulates BOTH the trusted executor and the scheduler side, so it needs the
//   issue_attestation minting endpoint → start the server in EXECUTOR mode.
//   In production the scheduler process runs in default SCHEDULER mode (endpoint hidden+blocked);
//   a separate isolated executor process holds this mode.
const srv = spawn(NODE, [path.join(__dir, "server.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, EMMS_EXECUTOR_ENDPOINT: "1" },
});

let buf = "";
const pending = new Map();
let nextId = 1;
srv.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) { srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
async function tool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result.structuredContent ?? JSON.parse(r.result.content[0].text);
}

const log = (...a) => console.log(...a);

(async () => {
  // 1) 握手
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  log("initialize →", init.result.serverInfo.name, init.result.serverInfo.version);
  notify("notifications/initialized", {});

  // 2) 列工具
  const list = await rpc("tools/list", {});
  log("tools/list →", list.result.tools.map((t) => t.name).join(", "));

  // 3) 开会话（用唯一 namespace 避免读到旧持久化，保证 smoke 可复现）
  const ns = "smoke-" + Date.now();
  const sid = "s1";
  log("open_session →", JSON.stringify(await tool("open_session", { sessionId: sid, namespace: ns })));

  // 4) 模拟一个 6 步任务：第 0、3 步是关键步(crit高)，其余普通。看核能否点燃在关键步。
  await tool("new_task", { sessionId: sid });
  const steps = [
    { criticality_hint: 0.9, difficulty_hint: 0.8, progress: 0.0, trueCrit: 0.9 }, // 关键
    { criticality_hint: 0.2, difficulty_hint: 0.2, progress: 0.2, trueCrit: 0.1 },
    { criticality_hint: 0.3, difficulty_hint: 0.3, progress: 0.4, trueCrit: 0.2 },
    { criticality_hint: 0.85, difficulty_hint: 0.7, progress: 0.6, trueCrit: 0.9 }, // 关键
    { criticality_hint: 0.2, difficulty_hint: 0.3, progress: 0.8, trueCrit: 0.15 },
    { criticality_hint: 0.25, difficulty_hint: 0.2, progress: 1.0, trueCrit: 0.1 },
  ];
  // 多跑几轮让它学（每轮同一个任务结构）
  for (let round = 0; round < 6; round++) {
    await tool("new_task", { sessionId: sid });
    let pollution = 0;
    const modes = [];
    for (const st of steps) {
      const d = await tool("decide_step", { sessionId: sid, ...st, context_pollution: pollution });
      modes.push(d.mode === "system2" ? "S2" : "s1");
      const usedS2 = d.mode === "system2";
      pollution = Math.min(1, pollution + (usedS2 ? 0.15 : 0.04));
      await tool("report_outcome", { sessionId: sid, ...st, observed_criticality: st.trueCrit, used_system2: usedS2, was_deep: usedS2 });
    }
    await tool("task_feedback", { sessionId: sid, success: true });
    if (round === 0 || round === 5) log(`round${round} 决策序列 [${modes.join(" ")}]  (期望: 关键步S2, 普通步s1)`);
  }

  log("get_stats →", JSON.stringify(await tool("get_stats", { sessionId: sid })));
  const dump = await tool("dump_prototypes", { sessionId: sid });
  log(`dump_prototypes → 原型数=${dump.prototypes.length}, μ=${dump.mu}`);
  dump.prototypes.forEach((p) => log(`   原型#${p.id} 质心=${JSON.stringify(p.situationCentroid)} n=${p.n} conf=${p.confidence}`));

  // ── ★三层框架验证:技能层(领域语义)真正接入 MCP ──
  log("\n=== 技能层(领域语义)端到端验证 ===");
  // (A) 首次遇到一个 pytest 的 design_patch 步骤:技能库空 → 应 novelty 高、无可复用修法。
  const skillStep = {
    sessionId: sid, criticality_hint: 0.25, difficulty_hint: 0.4, progress: 0.5,
    action_type: "design_patch", repo: "pytest", lang: "python", file_type: "py",
    error_signature: "ScopeMismatch fixture session function-scoped",
    stack_features: ["_pytest.fixtures", "resolve_fixture_function"],
  };
  const d1 = await tool("decide_step", skillStep);
  log(`(A) 首遇 design_patch: mode=${d1.mode} verify=${d1.verify} is_mutating=${d1.is_mutating} forced_verify=${d1.forced_verify}`);
  log(`     技能信号 novelty=${d1.skill_signal?.novelty} repo_match=${d1.skill_signal?.repo_match} verified_support=${d1.skill_signal?.verified_support} reusable_fix=${d1.reusable_fix}`);
  const passA = d1.is_mutating === true && d1.verify === "review" && d1.reusable_fix == null && (d1.skill_signal?.novelty ?? 0) > 0.5;
  log(`     [${passA ? "PASS" : "FAIL"}] 改动步强制验证(design_patch→review) + 首遇无可复用修法 + novelty 高`);

  // 回报真实修法 + 【受信任执行器密码学背书】验证通过 → 写入技能库(这才是"学到领域经验")。
  //   ★P0(attestation): 先调 issue_attestation(真实 exit_code=0) 拿到带签名的 verification,
  //   再原样回填 report_outcome。无签名的 {source:executor,exit_code:0} 现在会被拒(防 MCP 伪造)。
  const att1 = await tool("issue_attestation", { exit_code: 0, test_cmd: "pytest -q", commit_hash: "deadbeef", patch_hash: "f00d" });
  await tool("report_outcome", {
    ...skillStep, observed_criticality: 0.85, used_system2: true, verifier_passed: true,
    patch_summary: "把 session-scoped fixture 降为 function scope 并显式 request 依赖",
    change_footprint: { files: 1, hunks: 2, loc: 9 },
    verification: att1,
  });

  // (B) 再遇同仓库同类错误:应检索到【已验证】可复用修法 → reusable_fix 非空、repo_match>0、novelty 降。
  const d2 = await tool("decide_step", skillStep);
  log(`(B) 再遇同类(同仓库): novelty=${d2.skill_signal?.novelty} repo_match=${d2.skill_signal?.repo_match} verified_support=${d2.skill_signal?.verified_support}`);
  log(`     reusable_fix=${JSON.stringify(d2.reusable_fix)}`);
  log(`     skill_reuse_discount=${d2.skill_reuse_discount}  (>0 = 经验复用降算力)`);
  const passB = d2.reusable_fix != null && (d2.skill_signal?.repo_match ?? 0) > 0 && (d2.skill_signal?.verified_support ?? 0) >= 1;
  log(`     [${passB ? "PASS" : "FAIL"}] 同仓库+真验证 → 检索到可复用修法(经验真的被复用)`);

  // (C) 跨仓库遇同类错误:repo_match 应=0(仓库边界),且 ★reusable_fix 必须为 null(绝不把 pytest 修法当 flask 可复用解)。
  const d3 = await tool("decide_step", { ...skillStep, repo: "flask" });
  log(`(C) 跨仓库(flask)同类错误: repo_match=${d3.skill_signal?.repo_match} cross_repo_premium=${d3.cross_repo_premium}`);
  log(`     reusable_fix=${JSON.stringify(d3.reusable_fix)}  reference_case=${d3.reference_case ? "有(仅参考)" : "无"}`);
  const passC = (d3.skill_signal?.repo_match ?? 1) === 0 && d3.reusable_fix === null && d3.reference_case != null;
  log(`     [${passC ? "PASS" : "FAIL"}] ★P0: 跨仓库 repo_match=0 且 reusable_fix===null(只给 reference_case 供人工审查)`);
  await tool("report_outcome", { ...skillStep, observed_criticality: 0.3, used_system2: false });

  // (D) report_outcome 自动对齐:重记一步同仓库 design_patch,但回报时【故意不传语义键】——
  //   应自动沿用上一步 decide 的 action_type/repo,仍写成技能记录(防遗漏字段悄悄退化)。
  await tool("decide_step", skillStep);
  const nBefore = (await tool("get_stats", { sessionId: sid })).nSkills;
  const att2 = await tool("issue_attestation", { exit_code: 0 });
  await tool("report_outcome", {
    sessionId: sid, observed_criticality: 0.8, used_system2: true,  // ★不传 action_type/repo/error_signature
    patch_summary: "同类修法第二例", verification: att2,
  });
  const nAfter = (await tool("get_stats", { sessionId: sid })).nSkills;
  const passD = nAfter > nBefore;
  log(`(D) report_outcome 省略语义键 → 自动对齐上一步 → 技能记录 ${nBefore}→${nAfter}`);
  log(`     [${passD ? "PASS" : "FAIL"}] 遗漏 action_type 也不退化(自动沿用 lastStep 语义)`);

  // 5) 验证持久化：关闭→新会话同 namespace→应能复用【原型 + 技能记忆】
  log("\nclose_session →", JSON.stringify(await tool("close_session", { sessionId: sid })));
  const reopen = await tool("open_session", { sessionId: "s2", namespace: ns });
  log("reopen 同 namespace → loadedPrototypes =", reopen.loadedPrototypes, "loadedSkills =", reopen.loadedSkills, "(均应 >0 = 三层记忆持久化成功)");
  const passPersist = reopen.loadedPrototypes > 0 && reopen.loadedSkills > 0;
  log(`[${passPersist ? "PASS" : "FAIL"}] 元认知原型 + 技能记忆 跨进程持久化复用`);

  const allPass = passA && passB && passC && passD && passPersist;
  log(`\n${allPass ? "✓ 两层(元认知+技能记忆)已真正接入 MCP" : "✗ 接入存在断点"}: A(动作强制验证)=${passA} B(同仓库复用)=${passB} C(跨仓库不泄漏)=${passC} D(自动对齐)=${passD} 持久化=${passPersist}`);

  // 清理本次 smoke 产生的持久化文件(不污染 store 目录)。
  try { fs.rmSync(path.join(__dir, "store", `${ns}.json`), { force: true }); } catch {}

  srv.stdin.end();
  setTimeout(() => process.exit(allPass ? 0 : 1), 100);
})().catch((e) => { console.error("SMOKE FAIL:", e); process.exit(1); });
