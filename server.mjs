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

// ── ★Endpoint isolation (P0 attestation): issue_attestation is a PRIVILEGED minting endpoint ──
//   It signs cryptographic trust attestations over real test results. If it sits in the same
//   process as decision endpoints (decide_step ...) facing UNTRUSTED clients, a client could call
//   it directly to sign its own fake result (HMAC only stops "forge without the server", not
//   "call this endpoint"). So it is DISABLED by default and only exposed when this process is
//   explicitly declared to run on the trusted-isolated executor side.
//   Enable with env EMMS_EXECUTOR_ENDPOINT=1 (production should also add stdio/unix-socket isolation).
const EXECUTOR_ENDPOINT_ENABLED =
  process.env.EMMS_EXECUTOR_ENDPOINT === "1" || process.env.EMMS_EXECUTOR_ENDPOINT === "true";
// Executor-only endpoints (privileged; hidden from untrusted scheduler clients).
const EXECUTOR_ONLY_TOOLS = new Set(["issue_attestation"]);

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
      "并给出验证策略(verify)。三层框架(元认知×技能×动作)全部在同一条 EMMS 竞价里裁决:" +
      "criticality_hint=这步表面多关键, difficulty_hint=表面多难, progress=任务进度, context_pollution=上下文占用比(真实量)。" +
      "★强烈建议传【操作语义】以激活技能层与动作层:action_type(read_issue/retrieve/locate/design_patch/apply_patch/" +
      "write_code/edit_file/refactor/delete/migrate_schema/run_test...), repo(仓库,定仓库边界), lang, file_type, " +
      "error_signature(报错文本/异常类型), stack_features(堆栈/符号 token 数组)。技能层据此检索【同仓库+真验证过】的可复用修法→" +
      "降算力(reusable_fix);陌生/跨仓库→抬算力(谨慎)。改动类动作(design_patch/apply_patch/...)不论风险估计多低都【强制验证】," +
      "且按动作类型分派验证策略(design_patch→review 评审; apply_patch/write_code/edit_file/refactor→test; " +
      "delete/migrate_schema→dry_run; run_test→none)。" +
      "★不可逆步(部署/迁移/回滚/删除/改密钥)传 irreversible=true 或 risk_class=critical → 硬约束强制 System2+验证。" +      "返回 mode + risk_class + verify + remaining_risk_budget + 三层竞价分解(rob_bid/eco_ask + action_premium + " +
      "skill_reuse_discount/skill_novelty_premium/cross_repo_premium + skill_signal + reusable_fix) + p_upper(保守上界,裁决用它)。" +
      "★介尺度簇层(可选,传 files/symbols/failing_tests/plan_node 激活):从这些【决策时可见】信号【自动发现】子目标簇" +
      "(文件/符号重叠 + 失败测试传播 + 计划父节点,在线 union-find),并把'本步属于一个高后果且强耦合的簇'作为 cluster_premium" +
      "抬 rob_bid → 整簇倾向一起进 System2,救回'簇真关键但本步 hint 偏低'的漏判。簇是自动发现的,无需手动声明边界。返回 cluster_premium + cluster 证据。",
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
        action_type: { type: "string", description: "★操作类型。改动类(design_patch/apply_patch/write_code/edit_file/refactor/delete/migrate_schema)激活动作硬约束+强制验证;只读类(read_issue/retrieve/locate/inspect/run_test)先验低可大胆 System1。" },
        repo: { type: "string", description: "★仓库标识(定仓库边界:同仓库经验可复用,跨仓库经验打折/触发稳健溢价)。" },
        branch: { type: "string", description: "可选,分支标识(同 repo 不同 branch 的经验隔离;复用修法要求同 repo 且同 branch 若给定)。" },
        lang: { type: "string", description: "语言(python/js/...)，参与技能检索相似度。" },
        file_type: { type: "string", description: "文件类型(py/ts/md/yaml...)，参与技能检索相似度。" },
        error_signature: { type: "string", description: "★报错签名(异常类型/报错文本首行)。技能层据此检索同类错误的已验证修法。决策时可见(报错先于修复,无泄漏)。" },
        stack_features: { type: "array", items: { type: "string" }, description: "堆栈/符号特征 token 数组(函数名/文件名/异常类),提升技能检索精度。" },
        step_id: { type: "string", description: "★介尺度簇层:本步唯一 id(不传则自增)。回报 report_outcome 时带同一 step_id → 真关键标定回灌该簇。" },
        files: { type: "array", items: { type: "string" }, description: "★介尺度(决策时可见):本步触碰的文件路径。与其它步文件重叠高→自动归入同一子目标簇。" },
        symbols: { type: "array", items: { type: "string" }, description: "★介尺度(决策时可见):本步触碰的符号(函数/类/import)。符号重叠高→自动连入同簇。" },
        failing_tests: { type: "array", items: { type: "string" }, description: "★介尺度(决策时可见):当前已知失败的测试 id。失败测试把'该一起修的步'标定成一簇(失败传播,最强耦合信号)。" },
        covered_files: { type: "array", items: { type: "string" }, description: "可选:当前失败测试覆盖到的源文件(若有覆盖率信息),增强失败传播连边精度。" },
        plan_node: { type: "string", description: "可选:planner 给出的子任务 id。同一子任务的步自动归簇。" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "report_outcome",
    description:
      "这一步做完后回报真实结果，三层据此自学。元认知层:observed_criticality=事后真实关键度(0~1)，" +
      "used_system2=是否实际深思，was_deep=是否做了深处理(默认同 used_system2)。" +
      "★若 decide 返回了 verify 动作,把验证结果用 verifier_passed(true/false) 带回 → 喂变性探测器+风险预算账本;" +
      "便宜处理了其实关键的步(漏判)可用 miss_happened=true 标注。" +
      "★技能层(关键,这才是\"学到领域经验\"):改动类动作做完后,把【真实修法内容】带回 → 存成可复用技能记录。" +
      "传 action_type/repo/lang/file_type/error_signature/stack_features(与 decide 同) + patch_summary(真实修法摘要) + " +
      "change_footprint({files,hunks,loc} 改动面) + verifier_result(\"test_passed\"/\"test_failed\"/...) + outcome(1成功/0失败)。" +
      "★接地纪律:只有【verifier_result=test_passed 或 outcome=1】的记录才会被未来当作可信先例复用(降算力),失败记录不贡献复用置信。",
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
        action_type: { type: "string", description: "可省略(默认沿用上一步 decide_step);显式传才覆盖。" },
        repo: { type: "string", description: "可省略(默认沿用上一步);仓库边界键。" },
        branch: { type: "string", description: "可省略;分支隔离键(同 repo 不同 branch 的经验隔离检索)。" },
        lang: { type: "string", description: "可省略(默认沿用上一步)。" },
        file_type: { type: "string", description: "可省略(默认沿用上一步)。" },
        error_signature: { type: "string", description: "可省略(默认沿用上一步)。" },
        stack_features: { type: "array", items: { type: "string" }, description: "可省略(默认沿用上一步)。" },
        patch_summary: { type: "string", description: "★真实修法摘要(可复用 skill 本体)。改动类动作务必带回才能学到领域经验。会被脱敏+截断。" },        change_footprint: { type: "object", description: "改动面 {files,hunks,loc}。" },
        verification: {
          type: "object",
          description: "★可信度来源:受信任执行器【密码学背书】。先调 issue_attestation(真实 exit_code) 拿到带 {nonce,ts,attestation:{sig}} 的对象,原样回填到这里。调度器用服务端密钥验签+防重放+新鲜窗口,仅【验签通过】才授予复用可信度。客户端无密钥 → 无法伪造 {source:'executor',exit_code:0}。",
          properties: {
            source: { type: "string", description: "执行器来源标识(须在受信白名单,默认 'executor')。" },
            exit_code: { type: "number", description: "测试进程退出码(0=通过)。必须与签名时一致,否则验签失败。" },
            test_cmd: { type: "string", description: "实际执行的测试命令。" },
            commit_hash: { type: "string", description: "被测 commit hash。" },
            patch_hash: { type: "string", description: "应用的 patch 内容 hash。" },
            nonce: { type: "string", description: "★issue_attestation 返回的一次性 nonce(防重放)。" },
            ts: { type: "number", description: "★issue_attestation 返回的签发时间戳(新鲜窗口校验)。" },
            attestation: { type: "object", description: "★issue_attestation 返回的签名 {ver, sig}。缺失或不匹配 → 不授信。" },
          },
        },
        verifier_result: { type: "string", description: "描述性标签:test_passed/test_failed/...(不单独授予可信度,看 verification)。" },
        outcome: { type: "number", description: "描述性标签:1 成功 / 0 失败(不单独授予可信度)。" },
        step_id: { type: "string", description: "★介尺度:与 decide_step 同一 step_id。若本步被真实结果证明关键(miss_happened/verifier_passed=false/observed_criticality 高),回灌标定该子目标簇为真关键。" },
      },
      required: ["sessionId", "observed_criticality", "used_system2"],
    },
  },
  {
    name: "issue_attestation",
    description:
      "★【受信任执行器专用】对真实测试结果签发密码学背书 token。真跑完测试后调用,传真实 exit_code(+可选 test_cmd/commit_hash/patch_hash)," +
      "返回带 {source,exit_code,nonce,ts,attestation:{sig}} 的对象,把它原样放进 report_outcome 的 verification 字段即被授信。" +
      "安全: 签名用【服务端密钥】,无密钥的客户端伪造 exit_code:0 也签不出有效 token;nonce 一次性防重放,ts 受新鲜窗口约束。" +
      "生产部署应把本工具限定为【仅本地隔离执行器可达】,不暴露给不可信客户端。",
    inputSchema: {
      type: "object",
      properties: {
        exit_code: { type: "number", description: "★真实测试进程退出码(0=通过)。执行器只对真实结果签名。" },
        test_cmd: { type: "string", description: "可选:实际执行的测试命令。" },
        commit_hash: { type: "string", description: "可选:被测 commit hash。" },
        patch_hash: { type: "string", description: "可选:应用的 patch 内容 hash。" },
        source: { type: "string", description: "可选:执行器来源标识(默认 'executor',须在受信白名单)。" },
      },
      required: ["exit_code"],
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
    name: "dump_clusters",
    description: "★介尺度审计:导出当前任务【自动发现】的子目标簇(每簇的成员步 step_id + 规模 + 连边原因)。用于检查簇是不是从真实文件/符号/失败测试信号涌现出来的。",
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
  // ★Endpoint isolation: privileged minting endpoint only on trusted executor process; else reject.
  if (EXECUTOR_ONLY_TOOLS.has(name) && !EXECUTOR_ENDPOINT_ENABLED) {
    throw new Error(
      `tool "${name}" is an executor-only attestation endpoint and is disabled on this scheduler server. ` +
      `Run a separate trusted executor process with EMMS_EXECUTOR_ENDPOINT=1 to mint attestations.`
    );
  }
  switch (name) {
    case "open_session":
      return core.openSession(args.sessionId, args.namespace || "default", args.opts || {});
    case "new_task":
      return core.newTask(args.sessionId);
    case "decide_step": {
      const r = core.decide(args.sessionId, args);
      delete r._step; delete r._pollution; // 内部透传字段不外泄
      return r;
    }
    case "report_outcome":
      return core.reportOutcome(args.sessionId, args);
    case "issue_attestation":
      return core.issueAttestation(args);
    case "task_feedback":
      return core.taskFeedback(args.sessionId, args.success);
    case "get_stats":
      return core.stats(args.sessionId);
    case "get_calibration":
      return core.calibration(args.sessionId);
    case "dump_prototypes":
      return core.dumpPrototypes(args.sessionId);
    case "dump_clusters":
      return core.dumpClusters(args.sessionId);
    case "close_session":
      return core.closeSession(args.sessionId);    default:
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
        // ★Advertise only the endpoints this process actually exposes; hide privileged minting endpoint.
        result = {
          tools: EXECUTOR_ENDPOINT_ENABLED
            ? TOOLS
            : TOOLS.filter((t) => !EXECUTOR_ONLY_TOOLS.has(t.name)),
        };
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
log(EXECUTOR_ENDPOINT_ENABLED
  ? "mode=EXECUTOR (issue_attestation EXPOSED — run only behind trusted isolation)"
  : "mode=SCHEDULER (issue_attestation hidden+blocked; set EMMS_EXECUTOR_ENDPOINT=1 for executor mode)");
