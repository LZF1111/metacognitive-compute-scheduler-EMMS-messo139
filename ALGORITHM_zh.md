# 意识核框架 · 算法与接入说明

> 一句话：这是一个**元认知调度器**。它不替你决定"做什么步骤"（那是 skill / planner 的事），
> 而是替任何智能体决定**"这一步该用多大算力、要不要停下来深想"**——并且这个判断不是写死的规则，
> 而是从经验里自己长出来、还会随任务中途变性而切换的"直觉"。

---

## 1. 它解决什么问题

一个 agent loop 跑长程任务时，每一步其实都在隐式回答一个问题：

> **"这一步我糊弄一下就行（便宜模型 / 单次生成），还是必须停下来认真想（强模型 / best-of-N / 深推理）？"**

绝大多数框架要么**全程满力**（贵、还把上下文越塞越脏），要么**靠人预写 skill 的硬触发**
（`if 文件数>12 就深想`）——预想不到的情形就漏判，任务中途变性就锁死。

本框架把这个"该用多大力"的决策**独立出来**，做成一个所有 agent 都能调用的服务。
它与"做什么"（skill / 计划）**正交**：你照常用你的 planner，只在每步问它一句"这步该 system1 还是 system2"。

---

## 2. 科学锚点（不神秘化，诚实标注）

| 概念 | 来源 | 在这里的含义 |
|---|---|---|
| **双过程** System1/System2 | Kahneman | system1=直觉（便宜模型/单候选）；system2=深思（强模型/best-of-N，会污染上下文） |
| **全局工作空间 + 点燃(ignition)** | Baars / Dehaene (GWT) | 惊讶超阈值 → 全局广播 → 调动 System2 重新审视 |
| **注意力图式** | Graziano (AST) | 维护一个自我状态 `z`（当前活跃原型/近期惊讶/谨慎度） |
| **竞争中的协调 (EMMS)** | 李静海 | 经济机制 vs 稳健机制两个相互冲突的极值倾向，由一个**影子价 μ** 协调出工作点 |

> 这里说的"意识"是**功能性**的：自我建模 + 全局整合 + 惊讶驱动广播。**不主张现象学意识。**

---

## 3. 核心算法：一次"点燃判定"= 一场竞价

每一步，环境给出弱线索 `x = [criticality_hint, difficulty_hint, progress]` 和当前 `context_pollution`。

**第一步：注意力聚焦（在原型库里找最像的）**

$$\text{sim} = \max_p \exp\!\Big(-\frac{\lVert x - \text{protoFeat}_p\rVert^2}{2\tau}\Big), \qquad \text{surprise} = 1-\text{sim}$$

没有原型解释得了当前情形 → `sim→0` → 高惊讶。

**第二步：两个机制竞价（这是 EMMS"竞争-协调"搬到 System1/System2 边界）**

- 稳健机制想点燃，它的**收益**随"可能关键 × 没把握"上升：

$$\text{robGain} = \mu \cdot (0.5 + \text{critEst}) \cdot \text{uncert}, \qquad \text{uncert} = \text{predErr}\cdot(2-\text{sim})$$

- 经济机制想省，它的**代价**= 固定深审成本 + 当前上下文污染惩罚（污染越重越不该再点燃，避免"越想越乱"自毒）：

$$\text{ecoCost} = c_{\text{consult}} + \lambda \cdot \text{pollution}$$

**第三步：协调裁决**

$$\boxed{\text{ignite} = (\text{原型库为空}) \ \lor\ (\text{robGain} > \text{ecoCost}) \ \lor\ \text{regimeShift}}$$

- 库空必点燃（无图式可依）；
- `robGain > ecoCost` 时点燃；
- **regimeShift**：任务中途活跃原型不再匹配（`sim<0.7`）→ 强制重审 → 切换原型。这是 loop 级意识最该发光的地方。

协调变量 **μ** = 风险的影子价，任务成/败后用稳定性条件微调（≡ KKT 的对偶变量更新）：失败→μ↑（更谨慎更爱深想），成功→μ↓（更省）。

**真实落地语义**（与 sim 不同，已在真实 LLM 上验证）：
- sim 里点燃=免费拿 oracle，所以"不确定就点燃"对；
- 真实里"一上来就满力"并不能告诉你便宜是否够用 → 改为：**自信判定为关键/难（critEst > θ）→ 直接上 System2**；否则先便宜探索，失败再由调用方走升级阶梯。这个反转让意识臂从"省 16%（输给 skill）"跳到 **"省 59–69% 且 Pareto 占优"**。

---

## 4. 为什么这能"替代 skill"（结构性，不是调参）

| | 传统 skill | 本框架（原型库） |
|---|---|---|
| 来源 | 人预先写死 (触发→固定步骤) | 从经验**自己长出**（遇到没原型能解释的情形当场新建 = 自己写 skill） |
| 泛化 | 只在预想情形命中 | 新情形可由已有原型**内插/外推** |
| 仲裁 | 硬触发，易误派发 | 多原型竞争由全局工作空间按相似度+置信**协调** |
| 中途变性 | 一旦派发**锁死** | 靠惊讶**当场察觉并切换原型**（实验 E3：可切换 54.8% vs 锁死 42.5%，+12.3%） |

一个原型 = `{protoFeat:情形质心, 仿射读出 critEst(x), conf, predErr, n}`，就是"被压缩成直觉的 skill"。

---

## 5. 已验证的证据（sim + 真实 LLM）

- **E1** 自模型 57.0% ≈ 预设 skill 61.3%（打平，自己长出的≈人写的）
- **E2** 新 regime：自模型 48.5% vs skill 12.5%（**3.9×**，skill 在没预想的情形里崩）
- **E3** 任务中途变性：可切换 54.8% vs 锁死 42.5%（**+12.3%**，竞争-协调最强证据）
- **真实 claude-opus**：12 易题 省 59%；混合 23 题 省 69.2%，全部 100% 成功（Pareto 占优）

---

## 6. MCP 接入

### 6.1 这是什么

`server.mjs` 是一个**零依赖**的 stdio JSON-RPC 2.0 MCP 服务（不依赖 `@modelcontextprotocol/sdk`，
因为本环境常拉不下来）。任何 MCP 客户端（Claude Desktop / Cursor / VS Code / 自研 agent）都能调度。

### 6.2 在客户端注册

```jsonc
{
  "mcpServers": {
    "conscious-scheduler": {
      "command": "node",
      "args": [
        "c:/Users/82463/Documents/Codex/2026-05-28/new-chat/platform-prototype/workbench/beta-mesoscale/mcp/server.mjs"
      ]
    }
  }
}
```

### 6.3 工具一览

| 工具 | 何时调用 | 关键参数 |
|---|---|---|
| `open_session` | 开局 | `sessionId`, `namespace`（同 namespace=累积/共享技能） |
| `new_task` | 每个任务开始 | `sessionId`（重置上下文污染，保留原型库与 μ） |
| `decide_step` | **每一步决策前** | `criticality_hint / difficulty_hint / progress / context_pollution`（都 0~1） |
| `report_outcome` | 每一步做完后 | `observed_criticality`, `used_system2`（核据此自学） |
| `task_feedback` | 整任务结束 | `success`（调 μ + 自动持久化） |
| `get_stats` / `dump_prototypes` | 审计 | — |
| `close_session` | 收尾 | 持久化技能 |

`decide_step` 返回：`mode: "system1" | "system2"` + `criticality_estimate / threshold / familiarity / surprise / confidence / mu`。

### 6.4 任意 agent 的典型用法（伪代码）

```text
open_session(sessionId, namespace="python-coding")
for task in tasks:
    new_task(sessionId)
    pollution = 0
    while not done:
        # 调用方自己算这 4 个通用量（每个 loop 都能算）
        d = decide_step(sessionId, criticality_hint, difficulty_hint, progress, pollution)
        if d.mode == "system2":
            result = 强模型 / best-of-N / 深推理     # 贵但稳
            pollution += 0.15
        else:
            result = 便宜模型 / 单次生成              # 省
            pollution += 0.04
        report_outcome(sessionId, observed_criticality=…, used_system2=(d.mode=="system2"))
    task_feedback(sessionId, success=task_passed)
```

`context_pollution` 推荐用真实量：`已用 token / 上下文窗口`。

### 6.5 自检

```powershell
node beta-mesoscale/mcp/server.mjs    # 直接起服务（stdin 等 JSON-RPC）
node beta-mesoscale/mcp/smoke.mjs     # 起客户端跑完整握手+多步任务+持久化验证
```

`smoke.mjs` 期望看到：训练几轮后关键步收敛到 `S2`、普通步 `s1`，且 reopen 同 namespace 能 `loadedPrototypes>0`。

---

## 7. 诚实边界

- 这是**研究原型**，不是生产组件；超参经小规模标定，换领域需重标。
- "意识"是功能性比喻，不主张现象学意识。
- 真实 LLM 上点燃次数可能为 0：当底座模型对独立任务足够强时，"升级阶梯"已能兜底，**上游点燃用不上**——
  框架的优势在**长程多步 / 任务中途变性 / 弱模型**三类场景最明显（见 E2/E3）。
