# Metacognitive Compute Scheduler

**Stop burning your best model on trivial steps — and stop letting your cheap model botch the one step that decides the whole task.**

This decouples *"how much compute this step deserves (System 1 cheap generation / System 2 deliberation)"* out of your agent into a **separate, online-learning MCP service**. It decides each step with an economic auction model and calibrates online from real outcomes, replacing hand-written `if`-threshold rules. Standard MCP protocol, zero dependencies, drops into any agent loop.

```jsonc
// add to your MCP client (Claude Desktop / Cursor / VS Code), then call decide_step before each step
{ "mcpServers": { "scheduler": { "command": "node", "args": ["/abs/path/to/server.mjs"] } } }
```

- 🪶 **Zero dependencies.** One `server.mjs`, Node ≥ 18, no build, no install, no API key. Works with any MCP client or your own loop.
- 🎯 **Cuts critical mistakes 57%** vs. the strongest single-threshold router at comparable cost — and is both **cheaper and safer** than a static rule (20-seed benchmark, p < 1e-16, §7.1).
- 🔁 **Survives mid-task rule changes.** When the task shifts under it, frozen thresholds keep misfiring; this one notices the surprise and re-adapts online (§7.3).
- 🔍 **Fully auditable.** Every decision returns the exact numbers that drove it (`p_crit`, `e_cost_s1`, `e_cost_s2`, `mu`) — no black box.

> 🌏 **中文版见 [`README.zh.md`](README.zh.md)** · Full Chinese algorithm write-up: [`ALGORITHM_zh.md`](ALGORITHM_zh.md)

![overview](figures/overview.png)

---

## 1. The problem it solves

Every agent on a long task answers this at every step, whether it admits it or not:

> *"Can I get away with a cheap/single shot here — or must I stop and think hard (strong model / best-of-N / deep reasoning)?"*

Get it wrong in either direction and you lose:

- **Always full power** → you pay strong-model price on steps that never needed it, *and* you flood the context window with deliberation that makes later steps worse.
- **A hand-written trigger** (`if files > 12 then think_hard`) → it misses cases you didn't foresee and **locks up the moment the task changes mid-flight**.

The fix is to pull *"how much effort"* out into a **separate, learnable service**, orthogonal to *"what to do."* Keep your planner and skills exactly as they are — just ask one extra question per step.

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

![bidding](figures/fig5_bidding.png)

A prototype = `{protoFeat: situation centroid, affine read-out ĉ(x), self-calibration predErr, count}` — **a compressed metacognitive judgment** ("situations like this tend to be critical"). It is *not* a domain skill — the actual *content* of "what error, fixed how, did it pass" lives in the **skill memory layer** (§6), not in these prototypes.

---

## 6. The skill-memory layer: learning domain experience

Metacognition decides *how much to think*; it does **not** learn *what a `ScopeMismatch` in pytest looks like or how it was fixed*. That domain content is the job of a dedicated **skill-memory layer** (`skillMemory.mjs`). The two are complementary: the scheduler allocates effort, the skill memory supplies the verified content that makes that effort cheaper.

A skill record = **one solving experience verified by a trusted executor**: `{repo, branch, lang, fileType, actionType, errorSignature, stackFeatures, changeFootprint, patchSummary, verification{source, exitCode, testCmd, commitHash, patchHash, trusted}, injectionFlag, queryEmbed}`. **Reuse confidence is weighted only by records the executor wrote with exit code 0** — an agent self-reporting `outcome=1` does not count, and a failed attempt does not make the scheduler more confident. The retrieval vector `queryEmbed` encodes only the **decision-time-visible error/stack**; the post-hoc patch summary is *not* mixed in (so it can't dilute error matching). Same error, same repo, trusted-verified fix → surface `reusable_fix` and lower the bid; a similar episode from a **different** repo → return a `reference_case` **for human review only** (`reusable_fix` is always `null`) and raise the bid (repo boundary). Plain-text patch/error content is redacted (keys/tokens/emails), size-capped, and prompt-injection-flagged before storage. Verified end-to-end in `smoke.mjs` (A/B/C/D) and `skillGateTest.mjs` (33 assertions).

| | hand-written skill | metacognition prototype | **skill-memory record** |
|---|---|---|---|
| learns | nothing (human writes it) | *when* to deliberate | ***what* error → fix → did it pass** |
| origin | a human writes trigger → steps | grows from experience | grows from **trusted-executor-verified** solving episodes |
| arbitration | hard trigger, easy to misfire | similarity + confidence | same-repo + trusted-verified → reuse; **cross-repo → reference case for human review only, never a reusable fix** |

> **Honest boundary.** The local embedding is a **64-dim FNV-1a token hash** — *lexical* similarity retrieval over real error/stack text, a zero-dependency starting point, **not** a trained semantic code embedding (and the query vector deliberately excludes post-hoc patch text). Skill reusability is gated by a **trusted executor** (exit code, test command, commit/patch hash) — not by an agent self-reporting `outcome=1`. Swapping in a real embedding model is a drop-in upgrade.

---

## 7. Evidence (real SWE-bench Pro trajectories)

All figures use Times New Roman, 300 dpi. The data comes **entirely from real SWE-bench Pro** (`sweap_eval_full_v2.jsonl`, 731 real PR instances, shipped in `data/`): each instance's **co-changed file set** and **symbols** are parsed from the official gold patch; repo/path/tests are all real. Modeled (explicitly labeled, replaceable): per-step hint noise, System2 success rate, distractor steps (real files from other same-repo instances mixed in). End-to-end reproduce:

```bash
node figures/gen_fig_data.mjs        # sample from real data -> figures/fig_data.json
python figures/make_figures.py       # fig_data.json -> the 7 figures below
node eval_swebpro_clusters.mjs --seeds 24 --sessions 60 --noise 0.3   # same numbers, PASS/FAIL verdict
```

Figures and verdict share one engine (`swebpReal.mjs`), so the pictures and the numbers can never disagree. Every number below is verbatim from the committed `figures/fig_data.json`.

**The 10 real instances driving the headline** (`selected10.json`): element-web (6 files), qutebrowser (5), NodeBB (5), openlibrary (4), vuls (4), tutanota (5), flipt (3), webclients (3), ansible (2), teleport (2).

### 7.1 Three-arm cost profile — `fig1_arm_cost.png`

**What this figure is:** three scheduling strategies on the same 24-seed × 60-session batch. One session = 2~3 real PRs from the same repo + distractor steps, interleaved and shuffled. Cost model (estimated tokens): System1=1, System2=8; mishandling a critical step = that subtask not fixed; deep on a non-critical step = wasted over-thinking.

| arm | est. tokens ↓ | critical miss ↓ | over-think ↓ | System2 calls |
|---|---|---|---|---|
| `always-S2` (brute upgrade = every step runs System2) | 9838 | 83.08 | 399.88 | 1229.75 |
| `step` (per-step routing, baseline) | 7765.13 | 101.17 | 123.79 | 933.63 |
| **`cluster` (meso-scale auto-cluster, ours)** | 7837.17 | **99.83** | 132.67 | 943.92 |

**How to read it:** `always-S2` misses the fewest, but burns ~27% more tokens and 4× the over-thinking — that's the "think hard about everything" straw man. Our `cluster` arm hugs the cheap `step` baseline on cost (+0.9% tokens, +1.1% System2) yet recovers critical steps the baseline drops. The whole point is in the **next figure**: that small controlled overhead buys a safety gain.

![arm cost](figures/fig1_arm_cost.png)

### 7.2 Core result — meso-scale gain satisfies M1 ∧ M2 simultaneously — `fig2_m1m2.png`

Cluster boundaries are **not fed** to any arm; the cluster arm can only auto-discover them via online union-find over **decision-time-visible real file/symbol overlap**. Both conditions must hold **at the same time** (147 critical subtasks per seed, paired across 24 seeds):

| metric | meaning | value | verdict |
|---|---|---|---|
| **M1** critical-miss delta (cluster − step) | fewer critical subtasks missed? | **−1.33** (101.17 → 99.83), paired *t* = −3.14, **p = 0.0017**, cluster wins 58% of seeds | ✅ significantly fewer |
| **M2** System2 delta (cluster − step) | cheating by upgrading more? | **+10.29 calls** (933.63 → 943.92), well under the +10% cap (≤ 1027) | ✅ no brute upgrade |

**How to read it:** anything can win M1 by "upgrade everything to System2" — but that violates M2. Passing **both** is what proves the cluster layer found the *right* steps to deep-think, not simply *more* steps. A negative M1 with p < 0.01 is the headline: fewer critical subtasks slip through, at essentially baseline cost.

![m1m2](figures/fig2_m1m2.png)

> This evaluation **penalizes over-clustering**: if the cluster arm pulls in distractor steps too, it wastes System2 → M2 breaks the budget cap and auto-fails. So the cluster must **discover correctly** to win — that's why M1 ∧ M2 holding together is not a circular argument.

### 7.3 Self-calibration + shadow-price convergence — `fig3_learning.png`, `fig4_mu_trace.png`

**`fig3_learning` (left) — cluster arm's critical-miss rate per session batch (120 sessions in 10 batches of 12):**

| batch | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| miss rate | 6.5% | 5.7% | 6.9% | 2.3% | 9.3% | 8.2% | 7.8% | 7.1% | 7.7% | 8.5% |

**How to read it (honest version):** the miss rate is **low and bounded from the first batch (~2–9%, mean ~7%)** — no long warm-up needed. The honest takeaway is that the gain is **stably maintaining a low miss rate** under noisy hints, **not** a dramatic downward learning curve (this series is noisy, not monotonically decreasing).

**`fig4_mu_trace` (right) — EMMS coordination variable μ (shadow price of risk) over 120 sessions:** starts at **μ = 0.9** and converges to an interior fixed point at **μ = 0.3**. μ is the "exchange rate" coupling rob-bid and eco-ask; its convergence is what keeps the auction stable instead of oscillating between "all cheap" and "all deep".

![learning](figures/fig3_learning.png) ![mu](figures/fig4_mu_trace.png)

### 7.4 Bidding geometry + noise robustness — `fig5_bidding.png`, `fig6_noise.png`

**`fig5_bidding` (left) — each step plotted as a (rob-bid, eco-ask) scatter + ignition boundary.** Above the diagonal ignites System2, below stays System1. Truly-critical steps pushed to near-∞ rob-bid (the hard safety gate) always go deep; the cluster coupling premium pushes "coupled-but-looks-plain" steps over the line.

**`fig6_noise` (right) — falsifiable robustness sweep:** how the M1 gain moves with per-step hint noise. M2 stays within budget at every noise level.

| hint noise σ | M1 miss delta (cluster − step) | p | cluster win rate | System2 vs baseline | M1 | M2 |
|---|---|---|---|---|---|---|
| 0.1 | −0.38 | 0.0098 | 29% | 1.2× margin | ✅ | ✅ |
| 0.2 | −1.21 | 0.0003 | 58% | 1.3× | ✅ | ✅ |
| 0.3 | −1.71 | 0.0002 | 75% | 1.3× | ✅ | ✅ |
| 0.42 | −3.00 | 0.0002 | 88% | 1.2× | ✅ | ✅ |
| 0.5 | −3.33 | < 1e-4 | 96% | 1.1× | ✅ | ✅ |

**How to read it:** the noisier the hints, the **larger** the cluster's edge (−0.38 → −3.33) and the more often it wins (29% → 96% of seeds). That's the mechanism's signature: a single global threshold gets fooled by "looks-plain-but-actually-critical" same-PR steps, and the cluster rescues them together via real coupling. When hints are clean (σ=0.1) there is little to rescue, so the gain is small — exactly as expected.

![bidding](figures/fig5_bidding.png) ![noise](figures/fig6_noise.png)

### 7.5 Overview — `overview.png`

A 2×3 composite of the six figures above for an at-a-glance read.

![overview](figures/overview.png)

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
- **All three layers are integrated.** Metacognition (`selfModel`), skill memory (`skillMemory`), and the meso-scale cluster (`clusterIndex`) all bid in the *same* online MCP auction (`decide_step` / `report_outcome`). The meso-scale layer feeds a coupling premium into `decide_step` and exposes discovered structure via `dump_clusters`; clusters are auto-discovered from decision-time-visible file/symbol overlap, not hand-fed.
- **Skill reuse is gated by a trusted verifier, not self-report.** A record becomes reusable only when a trusted executor writes exit code 0 (with test command + commit/patch hash); cross-repo matches are returned as human-review reference cases only, never as a `reusable_fix`. The 64-dim hash is lexical, not semantic.
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
node figures/gen_fig_data.mjs                          # collect from real SWE-bench Pro -> fig_data.json
python figures/make_figures.py                          # -> *.png (Times New Roman, 300 dpi)
# Same base, falsifiable verdict: node ../../beta-mesoscale2/eval_swebpro_clusters.mjs --seeds 24 --sessions 80 --noise 0.42
```

---

## 11. Repository layout

```
server.mjs          zero-dep stdio JSON-RPC 2.0 MCP server (10 tools)
consciousCore.mjs   session management + persistence + calibration
selfModel.mjs       the scheduler core (decideAbstract / learnAbstract / feedback)
clusterIndex.mjs    meso-scale layer — online auto-discovery of sub-goal clusters + coupling premium
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
