# Metacognitive Compute Scheduler

> An MCP (Model Context Protocol) service that decides **how much compute each step of an agent deserves** — cheap intuition (System 1) or expensive deliberation (System 2) — and learns that judgment from experience instead of hand-written rules.
>
> 一个 MCP 工具：它不决定"做什么步骤"，只决定"**这一步该用多大算力**"——便宜糊弄（System 1）还是停下来深想（System 2）。而且这个判断是从经验里自己长出来的，不是写死的规则。

Zero-dependency Node.js (ESM). Works with any MCP client (Claude Desktop / Cursor / VS Code / your own agent loop).

> 中文算法详解见 [`ALGORITHM_zh.md`](ALGORITHM_zh.md)。

![overview](figures/overview.png)

---

## 1. What it is / 是什么

Every agent running a long-horizon task is implicitly answering, at every step:

> *"Can I get away with a cheap model / single shot here, or must I stop and think hard (strong model / best-of-N / deep reasoning)?"*

Most frameworks do one of two bad things:

- **Always full power** — expensive, and it keeps polluting the context window.
- **Hand-written skill triggers** (`if files > 12 then think_hard`) — they miss unforeseen cases and lock up when the task changes mid-flight.

This project pulls that *"how much effort"* decision out into a **separate, learnable service**. It is **orthogonal** to *"what to do"*: keep your planner/skills, just ask this service one question per step — *System 1 or System 2?*

这件事独立成一个所有 agent 都能调用的服务，与"做什么"正交。你照常用你的 planner，只在每步问它一句。

---

## 2. How it works / 怎么工作

```
open_session(namespace)                  ← reuse skills accumulated under this namespace
for each task:
    new_task(sessionId)                  ← reset context pollution; keep prototypes & μ
    for each step:
        d = decide_step(criticality_hint, difficulty_hint, progress, context_pollution)
        if d.mode == "system2":  result = strong model / best-of-N   (expensive, robust)
        else:                    result = cheap model / single shot  (frugal)
        report_outcome(observed_criticality, used_system2)           ← the core self-learns
    task_feedback(success)               ← updates μ + persists skills
```

The caller only ever computes four task-agnostic scalars (all in `[0,1]`):

| signal | meaning | typical source |
|---|---|---|
| `criticality_hint` | how pivotal this step looks | planner heuristic |
| `difficulty_hint` | how hard this step looks | input size / complexity |
| `progress` | position in the task | step index / total |
| `context_pollution` | how dirty the context is | used tokens / window |

---

## 3. The principle / 原理：one "ignition" = one auction

Each step is a competition between two mechanisms, coordinated by a shadow price `μ`. This is the EMMS *"compromise in competition"* idea (Li Jinghai) mapped onto the System 1 / System 2 boundary.

**Step 1 — attention focus** (find the most similar prototype in the self-grown library):

$$\mathrm{sim} = \max_{p}\exp\!\Big(-\frac{\lVert x - \mathrm{protoFeat}_p\rVert^2}{2\tau}\Big),\qquad \mathrm{surprise} = 1-\mathrm{sim}$$

**Step 2 — two mechanisms bid:**

- The **robust** mechanism (System 2) wants to ignite; its gain rises with *"likely critical × uncertain"*:

$$\mathrm{robGain} = \mu\,(0.5 + \hat c)\,u,\qquad u = \mathrm{predErr}\,(2-\mathrm{sim})$$

- The **economy** mechanism (System 1) wants to save; its cost = fixed consult cost + context-pollution penalty (the dirtier the context, the less you should think more — avoids *"the more it thinks, the more lost it gets"*):

$$\mathrm{ecoCost} = c + \lambda\,\rho$$

**Step 3 — coordinate & decide:**

$$\boxed{\ \mathrm{ignite} = (\text{library empty}) \ \lor\ (\mathrm{robGain} > \mathrm{ecoCost}) \ \lor\ \mathrm{regimeShift}\ }$$

- empty library → must ignite (no schema to lean on);
- `regimeShift`: if the active prototype no longer matches mid-task (`sim < 0.7`) → forced re-examination → switch prototype. **This is where loop-level metacognition shines.**

The coordination variable **μ is a shadow price** (the KKT dual variable). It self-tunes via a stability condition: **fail → μ↑ (more cautious), succeed → μ↓ (more frugal).**

![bidding](figures/fig4_bidding.png)

A prototype = `{protoFeat: situation centroid, affine read-out ĉ(x), self-calibration predErr, count}` — essentially **a skill compressed into intuition**.

---

## 4. Why this can replace hand-written skills / 为什么能替代 skill

| | hand-written skill | this (prototype library) |
|---|---|---|
| origin | a human writes it (trigger → fixed steps) | **grows from experience** (unexplained situation → new prototype = writes its own skill) |
| generalization | only fires on foreseen cases | new cases via **inter/extrapolation** of existing prototypes |
| arbitration | hard trigger, easy to misfire | multiple prototypes **coordinated** by similarity + confidence |
| mid-task change | **locks up** once dispatched | **detects via surprise and switches prototype** on the fly |

---

## 5. Evidence / 证据

All figures use Times New Roman, 300 dpi. Reproduce with `figures/gen_fig_data.mjs` + `figures/make_figures.py`.

### 5.1 Long-horizon task with mid-task regime shift (60 tasks × 8 steps)

The task switches rule at task 30 (regime A → B, the hint→criticality mapping reverses). Cost model: cheap = 1, deep = 5; mishandling a critical step = wasted cheap try + forced upgrade (1+5); deep on a non-critical step = over-thinking (wastes 4).

| arm | total cost | save | mishandled | over-thinking |
|---|---|---|---|---|
| always-System2 | 2400 | 0% | 0 | 270 |
| static-skill | 1813 | 24.5% | 117 | 94 |
| **conscious (ours)** | **1658** | **30.9%** | **102** | **59** |

> Ours is cheaper than both baselines, with fewer mishandles than the static rule **and** far less over-thinking than always-on. (The MCP-tuned variant in `complexTask.mjs` reaches 39.1% savings.)

![arm cost](figures/fig1_arm_cost.png)

### 5.2 It gets smarter with experience / 越学越聪明

The mishandle rate drops over task batches; after the mid-task regime shift it spikes then **self-recovers** as the core detects the change and re-fits its prototypes. The shadow price μ converges to an interior fixed point.

![learning](figures/fig2_learning.png) ![mu](figures/fig3_mu_trace.png)

### 5.3 The killer experiment — mid-task rule shift (τ-bench-style, 30 seeds)

Post-shift decision accuracy (deliberation ↔ true criticality alignment):

| arm | post-shift accuracy |
|---|---|
| static-skill (frozen threshold) | 52.4 ± 5.1% |
| router-frozen | 55.6 ± 9.0% |
| router-online (still learning at test) | 57.3 ± 3.4% |
| **conscious (ours)** | **62.5 ± 2.6%** |

Paired t-test, ours vs router-online: Δ = 5.2 pt, **p = 7.5e-15**, Cohen's d = 1.43, win-rate 93%.

> A single global threshold (skill/router) **cannot express a piecewise rule and cannot notice the switch**. The scheduler ignites on surprise and switches prototypes online → significantly higher post-shift accuracy. This is the core selling point for long-horizon / mid-task-shift tasks.

![shift accuracy](figures/fig5_shift_acc.png)

---

## 6. Novelty / 创新性 (honest positioning)

What genuinely stands up at review:

1. **A metacognitive compute layer orthogonal to "what to do".** FrugalGPT does static routing, Reflexion is post-hoc, Voyager is still skills, RouteLLM has no shift-detection and no pollution-in-cost. Nobody makes *"how much compute"* an independent, learnable, MCP-exposed service driven by four task-agnostic signals.
2. **Online regime-shift detection + prototype switching.** `sim < 0.7` forces re-examination; the system adapts mid-task where frozen thresholds lock up (Section 5.3, +5–10 pt, all p < 0.001).
3. **Context pollution enters the decision cost.** *"The more you think, the messier it gets → the less you should think more."* Most frameworks ignore this; here it is a first-class term `ecoCost = c + λρ`.

Honest boundaries:

- This is a **research prototype**, not a production component; hyper-parameters are calibrated at small scale.
- *"Conscious"* is a **functional** metaphor (GWT ignition + AST self-model + metacognition). **No claim of phenomenal consciousness.**
- On a strong base model (e.g. Opus), the upstream ignition is rarely needed — the upgrade ladder already covers it. The advantage is clearest in **long-horizon / mid-task-shift / weak-model-or-expensive-token** regimes.

---

## 7. Scientific anchors / 科学锚点

| concept | source | role here |
|---|---|---|
| Dual process (System 1 / System 2) | Kahneman | system1 = cheap intuition; system2 = deliberation (pollutes context) |
| Global Workspace + ignition | Baars / Dehaene (GWT) | surprise over threshold → global broadcast → invoke System 2 |
| Attention Schema | Graziano (AST) | maintains a self-state `z` (active prototype / recent surprise / caution) |
| Compromise in competition (EMMS) | Li Jinghai | economy vs robustness, two conflicting extremals coordinated by shadow price μ |

---

## 8. Install & run / 安装与使用

Requires Node.js ≥ 18. No build, no dependencies.

### 8.1 Register in an MCP client

```jsonc
{
  "mcpServers": {
    "conscious-scheduler": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/server.mjs"]
    }
  }
}
```

### 8.2 Tools

| tool | when | key params |
|---|---|---|
| `open_session` | at start | `sessionId`, `namespace` |
| `new_task` | each task start | `sessionId` (resets pollution, keeps prototypes & μ) |
| `decide_step` | **before every step** | `criticality_hint / difficulty_hint / progress / context_pollution` (all 0–1) |
| `report_outcome` | after every step | `observed_criticality`, `used_system2` |
| `task_feedback` | task end | `success` (tunes μ + persists) |
| `get_stats` / `get_calibration` / `dump_prototypes` | audit | — |
| `close_session` | end | persists skills |

`decide_step` returns: `mode: "system1" | "system2"`, plus `criticality_estimate / threshold / familiarity / surprise / confidence / mu / rob_gain / eco_cost / regime_shift / suggest_compact`.

### 8.3 Self-checks

```powershell
node server.mjs            # start the service (waits for JSON-RPC on stdin)
node smoke.mjs            # full handshake + multi-round task + persistence check
node complexTask.mjs       # long-horizon 3-arm comparison
node answerTests.mjs       # "does it get smarter / generalize / manage pollution" tests
```

### 8.4 Reproduce the figures

```powershell
node figures/gen_fig_data.mjs                          # -> fig_data.json
$env:PYTHONNOUSERSITE="1"                               # isolate user site-packages (numpy clash)
python figures/make_figures.py                          # -> *.png (Times New Roman, 300 dpi)
```

---

## 9. Repository layout / 目录结构

```
server.mjs          zero-dep stdio JSON-RPC 2.0 MCP server (8 tools)
consciousCore.mjs   session management + persistence + calibration
selfModel.mjs       the scheduler core (decideAbstract / learnAbstract / feedback)
smoke.mjs           full MCP handshake + persistence self-check
complexTask.mjs     long-horizon 3-arm comparison (drives the real MCP transport)
answerTests.mjs     "smarter / general / pollution" question tests
ALGORITHM_zh.md     full Chinese algorithm write-up
store/              persisted prototype libraries (per namespace)
figures/
  gen_fig_data.mjs  collects all figure data -> fig_data.json
  make_figures.py   publication-quality plots (Times New Roman, 300 dpi)
  *.png             generated figures
```

---

## 10. License

MIT. *"Conscious" is used as a functional metaphor only; no claim of phenomenal consciousness is made.*
