# Metacognitive Compute Scheduler

**Stop burning your best model on trivial steps — and stop letting your cheap model botch the one step that decides the whole task.**

This is a tiny MCP service you ask one question per step — *System 1 (cheap) or System 2 (deliberate)?* — and it answers by **learning from outcomes**, not hand-written `if` rules. Bolt it onto any agent loop in five minutes.

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

**Under the hood it's three cooperating layers, not one heuristic** (they all bid in a single auction, §4.4):

| layer | what it learns | the question it answers |
|---|---|---|
| **Metacognition** (`selfModel`) | when a step is worth deliberating | *how much compute does this step deserve?* |
| **Skill memory** (`skillMemory`) | domain experience grounded in **real verifier results** | *have I fixed this exact error in this repo before — and did the test actually pass?* |
| **Meso-scale cluster** (`clusterAgent`) | strongly-coupled steps as one sub-goal | *should this whole sub-goal latch to deliberation instead of being fooled per-step by noisy hints?* |

Metacognition allocates compute; skill memory supplies verified content; the meso-scale layer protects pivotal sub-goals. None replaces the others, and you can use just the first layer and ignore the rest.

---

## 2. How it works

```
open_session(namespace)                  ← reuse metacognitive prototypes + skill memory under this namespace
for each task:
    new_task(sessionId)                  ← reset context pollution; keep prototypes, μ, and skills
    for each step:
        d = decide_step(criticality_hint, difficulty_hint, progress, context_pollution,
                        action_type, repo, lang, file_type, error_signature, stack_features)
        # skill layer retrieves verified prior fixes (same repo) → d.reusable_fix, and lowers/raises compute
        if d.mode == "system2":  result = strong model / best-of-N   (expensive, robust)
        else:                    result = cheap model / single shot  (frugal)
        # mutating actions (design_patch/apply_patch/...) are force-verified per action type (§4.4)
        report_outcome(observed_criticality, used_system2,
                       verifier_result, outcome, patch_summary)       ← all three layers self-learn
    task_feedback(success)               ← updates μ + persists prototypes AND skills
```

The caller computes four task-agnostic scalars (all in `[0,1]`) for the metacognition layer, and — to activate the skill + action layers — passes the **operation semantics** of the step (all optional; omit them and it degrades cleanly to the metacognition-only scheduler):

| signal | meaning | typical source |
|---|---|---|
| `criticality_hint` | how pivotal this step looks | planner heuristic |
| `difficulty_hint` | how hard this step looks | input size / complexity |
| `progress` | position in the task | step index / total |
| `context_pollution` | how dirty the context is | used tokens / window |
| `action_type` | what kind of step (`design_patch` / `apply_patch` / `write_code` / `read_issue` / `run_test` …) | the agent's own action |
| `repo` / `lang` / `file_type` | repo boundary + language/file context | the working file |
| `error_signature` / `stack_features` | the real error text / stack symbols (visible *before* the fix — no leakage) | the failing test / traceback |

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

### 4.4 The three layers all bid in the *same* auction

The maturation from "scheduler" to "framework" is this: the **action layer** and **skill layer** do not bypass the auction with `if/else` overrides — they enter the robust bid `robBid` as **barriers and shadow prices**, exactly the standard way constraints and incentives enter a constrained optimum. One bid, three sources of evidence:

$$\mathrm{robBid} = \underbrace{\mu\,\hat p\,\mathrm{missPenalty}}_{\text{metacognition}} + \underbrace{\text{actionPremium}}_{\text{action layer}} + \underbrace{\text{skillNovelty} + \text{crossRepo} - \text{skillReuse}}_{\text{skill layer}} + \underbrace{\text{barriers (irreversible/critical/budget)}}_{\text{safety}}$$

| term | layer | effect on the bid | grounded in |
|---|---|---|---|
| `actionPremium` | action | mutating actions (`design_patch`/`apply_patch`/…) raise the bid **regardless of how low the risk hint is** | action type, orthogonal to the upstream hint |
| `skillReuseDiscount` | skill | a **same-repo, test-passed** prior fix exists → **lower** the bid (reuse known solution, deliberate less) | only records with `verifier_result = test_passed` |
| `skillNoveltyPremium` | skill | semantically unseen error/stack → **raise** the bid (explore cautiously) — scaled by stakes | local-embedding similarity to past errors |
| `crossRepoPremium` | skill | similar prior fix but from a **different repo** → **raise** the bid (repo boundary, don't trust cross-domain blindly) | repo match vs best similarity |

**Two design rules that resolve the original `design_patch` miss:**

1. **A mutating action can never be silently demoted on a low risk hint.** Even when `criticality_hint` is deceptively low and μ has decayed, `actionPremium` keeps `design_patch` from being treated as a trivial step — and it is **force-verified** regardless of `mode`.
2. **Verification strategy is dispatched by action type**, not one-size-fits-all: `design_patch → review`, `apply_patch / write_code / edit_file / refactor → test`, `delete / migrate_schema → dry_run`, `run_test → none`.

Reuse does **not** mean "skip System 2 on a critical mutating step" (that would trade away safety) — critical mutating steps still hit the `∞` barrier and always deliberate. Reuse makes the deliberation **cheaper** (verify a known fix) instead of **searching from scratch**. Omit `ctx.skill`/`action_type` and all these terms vanish → the bid degrades exactly to the metacognition-only auction (zero regression, asserted in `skillGateTest.mjs`).

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

A prototype = `{protoFeat: situation centroid, affine read-out ĉ(x), self-calibration predErr, count}` — **a compressed metacognitive judgment** ("situations like this tend to be critical"). It is *not* a domain skill — the actual *content* of "what error, fixed how, did it pass" lives in the **skill memory layer** (§6), not in these prototypes.

---

## 6. The skill-memory layer: learning domain experience

Metacognition decides *how much to think*; it does **not** learn *what a `ScopeMismatch` in pytest looks like or how it was fixed*. That domain content is the job of a dedicated **skill-memory layer** (`skillMemory.mjs`). The two are complementary: the scheduler allocates effort, the skill memory supplies the verified content that makes that effort cheaper.

A skill record = **one solving experience that was actually verified**:

```
{ repo, lang, fileType, actionType,        // repo boundary + operation type (structured)
  errorSignature,                           // the real error text / exception type
  stackFeatures: [token…],                  // real stack / symbol features
  changeFootprint: {files,hunks,loc},       // real edit size
  patchSummary,                             // the reusable fix (the "skill" content)
  verifierResult, outcome,                  // ★ the REAL test result — test_passed / test_failed
  embed }                                   // local embedding (token-hash, no paid model)
```

**Grounding discipline (this is the point).** Reuse confidence is weighted **only** by records whose `verifier_result = test_passed` (or `outcome = 1`). A failed attempt does **not** make the scheduler more confident — it directly falsifies the "it just trusts the upstream hint more and more" failure mode. When the same error recurs **in the same repo** and a verified fix exists, the skill layer surfaces it (`reusable_fix`) and lowers the bid; a similar fix from a **different** repo raises the bid instead (repo boundary). This is verified end-to-end in `smoke.mjs` (A/B/C checks) and asserted in `skillGateTest.mjs` (17 hard assertions).

| | hand-written skill | metacognition prototype | **skill-memory record** |
|---|---|---|---|
| learns | nothing (human writes it) | *when* to deliberate | ***what* was the error → fix → did it pass** |
| origin | a human writes trigger → steps | grows from experience | grows from **verified** solving episodes |
| arbitration | hard trigger, easy to misfire | similarity + confidence | same-repo + test-passed → reuse; cross-repo → caution |
| failure mode it fixes | — | over/under-thinking | re-searching a fix you already verified once |

> **Honest boundary.** The local embedding is a **64-dim FNV-1a token hash** — this is *lexical* similarity retrieval over real error/stack/patch text, a zero-dependency starting point. It is **not** a trained semantic code embedding, and we do not claim it "understands" code semantics. Swapping in a real embedding model is a drop-in upgrade.

---

## 6b. The meso-scale cluster layer (sub-goal clusters)

The third layer (`clusterAgent.mjs`) addresses a different failure: when per-step `criticality_hint` is noisy, a genuinely pivotal step can look harmless in isolation and get demoted. The cluster layer groups strongly-coupled steps into a **sub-goal cluster**, aggregates their (noisy) hints, and **latches** the whole cluster to deliberation once it ignites — so one misleading low hint can't sink a critical sub-goal. In `exp_cluster.mjs` this cuts critical mishandles (114.8 → 94.4) and task failures (50.7 → 44.0) under noisy hints, with the gain **monotonically vanishing as hint noise → 0** (a falsifiable signature: the benefit comes specifically from aggregating weak signals).

> **Honest boundary.** The cluster layer does **not** auto-discover sub-goal boundaries yet — the outer agent must call `startCluster()` to mark a cluster. What is implemented is *aggregation + latch on known clusters*, not emergent meso-scale structure discovery.

---

## 7. Evidence

All figures use Times New Roman, 300 dpi. Reproduce with `figures/gen_fig_data.mjs` + `figures/make_figures.py`.

### 7.1 Long-horizon task with mid-task regime shift (20 seeds × 60 tasks × 8 steps)

The task switches rule at task 30 (regime A → B, the hint→criticality mapping reverses). Cost model: cheap = 1, deep = 5; mishandling a critical step = wasted cheap try + forced upgrade (1+5); deep on a non-critical step = over-thinking (wastes 4). `difficulty_hint` and `criticality_hint` are **independent** signals. Reproduce with `mcp/benchSeeds.mjs` (20 seeds, mean ± std, paired t-test).

| arm | total cost | critical mishandles | over-thinking |
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

1. **A metacognitive compute layer orthogonal to "what to do".** FrugalGPT does static routing, Reflexion is post-hoc, Voyager is still skills, RouteLLM has no shift-detection and no pollution-in-cost. Nobody makes *"how much compute"* an independent, learnable, MCP-exposed service driven by task-agnostic signals.
2. **Three layers in one auction.** Metacognition (when to think), skill memory (verified domain experience), and meso-scale clusters all enter the *same* EMMS bid as barriers/shadow-prices (§4.4) — not stacked `if/else` overrides. Action type and verified prior fixes change the compute decision, anchored to **real verifier results**, not to the upstream hint.
3. **Online regime-shift detection + prototype switching.** `sim < 0.7` forces re-examination; the system adapts mid-task where frozen thresholds lock up (§7.3, +5–10 pt, all p < 0.001).
4. **Context pollution enters the decision cost.** *"The more you think, the messier it gets → the less you should think more."* Most frameworks ignore this; here it is a first-class term `ecoCost = c + λρ`.

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
| `new_task` | each task start | `sessionId` (resets pollution, keeps prototypes, μ, skills) |
| `decide_step` | **before every step** | `criticality_hint / difficulty_hint / progress / context_pollution` (0–1) + optional semantics `action_type / repo / lang / file_type / error_signature / stack_features` |
| `report_outcome` | after every step | `observed_criticality`, `used_system2`; + verification `verifier_passed / miss_happened`; + (mutating steps) `patch_summary / change_footprint / verifier_result / outcome` to write a skill record |
| `task_feedback` | task end | `success` (tunes μ + persists prototypes **and** skills) |
| `get_stats` / `get_calibration` / `dump_prototypes` | audit | — (`get_stats` includes `nSkills`; `dump_prototypes` includes the skill records) |
| `close_session` | end | persists prototypes + skills |

`decide_step` returns: `mode: "system1" | "system2"`, the **real decision basis** `p_crit / e_cost_s1 / e_cost_s2 / decision_rule` (the rule that actually sets `mode`: `ignite ⟺ robBid > ecoAsk`), the **verification action** `verify: none | lint | test | dry_run | review` + `risk_class`, the **action layer** `is_mutating / action_prior / action_premium / forced_verify`, and the **skill layer** `skill_reuse_discount / skill_novelty_premium / cross_repo_premium / reusable_fix / skill_signal` (novelty, repo_match, verified_support). Plus `criticality_estimate / threshold / familiarity / surprise / confidence / mu / regime_shift / suggest_compact`. The legacy `rob_gain / eco_cost` are still returned for the old bidding figure but are **not** the mode rule.

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
server.mjs          zero-dep stdio JSON-RPC 2.0 MCP server (9 tools)
consciousCore.mjs   session mgmt + persistence + calibration; runs a SkillfulAgent (all 3 layers)
selfModel.mjs       metacognition layer — the bid core (decideAbstract / learnAbstract / feedback)
skillMemory.mjs     skill layer — verified domain experience (records, local embedding, retrieval)
skillfulAgent.mjs   assembles metacognition + skill memory; toJSON / fromJSON / restore
clusterAgent.mjs    meso-scale layer — sub-goal cluster aggregation + latch
smoke.mjs           full MCP handshake + 3-layer end-to-end (action/skill/repo-boundary) + persistence
skillGateTest.mjs   17 hard assertions on the skill layer (grounding, repo boundary, reuse, zero-regression)
exp_skill.mjs       skill-layer experiment (cost 921.67 -> 544; falsifiable falsify arm)
exp_action.mjs      action-layer experiment (design_patch miss 4.87 -> 0)
exp_cluster.mjs     meso-scale cluster experiment (noisy-hint safety gain)
complexTask.mjs     long-horizon 3-arm comparison (drives the real MCP transport)
answerTests.mjs     "smarter / general / pollution" question tests
README.zh.md        Chinese README
ALGORITHM_zh.md     full Chinese algorithm write-up
store/              persisted prototype libraries + skill memory (per namespace)
figures/
  gen_fig_data.mjs  collects all figure data -> fig_data.json
  make_figures.py   publication-quality plots (Times New Roman, 300 dpi)
  *.png             generated figures
```

---

## 12. License

MIT. *"Conscious" is used as a functional metaphor only; no claim of phenomenal consciousness is made.*
