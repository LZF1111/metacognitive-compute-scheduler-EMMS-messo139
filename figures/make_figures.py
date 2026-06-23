#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_figures.py —— 从 fig_data.json 生成出版级科研图(Times New Roman, 300 dpi)。

★全部数据来自【真实 SWE-bench Pro 轨迹】(见 gen_fig_data.mjs / beta-mesoscale2/swebpReal.mjs),
  与可证伪评估 eval_swebpro_clusters.mjs 同一底座。诚实边界见各图副标题与 README。

产出 6 张图 + 1 张合成总览:
  fig1_arm_cost.png   三臂(逐步/簇/always-S2): 估算 token / 关键漏判 / 过度深思(柱状)
  fig2_m1m2.png       M1(少漏关键子任务) + M2(不多烧强模型) 配对检验(本工作核心结论)
  fig3_learning.png   簇臂关键漏判率随会话批次下降(自校准)
  fig4_mu_trace.png   影子价 μ 随会话收敛(EMMS 协调变量不动点)
  fig5_bidding.png    簇臂每步 (robBid, ecoAsk) 竞价散点 + 点燃边界
  fig6_noise.png      M1 改善随 hint 噪声变化(鲁棒性扫描,可证伪)
  overview.png        2x3 合成总览

运行(须隔离用户 site-packages 以避开 numpy 版本冲突):
  PYTHONNOUSERSITE=1 python make_figures.py
"""
import json
import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "fig_data.json")
OUT = HERE


# ── Times New Roman 出版风格 ──────────────────────────────────────────────
def _resolve_times():
    for fp in (r"C:\Windows\Fonts\times.ttf", r"C:\Windows\Fonts\timesbd.ttf"):
        if os.path.exists(fp):
            try:
                font_manager.fontManager.addfont(fp)
            except Exception:
                pass
    names = {f.name for f in font_manager.fontManager.ttflist}
    for cand in ("Times New Roman", "Times", "Nimbus Roman", "Liberation Serif"):
        if cand in names:
            return cand
    return "serif"


TIMES = _resolve_times()
plt.rcParams.update({
    "font.family": "serif",
    "font.serif": [TIMES, "Times New Roman", "DejaVu Serif"],
    "mathtext.fontset": "stix",
    "font.size": 9,
    "axes.titlesize": 10,
    "axes.labelsize": 9,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "legend.fontsize": 8,
    "axes.linewidth": 0.8,
    "xtick.direction": "in",
    "ytick.direction": "in",
    "xtick.major.size": 3,
    "ytick.major.size": 3,
    "legend.frameon": False,
    "figure.dpi": 300,
    "savefig.dpi": 300,
    "savefig.bbox": "tight",
})

# 灰度友好的稳重配色
C_FULL = "#4C4C4C"     # always-System2
C_STEP = "#9E9E9E"     # step (逐步)
C_OURS = "#1F4E79"     # cluster(本工作,深蓝突出)
C_ACCENT = "#C0504D"   # 强调/边界线
C_OK = "#2E7D32"       # 通过(绿)

with open(DATA, "r", encoding="utf-8") as f:
    D = json.load(f)

NOISE = D["meta"]["noise"]
SEEDS = D["meta"]["seeds"]

# 臂显示名(顺序: always-S2 / step / cluster)
_ARM_LABEL = {"always-S2": "always-S2", "step": "step (per-step)", "cluster": "cluster (ours)"}
_ARM_COLOR = {"always-S2": C_FULL, "step": C_STEP, "cluster": C_OURS}


def _arm_order():
    arms = D["armBars"]
    names = [a["name"] for a in arms]
    labels = [_ARM_LABEL.get(n, n) for n in names]
    colors = [_ARM_COLOR.get(n, C_STEP) for n in names]
    return arms, names, labels, colors


def fig1_arm_cost():
    arms, names, labels, colors = _arm_order()
    tok = [a["tok"] for a in arms]
    mis = [a["miss"] for a in arms]
    over = [a["overdeep"] for a in arms]

    fig, axes = plt.subplots(1, 3, figsize=(7.4, 2.6))
    titles = ["Est. token cost (lower better)", "Critical-subtask misses", "Over-thinking steps"]
    data = [tok, mis, over]
    for ax, title, vals in zip(axes, titles, data):
        bars = ax.bar(range(len(names)), vals, color=colors, width=0.62,
                      edgecolor="black", linewidth=0.6)
        ax.set_xticks(range(len(names)))
        ax.set_xticklabels(labels, rotation=18, ha="right")
        ax.set_title(title)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        for b, v in zip(bars, vals):
            ax.text(b.get_x() + b.get_width() / 2, v, f"{v:.0f}", ha="center",
                    va="bottom", fontsize=7.5)
        ax.margins(y=0.18)
    fig.suptitle(f"Real SWE-bench Pro multi-subtask sessions ({SEEDS} seeds, hint noise $\\pm${NOISE})",
                 fontsize=10, y=1.05)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig1_arm_cost.png"))
    plt.close(fig)


def fig2_m1m2():
    """本工作核心结论: M1(少漏关键子任务) + M2(不多烧强模型) 同时成立。"""
    mm = D["m1m2"]
    fig, (axL, axR) = plt.subplots(1, 2, figsize=(7.2, 2.9))

    # 左: M1 关键漏判(step vs cluster, 均值±std)
    sm, cm = mm["stepMiss"], mm["clusterMiss"]
    xs = [0, 1]
    bars = axL.bar(xs, [sm["mean"], cm["mean"]], yerr=[sm["std"], cm["std"]],
                   color=[C_STEP, C_OURS], width=0.6, edgecolor="black", linewidth=0.6,
                   error_kw=dict(ecolor="black", lw=0.8, capsize=3))
    axL.set_xticks(xs)
    axL.set_xticklabels(["step", "cluster (ours)"])
    axL.set_ylabel("Critical-subtask misses / seed")
    m1 = mm["M1"]
    tag = "***" if m1["p"] < 0.001 else ("**" if m1["p"] < 0.01 else ("*" if m1["p"] < 0.05 else "n.s."))
    axL.set_title(f"(M1) Fewer critical misses\n$\\Delta$={m1['mean']:.2f}, p={m1['p']:.4g} ({tag})",
                  color=C_OK if m1["pass"] else C_ACCENT)
    ytop = max(sm["mean"] + sm["std"], cm["mean"] + cm["std"])
    axL.plot([0, 1], [ytop * 1.06] * 2, color="black", lw=0.8)
    axL.text(0.5, ytop * 1.07, tag, ha="center", va="bottom", fontsize=10)
    axL.set_ylim(0, ytop * 1.2)
    axL.spines["top"].set_visible(False)
    axL.spines["right"].set_visible(False)

    # 右: M2 System2 调用(预算闸 +10%)
    m2 = mm["M2"]
    base, cl = m2["baseS2"], m2["clusterS2"]
    cap = base * (1 + m2["budgetSlack"])
    bars2 = axR.bar([0, 1], [base, cl], color=[C_STEP, C_OURS], width=0.6,
                    edgecolor="black", linewidth=0.6)
    axR.axhline(cap, color=C_ACCENT, linestyle="--", linewidth=1.0,
                label=f"budget cap (+{m2['budgetSlack']*100:.0f}%)")
    axR.set_xticks([0, 1])
    axR.set_xticklabels(["step", "cluster (ours)"])
    axR.set_ylabel("System2 (strong-model) calls / seed")
    axR.set_title(f"(M2) No extra strong-model burn\ncluster={cl:.0f} $\\leq$ cap={cap:.0f}",
                  color=C_OK if m2["pass"] else C_ACCENT)
    for b, v in zip(bars2, [base, cl]):
        axR.text(b.get_x() + b.get_width() / 2, v, f"{v:.0f}", ha="center", va="bottom", fontsize=7.5)
    axR.set_ylim(0, max(cap, cl) * 1.12)
    axR.legend(loc="lower right", fontsize=7)
    axR.spines["top"].set_visible(False)
    axR.spines["right"].set_visible(False)

    verdict = "PASS" if (m1["pass"] and m2["pass"]) else "FAIL"
    fig.suptitle(f"Meso-scale gain on real trajectories: M1 $\\wedge$ M2 = {verdict}",
                 fontsize=10.5, y=1.04, color=C_OK if verdict == "PASS" else C_ACCENT)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig2_m1m2.png"))
    plt.close(fig)


def fig3_learning():
    lc = D["learningCurve"]
    x = [r["batch"] for r in lc]
    y = [r["missRate"] * 100 for r in lc]
    fig, ax = plt.subplots(figsize=(3.5, 2.7))
    ax.plot(x, y, "-o", color=C_OURS, markersize=4, linewidth=1.4,
            markerfacecolor="white", markeredgewidth=1.2, label="cluster (ours)")
    # 趋势线
    if len(x) >= 2:
        z = np.polyfit(x, y, 1)
        ax.plot(x, np.polyval(z, x), "--", color=C_ACCENT, linewidth=0.9,
                label=f"trend (slope={z[0]:.2f})")
    ax.set_xlabel("Session batch (12 sessions each)")
    ax.set_ylabel("Critical-miss rate (%)")
    ax.set_title("Self-calibration over experience")
    ax.legend(fontsize=7)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.margins(y=0.14)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig3_learning.png"))
    plt.close(fig)


def fig4_mu_trace():
    mt = D["muTrace"]
    x = [r["session"] for r in mt]
    y = [r["mu"] for r in mt]
    fig, ax = plt.subplots(figsize=(3.5, 2.7))
    ax.plot(x, y, "-", color=C_OURS, linewidth=1.3, label=r"shadow price $\mu$")
    # 收敛带(后 1/3 的均值±std)
    tail = np.array(y[len(y) * 2 // 3:])
    mu_inf = tail.mean()
    ax.axhline(mu_inf, color=C_ACCENT, linestyle="--", linewidth=0.9)
    ax.text(x[-1], mu_inf, f"  $\\mu_\\infty\\approx${mu_inf:.2f}", color=C_ACCENT,
            fontsize=7.5, va="center", ha="left")
    ax.set_xlabel("Session index")
    ax.set_ylabel(r"Coordination shadow price  $\mu$")
    ax.set_title(r"EMMS dual variable $\mu$ convergence")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.margins(y=0.16)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig4_mu_trace.png"))
    plt.close(fig)


def fig5_bidding():
    bs = D["biddingScatter"]
    rob = np.array([p["robGain"] for p in bs])
    eco = np.array([p["ecoCost"] for p in bs])
    ign = np.array([p["ignite"] for p in bs])
    fig, ax = plt.subplots(figsize=(3.7, 2.9))
    ax.scatter(eco[ign == 0], rob[ign == 0], s=10, c=C_STEP, alpha=0.55,
               edgecolors="none", label="System 1 (cheap)")
    ax.scatter(eco[ign == 1], rob[ign == 1], s=12, c=C_OURS, alpha=0.7,
               edgecolors="none", label="System 2 (ignite)")
    lim = max(eco.max(), rob.max()) * 1.05
    ax.plot([0, lim], [0, lim], color=C_ACCENT, linestyle="--", linewidth=1.0,
            label=r"boundary $\mathrm{robBid}=\mathrm{ecoAsk}$")
    ax.set_xlim(0, lim)
    ax.set_ylim(0, lim)
    ax.set_xlabel(r"Economy ask  $\mathrm{ecoAsk}$")
    ax.set_ylabel(r"Robust bid  $\mathrm{robBid}$ (incl. cluster premium)")
    ax.set_title("EMMS competition-coordination bidding")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.legend(loc="upper left", fontsize=6.8)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig5_bidding.png"))
    plt.close(fig)


def fig6_noise():
    ns = D["noiseSweep"]
    x = [r["noise"] for r in ns]
    miss = [-r["missDelta"] for r in ns]   # 取正: 簇相对逐步【少漏多少】
    s2r = [r["s2Ratio"] for r in ns]
    fig, ax = plt.subplots(figsize=(3.8, 2.8))
    ax.plot(x, miss, "-o", color=C_OURS, markersize=4, linewidth=1.4,
            markerfacecolor="white", markeredgewidth=1.2, label="M1: fewer misses")
    ax.axhline(0, color="gray", linestyle=":", linewidth=0.8)
    ax.set_xlabel("Per-step hint noise  $\\pm$")
    ax.set_ylabel("Critical misses saved\n(step $-$ cluster)", color=C_OURS)
    ax.tick_params(axis="y", labelcolor=C_OURS)
    # 标注显著性
    for xi, mi, r in zip(x, miss, ns):
        if r["p"] < 0.05:
            ax.text(xi, mi, "*", ha="center", va="bottom", fontsize=10, color=C_OK)
    ax.set_title("Robustness vs hint noise")
    ax.spines["top"].set_visible(False)
    # 右轴: M2 S2 超支比例(应贴近 0,<10% 闸)
    ax2 = ax.twinx()
    ax2.plot(x, s2r, "-s", color=C_ACCENT, markersize=3.5, linewidth=1.0, alpha=0.8,
             label="M2: extra S2 (%)")
    ax2.axhline(10, color=C_ACCENT, linestyle="--", linewidth=0.8)
    ax2.set_ylabel("Extra System2 calls (%)", color=C_ACCENT)
    ax2.tick_params(axis="y", labelcolor=C_ACCENT)
    ax2.set_ylim(-2, max(12, max(s2r) + 2))
    lines = ax.get_lines()[:1] + ax2.get_lines()[:1]
    ax.legend(lines, [l.get_label() for l in lines], loc="upper left", fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig6_noise.png"))
    plt.close(fig)


def overview():
    """2x3 合成总览图(用于 README 顶部)。"""
    fig = plt.figure(figsize=(11, 6.4))
    gs = fig.add_gridspec(2, 3, hspace=0.5, wspace=0.36)
    arms, names, labels, colors = _arm_order()

    # (a) token 成本
    ax = fig.add_subplot(gs[0, 0])
    tok = [a["tok"] for a in arms]
    bars = ax.bar(range(len(names)), tok, color=colors, width=0.62, edgecolor="black", linewidth=0.6)
    ax.set_xticks(range(len(names))); ax.set_xticklabels(labels, rotation=18, ha="right")
    ax.set_title("(a) Est. token cost"); ax.set_ylabel("token (a.u.)")
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)
    for b, v in zip(bars, tok):
        ax.text(b.get_x() + b.get_width() / 2, v, f"{v:.0f}", ha="center", va="bottom", fontsize=6.5)
    ax.margins(y=0.18)

    # (b) M1 关键漏判
    ax = fig.add_subplot(gs[0, 1])
    mm = D["m1m2"]; sm, cm = mm["stepMiss"], mm["clusterMiss"]; m1 = mm["M1"]
    ax.bar([0, 1], [sm["mean"], cm["mean"]], yerr=[sm["std"], cm["std"]],
           color=[C_STEP, C_OURS], width=0.6, edgecolor="black", linewidth=0.6,
           error_kw=dict(ecolor="black", lw=0.8, capsize=3))
    ax.set_xticks([0, 1]); ax.set_xticklabels(["step", "cluster"])
    ax.set_ylabel("critical misses / seed")
    tag = "***" if m1["p"] < 0.001 else ("**" if m1["p"] < 0.01 else ("*" if m1["p"] < 0.05 else "n.s."))
    ax.set_title(f"(b) M1: fewer misses (p={m1['p']:.3g}{', ' + tag})")
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)

    # (c) M2 System2 预算
    ax = fig.add_subplot(gs[0, 2])
    m2 = mm["M2"]; base, cl = m2["baseS2"], m2["clusterS2"]; cap = base * (1 + m2["budgetSlack"])
    ax.bar([0, 1], [base, cl], color=[C_STEP, C_OURS], width=0.6, edgecolor="black", linewidth=0.6)
    ax.axhline(cap, color=C_ACCENT, linestyle="--", linewidth=1.0)
    ax.set_xticks([0, 1]); ax.set_xticklabels(["step", "cluster"])
    ax.set_ylabel("System2 calls / seed"); ax.set_ylim(0, max(cap, cl) * 1.12)
    ax.set_title("(c) M2: no extra S2 burn")
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)

    # (d) μ 收敛
    ax = fig.add_subplot(gs[1, 0])
    mt = D["muTrace"]
    ax.plot([r["session"] for r in mt], [r["mu"] for r in mt], "-", color=C_OURS, linewidth=1.2)
    ax.set_xlabel("session"); ax.set_ylabel(r"$\mu$")
    ax.set_title(r"(d) Shadow price $\mu$")
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False); ax.margins(y=0.16)

    # (e) 竞价散点
    ax = fig.add_subplot(gs[1, 1])
    bs = D["biddingScatter"]
    rob = np.array([p["robGain"] for p in bs]); eco = np.array([p["ecoCost"] for p in bs]); ign = np.array([p["ignite"] for p in bs])
    ax.scatter(eco[ign == 0], rob[ign == 0], s=7, c=C_STEP, alpha=0.5, edgecolors="none", label="System 1")
    ax.scatter(eco[ign == 1], rob[ign == 1], s=9, c=C_OURS, alpha=0.7, edgecolors="none", label="System 2")
    lim = max(eco.max(), rob.max()) * 1.05
    ax.plot([0, lim], [0, lim], color=C_ACCENT, linestyle="--", linewidth=1.0)
    ax.set_xlim(0, lim); ax.set_ylim(0, lim)
    ax.set_xlabel("ecoAsk"); ax.set_ylabel("robBid")
    ax.set_title("(e) EMMS bidding")
    ax.legend(fontsize=6.5, loc="upper left"); ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)

    # (f) 噪声扫描
    ax = fig.add_subplot(gs[1, 2])
    nss = D["noiseSweep"]
    xx = [r["noise"] for r in nss]; yy = [-r["missDelta"] for r in nss]
    ax.plot(xx, yy, "-o", color=C_OURS, markersize=3.5, linewidth=1.3, markerfacecolor="white", markeredgewidth=1.1)
    ax.axhline(0, color="gray", linestyle=":", linewidth=0.8)
    for xi, yi, r in zip(xx, yy, nss):
        if r["p"] < 0.05:
            ax.text(xi, yi, "*", ha="center", va="bottom", fontsize=9, color=C_OK)
    ax.set_xlabel("hint noise $\\pm$"); ax.set_ylabel("misses saved")
    ax.set_title("(f) Robustness vs noise")
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)

    fig.suptitle("Meso-scale auto-cluster scheduler on real SWE-bench Pro trajectories",
                 fontsize=12, y=0.99)
    fig.savefig(os.path.join(OUT, "overview.png"))
    plt.close(fig)


if __name__ == "__main__":
    print("font in use:", TIMES)
    fig1_arm_cost()
    fig2_m1m2()
    fig3_learning()
    fig4_mu_trace()
    fig5_bidding()
    fig6_noise()
    overview()
    print("figures written to", OUT)
