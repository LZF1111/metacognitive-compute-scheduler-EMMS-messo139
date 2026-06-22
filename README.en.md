# Metacognitive Compute Scheduler

> An MCP (Model Context Protocol) service that decides **how much compute each step of an agent deserves** — cheap intuition (System 1) or expensive deliberation (System 2) — and learns that judgment from experience instead of hand-written rules.

Zero-dependency Node.js (ESM). Works with any MCP client (Claude Desktop / Cursor / VS Code / your own agent loop).

> 🌏 **中文版见 [`README.zh.md`](README.zh.md)** · Full Chinese algorithm write-up: [`ALGORITHM_zh.md`](ALGORITHM_zh.md)

![overview](figures/overview.png)

---

## 1. What it is

Every agent running a long-horizon task is implicitly answering, at every step:

> *"Can I get away with a cheap model / single shot here, or must I stop and think hard (strong model / best-of-N / deep reasoning)?"*

Most frameworks do one of two bad things:

- **Always full power** — expensive, and it keeps polluting the context window.
- **Hand-written skill triggers** (`if files > 12 then think_hard`) — they miss unforeseen cases and lock up when the task changes mid-flight.

This project pulls that *"how much effort"* decision out into a **separate, learnable service**. It is **orthogonal** to *"what to do"*: keep your planner/skills, just ask this service one question per step — *System 1 or System 2?*

---

## 2. How it works

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

## 3. Design philosophy: how it is both fast AND accurate

The usual assumption is a **speed–accuracy trade-off**: go fast (cheap) and you lose accuracy; stay accurate and you pay (slow/expensive). This scheduler's whole point is that **for long-horizon tasks the trade-off is false** — you can be faster *and* more accurate at the same time, because the waste and the errors come from the **same root cause**: spending the same amount of compute on every step.

### 3.1 Why "same compute everywhere" loses on both axes

| failure mode | what it costs | who suffers from it |
|---|---|---|
| **over-thinking** an easy step | wasted tokens/time → **slow & expensive** | always-full-power |
| **under-thinking** a critical step | wrong answer → must redo → **slow & wrong** | always-cheap |
| **a frozen threshold** | right at first, then the task changes and it keeps misfiring | hand-written skill / static router |
| **deep-thinking on a dirty context** | the model gets *more* lost, not less → **slow & wrong** | everyone who ignores context pollution |

The punchline: over-thinking hurts **speed**, under-thinking hurts **accuracy**, and they are the *same decision made wrong in opposite directions*. Fix the decision and both improve together.

### 3.2 The three design moves that buy "fast AND accurate"

1. **Spend compute where it pays (accuracy without waste).** Cheap steps go System 1, pivotal steps go System 2. You stop wasting deliberation on easy steps (→ faster) *and* stop starving the steps that actually decide success (→ more accurate). This is the EMMS *compromise in competition* (§4): economy and robustness bid per step instead of one global setting.

2. **Keep the context clean (speed compounds into accuracy).** Every deep call pollutes the context window; a dirty context makes *later* steps both slower and more error-prone (*"the more it thinks, the more lost it gets"*). By pricing pollution into the cost (`ecoCost = c + λρ`), the scheduler thinks deeply *less often but at the right moments*, so the context stays clean and late-task accuracy holds up. Frugality here is not just cheaper — it directly **protects accuracy on long tasks**.

3. **Notice when the task changes (stay accurate over time).** A frozen rule is accurate only until the task shifts, then it silently keeps misfiring. The scheduler watches **surprise**; when the active prototype stops matching mid-task (`sim < 0.7`) it ignites, re-examines, and switches prototype — recovering accuracy *online* instead of locking up.

### 3.3 In one sentence

> Fast comes from **not over-thinking easy steps and keeping the context clean**; accurate comes from **reserving deliberation for the steps that decide success and re-examining when the task changes** — and because both are the same per-step decision, optimizing it moves speed and accuracy in the *same* direction. The evidence in §7 shows exactly this: lower cost **and** fewer mishandled critical steps at once.

---

## 4. What is EMMS, and exactly where is it used here

**This is the part people find confusing, so read this first.**

### 4.1 EMMS in one paragraph

EMMS (Energy-Minimization Multi-Scale, Li Jinghai) studies systems where **two opposing "dominant mechanisms" compete and never fully win** — e.g. in gas–solid flow, the fluid tends to **minimize resistance** (mechanism A) while particles tend to **minimize potential energy** (mechanism B). The system does **not** settle on a bland average of the two; instead it reaches a **"compromise in competition"**: the two extremal tendencies coexist, mediated by a **stability condition**. Mathematically that stability condition behaves like a **constrained optimization with a shadow price** (a Lagrange/KKT dual variable) that prices the conflict and pins down the operating point.

### 4.2 The exact mapping onto this scheduler

We map EMMS's two competing mechanisms onto the **System 1 / System 2 boundary**. At every step, two mechanisms bid:

| EMMS concept | gas–solid analogy | **in this scheduler** |
|---|---|---|
| Mechanism A — economy | fluid minimizes resistance | **System 1**: use the cheap model, single shot, don't pollute context |
| Mechanism B — robustness | particles minimize potential energy | **System 2**: ignite deep reasoning / best-of-N, pay tokens, but be safe |
| Conflict | A wants flow, B wants order | thinking more is **safer but pollutes context** — you can't maximize both |
| Shadow price **μ** | prices the A↔B compromise | **the caution dial**: high μ → ignite more (cautious); low μ → save more (frugal) |
| Stability condition | fixes the operating point | μ self-updates from task outcomes: **fail → μ↑, succeed → μ↓** |
| Compromise in competition | heterogeneous coexistence (not an average) | per-step, **some steps go cheap, some go deep** — not a fixed global threshold |

The key EMMS insight reused here: **a single global average/threshold is wrong.** Just as gas–solid flow refuses to homogenize, a good scheduler refuses to put every step at the same compute level — it lets economy and robustness fight it out *per step*, coordinated by μ.

### 4.3 Where it lives in the code

| EMMS quantity | symbol | code location |
|---|---|---|
| likely-critical probability | `pCrit` | `selfModel.mjs` → `decideAbstract()` |
| expected cost of staying System 1 | `eCostS1` = `μ·pCrit·missPenalty` | `selfModel.mjs` → `decideAbstract()` |
| expected cost of igniting System 2 | `eCostS2` = `consultCost·overThinkCost + (1−pCrit)·overThinkCost + λ·ρ·overThinkCost` | `selfModel.mjs` → `decideAbstract()` |
| competition decision | `ignite = eCostS1 > eCostS2` | `selfModel.mjs` → `decideAbstract()` |
| shadow price update (stability condition) | `μ` | `selfModel.mjs` → `feedback()` |

These exact quantities are returned by `decide_step` as `p_crit`, `e_cost_s1`, `e_cost_s2`, `mu`, `regime_shift` — so the **decision basis you audit is the one that actually drove the choice** (`ignite ⟺ e_cost_s1 > e_cost_s2`). The legacy `rob_gain`/`eco_cost` are still returned for the old bidding figure but are **no longer the mode decision rule**. **Figure (e) in the overview** plots each step's expected-cost comparison; the diagonal is the coordination boundary `eCostS1 = eCostS2`.

---

## 5. The principle in formulas: one "ignition" = one auction

Each step is one EMMS auction (see §4), expressed in formulas.

**Step 1 — attention focus** (find the most similar prototype in the self-grown library):

$$\mathrm{sim} = \max_{p}\exp\!\Big(-\frac{\lVert x - \mathrm{protoFeat}_p\rVert^2}{2\tau}\Big),\qquad \mathrm{surprise} = 1-\mathrm{sim}$$

**Step 2 — price the two outcomes as expected costs:**

First convert the read-out into a **likely-critical probability**, inflating it when the situation is unfamiliar (high `predErr`, low `sim`):

$$\hat p = \mathrm{clip}_{[0,1]}\big(\hat c + \tfrac12\,u\,(1-\hat c)\big),\qquad u = \mathrm{predErr}\,(2-\mathrm{sim})$$

- staying **System 1** risks mishandling a truly-critical step; its expected cost is priced by μ:

$$\mathrm{eCostS1} = \mu\,\hat p\,\,\mathrm{missPenalty}$$

- igniting **System 2** always pays a deep-call cost, wastes effort when the step was *not* critical, and is penalised more when the context is already dirty:

$$\mathrm{eCostS2} = \mathrm{consultCost}\cdot\mathrm{overThinkCost} + (1-\hat p)\,\mathrm{overThinkCost} + \lambda\,\rho\,\mathrm{overThinkCost}$$

**Step 3 — coordinate & decide (pick the cheaper expected outcome):**

$$\boxed{\ \mathrm{ignite} = (\text{library empty}) \ \lor\ (\mathrm{eCostS1} > \mathrm{eCostS2}) \ \lor\ \mathrm{regimeShift}\ }$$

- empty library → must ignite (no schema to lean on);
- `regimeShift`: if the active prototype no longer matches mid-task (`sim < 0.7`) → forced re-examination → switch prototype. **This is where loop-level metacognition shines.**

> **Where the constants come from (honest note).** `missPenalty`, `overThinkCost`, `consultCost` encode *"how much worse is mishandling a critical step than over-thinking an easy one."* In this prototype they are **hand-tuned heuristics** chosen to match the toy cost model (cheap = 1, deep = 5, mishandle = 1 + 5). For a real deployment they must be **re-derived from measured token cost, latency, and your retry/escalation policy** — they are not claimed to be universal. The *direction* of the rule (ignite when the expected cost of staying cheap exceeds the expected cost of thinking) is the contribution; the exact numbers are a calibration knob.

The coordination variable **μ is a shadow price** (the KKT dual variable). It self-tunes via a stability condition: **fail → μ↑ (more cautious), succeed → μ↓ (more frugal).**

![bidding](figures/fig4_bidding.png)

A prototype = `{protoFeat: situation centroid, affine read-out ĉ(x), self-calibration predErr, count}` — essentially **a skill compressed into intuition**.

---

## 6. Why this can replace hand-written skills

| | hand-written skill | this (prototype library) |
|---|---|---|
| origin | a human writes it (trigger → fixed steps) | **grows from experience** (unexplained situation → new prototype = writes its own skill) |
| generalization | only fires on foreseen cases | new cases via **inter/extrapolation** of existing prototypes |
| arbitration | hard trigger, easy to misfire | multiple prototypes **coordinated** by similarity + confidence |
| mid-task change | **locks up** once dispatched | **detects via surprise and switches prototype** on the fly |

---

## 7. Evidence

All figures use Times New Roman, 300 dpi. Reproduce with `figures/gen_fig_data.mjs` + `figures/make_figures.py`.

### 7.1 Long-horizon task with mid-task regime shift (60 tasks × 8 steps, 20 seeds)

The task switches rule at task 30 (regime A → B, the hint→criticality mapping reverses). Cost model: cheap = 1, deep = 5; mishandling a critical step = wasted cheap try + forced upgrade (1+5); deep on a non-critical step = over-thinking (wastes 4).

| arm | total cost | mishandled | over-thinking |
|---|---|---|---|
| always-System2 | 2480 ± 19 | 16 ± 4 | 309 ± 9 |
| static-skill (difficulty ≥ τ) | 1798 ± 44 | 109 ± 9 | 126 ± 9 |
| router-online (p > 0.5) | 1380 ± 61 | 147 ± 10 | 16 ± 8 |
| cost-router (p > 0.8, same features + same cost objective) | **1334 ± 46** | 171 ± 9 | 0 ± 0 |
| **conscious (ours)** | 1590 ± 33 | **74 ± 11** | 79 ± 8 |

> **Honest reading — conscious is *not* the cheapest.** A cost-sensitive logistic router using the *same three features and the same asymmetric cost objective* (deep when `p > 0.8`, the Bayes-optimal threshold for cheap=1/deep=5/miss=6) is the cheapest arm (1334) — but it has the **most critical mishandles (171)** because one global threshold cannot express a piecewise rule that flips mid-task. Conscious spends ~19% more than the cost-router but cuts critical mishandles by **57%** (Δ = −96.8, paired *t*, p < 1e-16, Cohen's d = −12.8, win-rate 100%). It occupies a different point on the **cost-vs-safety Pareto frontier**: when a missed critical step is far costlier than a few extra deep calls, conscious dominates; when raw token cost is all that matters, the cost-router wins. Against the static rule, conscious is both cheaper *and* safer (cost Δ = −208, mishandle Δ = −35, both p < 1e-16).

![arm cost](figures/fig1_arm_cost.png)

*Figure: one representative seed (illustrative). The authoritative statistics are the 20-seed mean ± std in the table above (`mcp/benchSeeds.mjs`).*

### 7.2 It gets smarter with experience

The mishandle rate drops over task batches; after the mid-task regime shift it spikes then **self-recovers** as the core detects the change and re-fits its prototypes. The shadow price μ converges to an interior fixed point.

![learning](figures/fig2_learning.png) ![mu](figures/fig3_mu_trace.png)

### 7.3 The killer experiment — mid-task rule shift (τ-bench-style, 30 seeds)

Post-shift decision accuracy (deliberation ↔ true criticality alignment):

| arm | post-shift accuracy |
|---|---|
| static-skill (frozen threshold) | 52.4 ± 5.1% |
| router-frozen | 55.6 ± 9.0% |
| router-online (still learning at test) | 57.3 ± 3.4% |
| **conscious (ours)** | **59.8 ± 3.3%** |

Paired t-test, ours vs router-online: Δ = 2.5 pt, **p = 4.9e-7**, Cohen's d = 0.93, win-rate 80%. The conscious arm selects power via the **real MCP rule `plan.ignite`** (cost-sensitive `eCostS1 > eCostS2`), not the old criticality-threshold read-out — so this is the *deployed scheduler*, not a proxy. (Reproduce: `node exp_shift.mjs`, 30 seeds.)

> A single global threshold (skill/router) **cannot express a piecewise rule and cannot notice the switch**. The scheduler ignites on surprise and switches prototypes online → significantly higher post-shift accuracy. This is the core selling point for long-horizon / mid-task-shift tasks.

![shift accuracy](figures/fig5_shift_acc.png)

---

## 8. Novelty (honest positioning)

What genuinely stands up at review:

1. **A metacognitive compute layer orthogonal to "what to do".** FrugalGPT does static routing, Reflexion is post-hoc, Voyager is still skills, RouteLLM has no shift-detection and no pollution-in-cost. Nobody makes *"how much compute"* an independent, learnable, MCP-exposed service driven by four task-agnostic signals.
2. **Online regime-shift detection + prototype switching.** `sim < 0.7` forces re-examination; the system adapts mid-task where frozen thresholds lock up (§7.3, +5–10 pt, all p < 0.001).
3. **Context pollution enters the decision cost.** *"The more you think, the messier it gets → the less you should think more."* Most frameworks ignore this; here it is a first-class term `ecoCost = c + λρ`.

Honest boundaries:

- This is a **research prototype**, not a production component; hyper-parameters are calibrated at small scale.
- *"Conscious"* is a **functional** metaphor (GWT ignition + AST self-model + metacognition). **No claim of phenomenal consciousness.**
- **Context pollution is a synthetic model rule, not measured LLM evidence.** In the benchmark, System 2 is *programmatically* made to fail more as `context_pollution` rises (`ecoCost = c + λρ`). This validates that the mechanism behaves as designed *inside the model*, but it is **not** evidence of real long-context degradation in an actual LLM. Confirming the real-world effect requires end-to-end runs on a live model with measured accuracy-vs-context-length.
- The constants (`missPenalty = 6`, `overThinkCost = 4`, `consultCost = 0.1`, threshold `p* = 0.8`) are **hand-set to a stylised cost model**, not fit to a real token/latency/error budget. Different costs move the Pareto point.
- **`p_crit` is a risk score, not a calibrated probability.** It is the read-out criticality inflated toward caution under uncertainty (`clip(ĉ + ½·u·(1−ĉ))`); it is *not* claimed to be calibrated in the statistical sense (a 0.8 score does not mean 80% empirical critical rate).
- **Synthetic environment with oracle labels.** All 20/30-seed results use a synthetic task generator with ground-truth criticality. They show the *mechanism* works under controlled shifts; they are not real-agent-trajectory evidence.
- **The strongest baseline is still pending.** The fair baseline here is a single cost-sensitive logistic router; a tougher one would add **explicit change-point detection** to the cost-sensitive router. That comparison is future work.
- On a strong base model (e.g. Opus), the upstream ignition is rarely needed — the upgrade ladder already covers it. The advantage is clearest in **long-horizon / mid-task-shift / weak-model-or-expensive-token** regimes.

---

## 9. Scientific anchors

| concept | source | role here |
|---|---|---|
| Dual process (System 1 / System 2) | Kahneman | system1 = cheap intuition; system2 = deliberation (pollutes context) |
| Global Workspace + ignition | Baars / Dehaene (GWT) | surprise over threshold → global broadcast → invoke System 2 |
| Attention Schema | Graziano (AST) | maintains a self-state `z` (active prototype / recent surprise / caution) |
| Compromise in competition (EMMS) | Li Jinghai | economy vs robustness, two conflicting extremals coordinated by shadow price μ |

---

## 10. Install & run

Requires Node.js ≥ 18. No build, no dependencies.

### 10.1 Register in an MCP client

```jsonc
{
  "mcpServers": {
    "conscious-scheduler": {
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"]
    }
  }
}
```

### 10.2 Tools

| tool | when | key params |
|---|---|---|
| `open_session` | at start | `sessionId`, `namespace` |
| `new_task` | each task start | `sessionId` (resets pollution, keeps prototypes & μ) |
| `decide_step` | **before every step** | `criticality_hint / difficulty_hint / progress / context_pollution` (all 0–1) |
| `report_outcome` | after every step | `observed_criticality`, `used_system2` |
| `task_feedback` | task end | `success` (tunes μ + persists) |
| `get_stats` / `get_calibration` / `dump_prototypes` | audit | — |
| `close_session` | end | persists skills |

`decide_step` returns: `mode: "system1" | "system2"`, the **real decision basis** `p_crit / e_cost_s1 / e_cost_s2 / decision_rule` (the rule that actually sets `mode`: `ignite ⟺ e_cost_s1 > e_cost_s2`), plus `criticality_estimate / threshold / familiarity / surprise / confidence / mu / regime_shift / suggest_compact`. The legacy `rob_gain / eco_cost` are still returned for the old bidding figure but are **not** the mode rule.

### 10.3 Self-checks

```powershell
node server.mjs            # start the service (waits for JSON-RPC on stdin)
node smoke.mjs             # full handshake + multi-round task + persistence check
node complexTask.mjs       # long-horizon 3-arm comparison
node answerTests.mjs       # "does it get smarter / generalize / manage pollution" tests
```

### 10.4 Reproduce the figures

```powershell
node figures/gen_fig_data.mjs                          # -> fig_data.json
$env:PYTHONNOUSERSITE="1"                              # isolate user site-packages (numpy clash)
python figures/make_figures.py                          # -> *.png (Times New Roman, 300 dpi)
```

---

## 11. Repository layout

```
server.mjs          zero-dep stdio JSON-RPC 2.0 MCP server (8 tools)
consciousCore.mjs   session management + persistence + calibration
selfModel.mjs       the scheduler core (decideAbstract / learnAbstract / feedback)
smoke.mjs           full MCP handshake + persistence self-check
complexTask.mjs     long-horizon 3-arm comparison (drives the real MCP transport)
answerTests.mjs     "smarter / general / pollution" question tests
README.zh.md        Chinese README
ALGORITHM_zh.md     full Chinese algorithm write-up
store/              persisted prototype libraries (per namespace)
figures/
  gen_fig_data.mjs  collects all figure data -> fig_data.json
  make_figures.py   publication-quality plots (Times New Roman, 300 dpi)
  *.png             generated figures
```

---

## 12. License

MIT. *"Conscious" is used as a functional metaphor only; no claim of phenomenal consciousness is made.*
