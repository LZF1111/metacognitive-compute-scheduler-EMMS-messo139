# 元认知算力调度器 (Metacognitive Compute Scheduler)

> 一个 MCP（Model Context Protocol）工具：它不决定"做什么步骤"，只决定"**这一步该用多大算力**"——便宜糊弄（System 1 直觉）还是停下来深想（System 2 深思）。而且这个判断是从经验里自己长出来的，不是写死的规则。

零依赖 Node.js（ESM）。任何 MCP 客户端都能用（Claude Desktop / Cursor / VS Code / 你自己的 agent loop）。

> 🌏 **English version: [`README.en.md`](README.en.md)** · 完整中文算法详解：[`ALGORITHM_zh.md`](ALGORITHM_zh.md)

![overview](figures/overview.png)

---

## 1. 是什么

任何跑长程任务的 agent，每一步其实都在隐式回答一个问题：

> *"这一步我用便宜模型/单次生成糊弄过去就行，还是必须停下来认真想（强模型 / best-of-N / 深推理）？"*

主流框架往往做两件不好的事：

- **全程满力**——又贵，还把上下文窗口越塞越脏。
- **人写死的 skill 硬触发**（`if 文件数 > 12 就深想`）——预想不到的情形会漏判，任务中途变性就锁死。

本项目把"用多大力气"这个决策**独立成一个可学习的服务**。它与"做什么"**正交**：你照常用你的 planner/skill，只在每步问它一句——*System 1 还是 System 2？*

---

## 2. 怎么工作

```
open_session(namespace)                  ← 复用该 namespace 下已积累的技能
for each task:
    new_task(sessionId)                  ← 重置上下文污染；保留原型库与 μ
    for each step:
        d = decide_step(criticality_hint, difficulty_hint, progress, context_pollution)
        if d.mode == "system2":  result = 强模型 / best-of-N   （贵、稳）
        else:                    result = 便宜模型 / 单次生成  （省）
        report_outcome(observed_criticality, used_system2)           ← 调度核自学
    task_feedback(success)               ← 更新 μ + 持久化技能
```

调用方只需算四个与领域无关的标量（都在 `[0,1]`）：

| 信号 | 含义 | 典型来源 |
|---|---|---|
| `criticality_hint` | 这一步看起来有多关键 | planner 启发式 |
| `difficulty_hint` | 这一步看起来有多难 | 输入规模 / 复杂度 |
| `progress` | 在任务中的位置 | 步数 / 总步数 |
| `context_pollution` | 上下文有多脏 | 已用 token / 窗口 |

---

## 3. 设计哲学：怎么做到又快又准

通常的假设是**速度与准确率不可兼得**：求快（便宜）就丢准；求准就得慢/贵。本调度器的核心主张是：**在长程任务上这个取舍是个伪命题**——你可以同时更快*且*更准，因为"浪费"和"出错"其实来自**同一个病根**：对每一步都花同样多的算力。

### 3.1 为什么"每步一样使劲"两头都输

| 失败模式 | 代价 | 谁会犯 |
|---|---|---|
| 简单步**过度深思** | 浪费 token/时间 → **又慢又贵** | 全程满力 |
| 关键步**深思不足** | 答错 → 必须重做 → **又慢又错** | 全程便宜 |
| **冻结的阈值** | 一开始对，任务一变就持续误判 | 写死的 skill / 静态路由 |
| **在脏上下文里深思** | 模型*越想越乱*而非更清楚 → **又慢又错** | 所有忽略上下文污染的人 |

点睛句：过度深思伤的是**速度**，深思不足伤的是**准确率**，而它们是**同一个决策朝两个方向做错**。把这个决策做对，快和准就一起变好。

### 3.2 让"又快又准"成立的三个设计动作

1. **把算力花在刀刃上（准而不浪费）。** 便宜步走 System 1，关键步走 System 2。既不再把深思浪费在简单步上（→更快），也不再亏待真正决定成败的步（→更准）。这就是 §4 的 EMMS 竞争中协调：经济与稳健逐步竞价，而非一个全局档位。

2. **保持上下文干净（省出来的是准）。** 每次深思都会污染上下文窗口；脏上下文让*后续*步又慢又容易错（"越想越乱"）。把污染计入代价（`ecoCost = c + λρ`），调度器就**更少但更准时地**深思，上下文保持干净，长程后段准确率不塌。这里的"省"不只是便宜，而是**直接保护了长任务的准确率**。

3. **察觉任务变了（让"准"持续）。** 写死的规则只在任务不变时准，一旦任务中途变性就默默持续误判。调度器盯着**惊讶**；当活跃原型中途不再匹配（`sim < 0.7`）就点燃、重审、切换原型——*在线*恢复准确率，而不是锁死。

### 3.3 一句话

> 快，来自**不在简单步上过度深思、并保持上下文干净**；准，来自**把深思留给决定成败的步、并在任务变性时重审**——而因为两者是同一个逐步决策，把它做对就让快与准朝*同一个*方向移动。§7 的证据正是如此：成本更低**且**误判的关键步更少，二者同时达成。

---

## 4. EMMS 是什么，到底用在了哪里

**这一节专门讲清楚最容易看不懂的地方。**

### 4.1 一段话讲清 EMMS

EMMS（能量最小化多尺度，李静海）研究的是这样一类系统：**两个相互对立的"主导机制"竞争、谁也无法独占**——比如气固两相流里，流体倾向**最小化阻力**（机制 A），颗粒倾向**最小化势能**（机制 B）。系统**不会**停在两者的温吞平均，而是达到一种**"竞争中的协调"**：两个极端倾向共存，由一个**稳定性条件**居中裁决。这个稳定性条件在数学上等价于**带影子价（拉格朗日/KKT 对偶变量）的约束优化**——影子价给"冲突"定价，从而定出工作点。

### 4.2 在本调度器里的精确对应

我们把 EMMS 的两个竞争机制，搬到 **System 1 / System 2 的边界**上。每一步，两个机制出价竞争：

| EMMS 概念 | 气固流类比 | **在本调度器里** |
|---|---|---|
| 机制 A — 经济（省） | 流体最小化阻力 | **System 1**：用便宜模型、单次生成、不污染上下文 |
| 机制 B — 稳健（稳） | 颗粒最小化势能 | **System 2**：点燃深推理 / best-of-N，花 token，但更安全 |
| 冲突 | A 要流动，B 要有序 | 想得越多**越稳但越污染上下文**——两者不可兼得 |
| 影子价 **μ** | 给 A↔B 的折中定价 | **谨慎度旋钮**：μ 高→更爱点燃（谨慎）；μ 低→更省（节俭） |
| 稳定性条件 | 定出工作点 | μ 随任务结果自更新：**失败→μ↑，成功→μ↓** |
| 竞争中的协调 | 异质共存（不是平均） | 逐步上，**有的步走便宜，有的步走深思**——不是固定的全局阈值 |

这里复用的 EMMS 核心洞见是：**单一的全局平均/阈值是错的。** 就像气固流拒绝均匀化，好的调度器也拒绝把每一步都设成同一个算力档——它让"省"和"稳"在*每一步*上较量，由 μ 协调。

### 4.3 它落在代码哪里

| EMMS 量 | 符号 | 代码位置 |
|---|---|---|
| 稳健出价（System 2 收益） | `robGain` | `selfModel.mjs` → `decideAbstract()` |
| 经济出价（System 1 代价） | `ecoCost` | `selfModel.mjs` → `decideAbstract()` |
| 竞争裁决 | `ignite = robGain > ecoCost` | `selfModel.mjs` → `decideAbstract()` |
| 影子价更新（稳定性条件） | `μ` | `selfModel.mjs` → `feedback()` |

`decide_step` 会把这些量原样返回（`rob_gain` / `eco_cost` / `mu` / `regime_shift`），你能实时看到这场 EMMS 竞价。**总览图里的图 (e) 画的就是这场竞价**：每个点是某一步的 `(ecoCost, robGain)`，对角线就是协调边界 `robGain = ecoCost`。

---

## 5. 原理公式：一次"点燃" = 一场竞价

每一步就是一场 §4 描述的 EMMS 竞价，用公式写出来如下。

**第一步——注意力聚焦**（在自己长出来的原型库里找最像的）：

$$\mathrm{sim} = \max_{p}\exp\!\Big(-\frac{\lVert x - \mathrm{protoFeat}_p\rVert^2}{2\tau}\Big),\qquad \mathrm{surprise} = 1-\mathrm{sim}$$

**第二步——两个机制竞价：**

- **稳健**机制（System 2）想点燃；它的收益随"可能关键 × 没把握"上升：

$$\mathrm{robGain} = \mu\,(0.5 + \hat c)\,u,\qquad u = \mathrm{predErr}\,(2-\mathrm{sim})$$

- **经济**机制（System 1）想省；它的代价 = 固定深审成本 + 上下文污染惩罚（上下文越脏越不该再深想）：

$$\mathrm{ecoCost} = c + \lambda\,\rho$$

**第三步——协调裁决：**

$$\boxed{\ \mathrm{ignite} = (\text{原型库为空}) \ \lor\ (\mathrm{robGain} > \mathrm{ecoCost}) \ \lor\ \mathrm{regimeShift}\ }$$

- 库空必点燃（无图式可依）；
- `regimeShift`：任务中途活跃原型不再匹配（`sim < 0.7`）→ 强制重审 → 切换原型。**这是 loop 级元认知最该发光的地方。**

协调变量 **μ 是影子价**（KKT 对偶变量），靠稳定性条件自调：**失败→μ↑（更谨慎），成功→μ↓（更省）。**

![bidding](figures/fig4_bidding.png)

一个原型 = `{protoFeat: 情形质心, 仿射读出 ĉ(x), 自校准 predErr, 出现次数}`，本质就是**被压缩成直觉的 skill**。

---

## 6. 为什么能替代写死的 skill

| | 写死的 skill | 本框架（原型库） |
|---|---|---|
| 来源 | 人预先写死（触发→固定步骤） | **从经验自己长出**（没有原型能解释的情形→新建原型=自己写 skill） |
| 泛化 | 只在预想情形命中 | 新情形可由已有原型**内插/外推** |
| 仲裁 | 硬触发，易误派发 | 多原型按相似度+置信**协调** |
| 中途变性 | 一旦派发**锁死** | 靠惊讶**当场察觉并切换原型** |

---

## 7. 证据

所有图用 Times New Roman、300 dpi。用 `figures/gen_fig_data.mjs` + `figures/make_figures.py` 复现。

### 7.1 长程任务 + 中途变性（60 任务 × 8 步）

任务在第 30 个时切换规则（regime A → B，hint→关键度的映射反转）。代价模型：便宜=1，深思=5；误判关键步=浪费一次便宜尝试+强制升级（1+5）；非关键步深思=过度深思（浪费 4）。

| 臂 | 总成本 | 省 | 误判 | 过度深思 |
|---|---|---|---|---|
| always-System2 | 2400 | 0% | 0 | 258 |
| static-skill | 1884 | 21.5% | 128 | 97 |
| **conscious（本文）** | **1617** | **32.6%** | **93** | **39** |

> 本文比两个 baseline 都便宜，误判比静态规则少**且**过度深思远少于全程满力。在**成本敏感**目标下（误判关键步的惩罚重于过度深思），调度核靠比较期望成本来点燃，而不是去追一个校准代理指标。

![arm cost](figures/fig1_arm_cost.png)

### 7.2 越学越聪明

误判率随任务批次下降；中途变性后会先飙升再**自行恢复**——调度核察觉到变化并重新拟合原型。影子价 μ 收敛到内点不动点。

![learning](figures/fig2_learning.png) ![mu](figures/fig3_mu_trace.png)

### 7.3 杀手实验——任务中途规则突变（τ-bench 式，30 seed）

突变后半段决策准确率（深思 ↔ 真关键度的对齐）：

| 臂 | 突变后准确率 |
|---|---|
| static-skill（冻结阈值） | 52.4 ± 5.1% |
| router-frozen | 55.6 ± 9.0% |
| router-online（评测仍在线学） | 57.3 ± 3.4% |
| **conscious（本文）** | **61.3 ± 2.4%** |

配对 t 检验，本文 vs router-online：Δ = 4.0 pt，**p = 2.8e-14**，Cohen's d = 1.40，胜率 90%。

> 单一全局阈值（skill/router）**既无法表达分段规律，也察觉不到切换**。调度器靠惊讶点燃、在线切换原型 → 突变后准确率显著更高。这是长程 / 中途变性任务的核心卖点。

![shift accuracy](figures/fig5_shift_acc.png)

---

## 8. 创新性（诚实定位）

经得起审稿的真创新：

1. **与"做什么"正交的元认知算力层。** FrugalGPT 是静态路由，Reflexion 是事后，Voyager 还是 skill，RouteLLM 没有变性侦测、也没把污染计入代价。没人把*"用多大算力"*做成一个独立、可学、用四个领域无关信号驱动、且通过 MCP 暴露的服务。
2. **在线变性侦测 + 原型切换。** `sim < 0.7` 强制重审；在冻结阈值锁死的地方它能中途适应（§7.3，+5–10 pt，全部 p < 0.001）。
3. **上下文污染进入决策代价。** *"越想越乱 → 越不该再想。"* 多数框架忽略这点，这里它是一等公民项 `ecoCost = c + λρ`。

诚实边界：

- 这是**研究原型**，不是生产组件；超参经小规模标定。
- *"意识"*是**功能性**比喻（GWT 点燃 + AST 自我模型 + 元认知），**不主张现象学意识**。
- 底座很强时（如 Opus）上游点燃很少用得上——升级阶梯已能兜底。优势最明显的场景是**长程 / 中途变性 / 弱模型或贵 token**。

---

## 9. 科学锚点

| 概念 | 来源 | 在这里的含义 |
|---|---|---|
| 双过程（System 1 / System 2） | Kahneman | system1=便宜直觉；system2=深思（会污染上下文） |
| 全局工作空间 + 点燃 | Baars / Dehaene (GWT) | 惊讶超阈值 → 全局广播 → 调动 System 2 |
| 注意力图式 | Graziano (AST) | 维护自我状态 `z`（活跃原型 / 近期惊讶 / 谨慎度） |
| 竞争中的协调（EMMS） | 李静海 | 经济 vs 稳健两个冲突极值，由影子价 μ 协调 |

---

## 10. 安装与使用

需要 Node.js ≥ 18。无需构建，零依赖。

### 10.1 在 MCP 客户端注册

```jsonc
{
  "mcpServers": {
    "conscious-scheduler": {
      "command": "node",
      "args": ["/绝对路径/server.mjs"]
    }
  }
}
```

### 10.2 工具一览

| 工具 | 何时调用 | 关键参数 |
|---|---|---|
| `open_session` | 开局 | `sessionId`、`namespace` |
| `new_task` | 每个任务开始 | `sessionId`（重置污染，保留原型库与 μ） |
| `decide_step` | **每一步决策前** | `criticality_hint / difficulty_hint / progress / context_pollution`（都 0–1） |
| `report_outcome` | 每一步做完后 | `observed_criticality`、`used_system2` |
| `task_feedback` | 整任务结束 | `success`（调 μ + 持久化） |
| `get_stats` / `get_calibration` / `dump_prototypes` | 审计 | — |
| `close_session` | 收尾 | 持久化技能 |

`decide_step` 返回：`mode: "system1" | "system2"`，外加 `criticality_estimate / threshold / familiarity / surprise / confidence / mu / rob_gain / eco_cost / regime_shift / suggest_compact`。

### 10.3 自检

```powershell
node server.mjs            # 起服务（在 stdin 等 JSON-RPC）
node smoke.mjs             # 完整握手 + 多轮任务 + 持久化验证
node complexTask.mjs       # 长程三臂对比
node answerTests.mjs       # "越学越聪明 / 泛化 / 污染治理"三问测试
```

### 10.4 复现图表

```powershell
node figures/gen_fig_data.mjs                          # -> fig_data.json
$env:PYTHONNOUSERSITE="1"                              # 隔离用户 site-packages（避开 numpy 冲突）
python figures/make_figures.py                          # -> *.png（Times New Roman, 300 dpi）
```

---

## 11. 目录结构

```
server.mjs          零依赖 stdio JSON-RPC 2.0 MCP 服务（8 工具）
consciousCore.mjs   会话管理 + 持久化 + 校准
selfModel.mjs       调度核（decideAbstract / learnAbstract / feedback）
smoke.mjs           完整 MCP 握手 + 持久化自检
complexTask.mjs     长程三臂对比（走真实 MCP 传输层）
answerTests.mjs     "越学越聪明 / 泛化 / 污染"三问测试
README.en.md        英文 README
ALGORITHM_zh.md     完整中文算法详解
store/              持久化的原型库（按 namespace）
figures/
  gen_fig_data.mjs  采集全部出图数据 -> fig_data.json
  make_figures.py   出版级绘图（Times New Roman, 300 dpi）
  *.png             生成的图
```

---

## 12. 许可

MIT。*"意识"仅作功能性比喻，不主张现象学意识。*
