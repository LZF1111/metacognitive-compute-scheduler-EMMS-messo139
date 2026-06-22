/**
 * server.mjs —— 意识核 MCP 服务（Model Context Protocol over stdio, JSON-RPC 2.0）。
 *
 * 为什么自己手写 JSON-RPC 而不用 @modelcontextprotocol/sdk：
 *   本仓库零第三方依赖原则 + 该环境 GitHub/npm 常被墙（SDK 拉不下来）。
 *   MCP 在 stdio 上就是【按行分帧的 JSON-RPC 2.0】，自己实现 initialize/tools.list/tools.call
 *   三个方法即可被任何 MCP 客户端（Claude Desktop / Cursor / VS Code / 自研 agent）调度。
 *
 * 它把"意识核"暴露成一组工具，任何智能体在自己的 agent loop 里可以这样用：
 *   1) open_session(namespace)                  ← 开局，复用该 namespace 已积累的技能
 *   2) 每个任务开始: new_task(sessionId)
 *   3) 每一步决策前: decide_step(...) → 拿 mode=system1/system2 决定用便宜还是强模型
 *   4) 每一步做完后: report_outcome(...)        ← 回报真实结果，核自学
 *   5) 整任务结束: task_feedback(success)        ← 调 μ + 自动持久化技能
 *
 * 通信：stdin 逐行读 JSON-RPC 请求，stdout 逐行写响应。日志一律走 stderr（不污染协议流）。
 */
import readline from "node:readline";
import { ConsciousCore } from "./consciousCore.mjs";

const core = new ConsciousCore();
const log = (...a) => { try { process.stderr.write(`[conscious-mcp] ${a.join(" ")}\n`); } catch {} };

const SERVER_INFO = { name: "conscious-scheduler", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

// ── 工具定义（schema 给客户端看，描述写清楚每个量怎么算）──
const TOOLS = [
  {
    name: "open_session",
    description:
      "开一个调度会话。namespace 决定复用哪套已积累的'技能/原型库'（同 namespace = 跨任务/跨进程累积经验）。" +
      "返回 sessionId 供后续所有调用使用。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "调用方自定的会话 ID（同一 agent loop 用同一个）" },
        namespace: { type: "string", description: "技能命名空间，如 'python-coding' / 'web-agent'。默认 default" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "new_task",
    description: "开始一个新任务：重置 loop 级自我状态（上下文污染清零），但保留跨任务的原型库与谨慎度 μ。",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
  },
  {
    name: "decide_step",
    description:
      "★核心：判断当前这一步该用 System1(直觉/便宜模型/单候选) 还是 System2(点燃/强模型/多候选/深推理)，" +
      "并给出是否需要验证(verify)。调用方提供通用可观测量(都是 0~1)：criticality_hint=这步表面多关键(错了毁全局?), " +
      "difficulty_hint=表面多难, progress=任务进度位置, context_pollution=当前上下文窗口占用比(已用token/窗口)。" +
      "★若这步不可逆(数据库迁移/部署/回滚/删除/改密钥权限)请传 irreversible=true 或 risk_class=critical → 走硬约束强制 System2+验证。" +
      "返回 mode + risk_class(normal/critical/irreversible) + verify(none/lint/test/dry_run) + remaining_risk_budget + 分层决策依据" +
      "(p_upper=保守风险上界,裁决用它而非点估计; decision_reason=触发哪一层)。这是元认知决策,与'做什么步骤'(skill)正交。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        criticality_hint: { type: "number", description: "0~1，这步表面关键度" },
        difficulty_hint: { type: "number", description: "0~1，这步表面难度" },
        progress: { type: "number", description: "0~1，在整个任务中的进度位置" },
        context_pollution: { type: "number", description: "0~1，当前上下文占用比（真实量，强烈建议传）" },
        risk_class: { type: "string", enum: ["normal", "critical", "irreversible"], description: "可选,声明本步风险类别。critical→强制System2+test; irreversible→强制System2+dry_run" },
        irreversible: { type: "boolean", description: "可选,等价于 risk_class=irreversible。不可逆步(部署/迁移/删除/密钥)务必传 true" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "report_outcome",
    description:
      "这一步做完后回报真实结果，核据此自学（生长/细化原型=自己写skill）。" +
      "observed_criticality=事后看这步真实有多关键(0~1，如:便宜就成功=低, 必须强模型才成功=高)；" +
      "used_system2=这步是否实际走了深思；was_deep=是否做了深处理(默认同 used_system2)。" +
      "★若 decide 返回了 verify 动作,把验证结果用 verifier_passed(true/false) 带回 → 喂变性探测器+风险预算账本;" +
      "若便宜处理了一个其实关键的步(漏判),可用 miss_happened=true 显式标注。" +
      "建议把 decide_step 时用的 criticality_hint/difficulty_hint/progress 原样带回以对齐情形签名。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        criticality_hint: { type: "number" },
        difficulty_hint: { type: "number" },
        progress: { type: "number" },
        observed_criticality: { type: "number", description: "0~1，事后观测的真关键度" },
        used_system2: { type: "boolean" },
        was_deep: { type: "boolean" },
        verifier_passed: { type: "boolean", description: "可选,该步验证器是否通过(挂了 verify 时回报)" },
        miss_happened: { type: "boolean", description: "可选,是否发生了关键漏判(便宜处理了其实关键的步)" },
      },
      required: ["sessionId", "observed_criticality", "used_system2"],
    },
  },
  {
    name: "task_feedback",
    description: "整个任务结束后回报成/败 → 调协调变量 μ（稳定性条件），并自动把原型库持久化到磁盘。",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, success: { type: "boolean" } },
      required: ["sessionId", "success"],
    },
  },
  {
    name: "get_stats",
    description: "查会话当前状态：原型数(已长出的技能)、μ、点燃次数、步数、上下文污染。",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
  },
  {
    name: "get_calibration",
    description:
      "查校准指标(量化'越学越聪明')：返回滚动窗口内的 MAE(关键度预测误差,越小越准) 与 accuracy(深思/便宜决策是否命中真关键)，" +
      "并拆成 firstHalf/recentHalf 两半对比 + improving 布尔(近半是否优于前半)。用于证明随任务增多在变准。",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
  },
  {
    name: "dump_prototypes",
    description: "导出原型库（= 自己长出的 skill），含每个原型的情形质心与读出权重。可用于审计/迁移。",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
  },
  {
    name: "close_session",
    description: "关闭会话并持久化技能。",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
  },
];

// ── 工具分发 ──
function callTool(name, args = {}) {
  switch (name) {
    case "open_session":
      return core.openSession(args.sessionId, args.namespace || "default", args.opts || {});
    case "new_task":
      return core.newTask(args.sessionId);
    case "decide_step": {
      const r = core.decide(args.sessionId, args);
      delete r._x; delete r._pollution; // 内部透传字段不外泄
      return r;
    }
    case "report_outcome":
      return core.reportOutcome(args.sessionId, args);
    case "task_feedback":
      return core.taskFeedback(args.sessionId, args.success);
    case "get_stats":
      return core.stats(args.sessionId);
    case "get_calibration":
      return core.calibration(args.sessionId);
    case "dump_prototypes":
      return core.dumpPrototypes(args.sessionId);
    case "close_session":
      return core.closeSession(args.sessionId);
    default:
      throw new Error(`unknown tool "${name}"`);
  }
}

// ── JSON-RPC 处理 ──
function handle(msg) {
  const { id, method, params } = msg;
  // 通知（无 id）不需要响应
  const isNotification = id === undefined || id === null;

  try {
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        };
        break;
      case "notifications/initialized":
      case "initialized":
        return null; // 通知，无响应
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const out = callTool(params?.name, params?.arguments || {});
        // MCP 约定 tools/call 返回 content[]；我们用 text 装 JSON（结构化结果也放 structuredContent）。
        result = {
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
          isError: false,
        };
        break;
      }
      default:
        if (isNotification) return null;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
    }
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, result };
  } catch (e) {
    log("error:", e.message);
    if (isNotification) return null;
    // 对 tools/call 的业务错误用 isError content（符合 MCP 习惯），其余用协议级 error。
    if (method === "tools/call") {
      return {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32603, message: e.message } };
  }
}

// ── stdio 主循环（逐行 JSON）──
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { log("bad json:", s.slice(0, 80)); return; }
  const resp = handle(msg);
  if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
});
rl.on("close", () => process.exit(0));

log(`started (${SERVER_INFO.name} v${SERVER_INFO.version}), ${TOOLS.length} tools, stdio JSON-RPC`);
