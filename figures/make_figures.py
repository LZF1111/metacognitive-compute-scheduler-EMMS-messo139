#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_figures.py —— 从 fig_data.json 生成出版级科研图（Times New Roman 字体，300 dpi）。

产出 4 张图 + 1 张合成总览：
  fig1_arm_cost.png      长程三臂：总成本 / 误判 / 过度深思（柱状）
  fig2_learning.png      误判率随任务批次下降（越学越聪明，含 regime-shift 标注）
  fig3_mu_trace.png      影子价 μ 随任务收敛（EMMS 协调变量不动点）
  fig4_bidding.png       每步 (robGain, ecoCost) 竞价散点 + 点燃边界 robGain=ecoCost
  fig5_shift_acc.png     中途变性后半段决策准确率（4 臂，30-seed 均值±std）
  overview.png           2x3 合成总览

运行（须隔离用户 site-packages 以避开 numpy 版本冲突）：
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
    """直接注册 Windows 的 times.ttf，确保真正使用 Times New Roman；找不到回退 serif。"""
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
C_SKILL = "#9E9E9E"    # static-skill / router
C_OURS = "#1F4E79"     # conscious（本文，深蓝突出）
C_ACCENT = "#C0504D"   # 强调/边界线

with open(DATA, "r", encoding="utf-8") as f:
    D = json.load(f)


def fig1_arm_cost():
    arms = D["armBars"]
    names = [a["name"] for a in arms]
    cost = [a["cost"] for a in arms]
    mis = [a["mishandled"] for a in arms]
    over = [a["overdeep"] for a in arms]
    save = [a["save"] for a in arms]
    colors = [C_FULL, C_SKILL, C_OURS]

    fig, axes = plt.subplots(1, 3, figsize=(7.2, 2.5))
    titles = ["Total cost (lower is better)", "Mishandled critical steps", "Over-thinking steps"]
    data = [cost, mis, over]
    for ax, title, vals in zip(axes, titles, data):
        bars = ax.bar(range(len(names)), vals, color=colors, width=0.62,
                      edgecolor="black", linewidth=0.6)
        ax.set_xticks(range(len(names)))
        ax.set_xticklabels(names, rotation=18, ha="right")
        ax.set_title(title)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        for b, v in zip(bars, vals):
            ax.text(b.get_x() + b.get_width() / 2, v, str(v), ha="center",
                    va="bottom", fontsize=7.5)
        ax.margins(y=0.16)
    # 在成本图标注省比
    axes[0].text(2, cost[2], f"  -{save[2]:.0f}%", ha="left", va="bottom",
                 color=C_OURS, fontsize=8, fontweight="bold")
    fig.suptitle("Long-horizon task with mid-task regime shift (60 tasks x 8 steps)",
                 fontsize=10, y=1.04)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig1_arm_cost.png"))
    plt.close(fig)


def fig2_learning():
    lc = D["learningCurve"]
    x = [r["batch"] for r in lc]
    y = [r["mishandleRate"] * 100 for r in lc]
    shift_at = D["meta"]["regimeShiftAt"]  # 任务索引
    batch_size = 6
    shift_batch = shift_at / batch_size + 0.5

    fig, ax = plt.subplots(figsize=(3.5, 2.7))
    ax.plot(x, y, "-o", color=C_OURS, markersize=4, linewidth=1.4,
            markerfacecolor="white", markeredgewidth=1.2, label="conscious")
    ax.axvline(shift_batch, color=C_ACCENT, linestyle="--", linewidth=1.0)
    ax.text(shift_batch + 0.1, max(y) * 0.95, "regime shift\n(A$\\rightarrow$B)",
            color=C_ACCENT, fontsize=7.5, va="top")
    ax.set_xlabel("Task batch (6 tasks each)")
    ax.set_ylabel("Mishandled-step rate (%)")
    ax.set_title("Self-calibration over experience")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.margins(y=0.12)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig2_learning.png"))
    plt.close(fig)


def fig3_mu_trace():
    mt = D["muTrace"]
    x = [r["task"] for r in mt]
    y = [r["mu"] for r in mt]
    shift_at = D["meta"]["regimeShiftAt"]

    fig, ax = plt.subplots(figsize=(3.5, 2.7))
    ax.plot(x, y, "-", color=C_OURS, linewidth=1.4, label=r"shadow price $\mu$")
    ax.axvline(shift_at + 0.5, color=C_ACCENT, linestyle="--", linewidth=1.0)
    ax.text(shift_at + 1, max(y) * 0.98, "regime shift", color=C_ACCENT,
            fontsize=7.5, va="top")
    ax.set_xlabel("Task index")
    ax.set_ylabel(r"Coordination shadow price  $\mu$")
    ax.set_title(r"EMMS dual variable $\mu$ adaptation")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.margins(y=0.15)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig3_mu_trace.png"))
    plt.close(fig)


def fig4_bidding():
    bs = D["biddingScatter"]
    rob = np.array([p["robGain"] for p in bs])
    eco = np.array([p["ecoCost"] for p in bs])
    ign = np.array([p["ignite"] for p in bs])

    fig, ax = plt.subplots(figsize=(3.6, 2.9))
    ax.scatter(eco[ign == 0], rob[ign == 0], s=10, c=C_SKILL, alpha=0.6,
               edgecolors="none", label="System 1 (cheap)")
    ax.scatter(eco[ign == 1], rob[ign == 1], s=12, c=C_OURS, alpha=0.7,
               edgecolors="none", label="System 2 (ignite)")
    lim = max(eco.max(), rob.max()) * 1.05
    ax.plot([0, lim], [0, lim], color=C_ACCENT, linestyle="--", linewidth=1.0,
            label=r"boundary $\mathrm{robGain}=\mathrm{ecoCost}$")
    ax.set_xlim(0, lim)
    ax.set_ylim(0, lim)
    ax.set_xlabel(r"Economy cost  $\mathrm{ecoCost}=c+\lambda\,\rho$")
    ax.set_ylabel(r"Robust gain  $\mathrm{robGain}=\mu(0.5+\hat c)\,u$")
    ax.set_title("EMMS competition-coordination bidding")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.legend(loc="upper left", fontsize=6.8)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig4_bidding.png"))
    plt.close(fig)


def fig5_shift_acc():
    sb = D["shiftBars"]["arms"]
    names = [a["name"] for a in sb]
    mean = [a["mean"] for a in sb]
    std = [a["std"] for a in sb]
    colors = [C_SKILL, C_SKILL, C_SKILL, C_OURS]

    fig, ax = plt.subplots(figsize=(3.7, 2.8))
    bars = ax.bar(range(len(names)), mean, yerr=std, color=colors, width=0.62,
                  edgecolor="black", linewidth=0.6,
                  error_kw=dict(ecolor="black", lw=0.8, capsize=3))
    ax.set_xticks(range(len(names)))
    ax.set_xticklabels(names, rotation=18, ha="right")
    ax.set_ylabel("Post-shift decision accuracy (%)")
    ax.set_title("Adaptation after mid-task rule shift\n(30 seeds, mean $\\pm$ std)")
    ax.axhline(50, color="gray", linestyle=":", linewidth=0.8)
    ax.set_ylim(40, 70)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    for b, m in zip(bars, mean):
        i = list(bars).index(b)
        ax.text(b.get_x() + b.get_width() / 2, m + std[i] + 0.4,
                f"{m:.1f}", ha="center", va="bottom", fontsize=7)
    # 显著性标注
    ax.annotate("", xy=(3, 66), xytext=(2, 66),
                arrowprops=dict(arrowstyle="-", lw=0.8))
    ax.text(2.5, 66.3, "***", ha="center", fontsize=9)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig5_shift_acc.png"))
    plt.close(fig)


def overview():
    """2x3 合成总览图（用于 README 顶部）。"""
    fig = plt.figure(figsize=(10.5, 6.2))
    gs = fig.add_gridspec(2, 3, hspace=0.45, wspace=0.32)

    # (a) 成本
    ax = fig.add_subplot(gs[0, 0])
    arms = D["armBars"]
    names = [a["name"] for a in arms]
    cost = [a["cost"] for a in arms]
    colors = [C_FULL, C_SKILL, C_OURS]
    bars = ax.bar(range(len(names)), cost, color=colors, width=0.62, edgecolor="black", linewidth=0.6)
    ax.set_xticks(range(len(names))); ax.set_xticklabels(names, rotation=18, ha="right")
    ax.set_title("(a) Total compute cost"); ax.set_ylabel("cost (a.u.)")
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)
    for b, v in zip(bars, cost):
        ax.text(b.get_x() + b.get_width() / 2, v, str(v), ha="center", va="bottom", fontsize=7)
    ax.text(2, cost[2], f" -{arms[2]['save']:.0f}%", ha="left", va="bottom", color=C_OURS, fontsize=8, fontweight="bold")
    ax.margins(y=0.16)

    # (b) 误判 + 过度深思
    ax = fig.add_subplot(gs[0, 1])
    mis = [a["mishandled"] for a in arms]
    over = [a["overdeep"] for a in arms]
    w = 0.36
    xs = np.arange(len(names))
    ax.bar(xs - w / 2, mis, w, color=C_ACCENT, edgecolor="black", linewidth=0.5, label="mishandled")
    ax.bar(xs + w / 2, over, w, color="#7F9DB9", edgecolor="black", linewidth=0.5, label="over-thinking")
    ax.set_xticks(xs); ax.set_xticklabels(names, rotation=18, ha="right")
    ax.set_title("(b) Error profile"); ax.set_ylabel("count")
    ax.legend(fontsize=7); ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)

    # (c) 学习曲线
    ax = fig.add_subplot(gs[0, 2])
    lc = D["learningCurve"]
    x = [r["batch"] for r in lc]; y = [r["mishandleRate"] * 100 for r in lc]
    ax.plot(x, y, "-o", color=C_OURS, markersize=3.5, linewidth=1.3, markerfacecolor="white", markeredgewidth=1.1)
    ax.axvline(D["meta"]["regimeShiftAt"] / 6 + 0.5, color=C_ACCENT, linestyle="--", linewidth=1.0)
    ax.set_xlabel("task batch"); ax.set_ylabel("mishandle rate (%)")
    ax.set_title("(c) Self-calibration")
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False); ax.margins(y=0.12)

    # (d) μ
    ax = fig.add_subplot(gs[1, 0])
    mt = D["muTrace"]
    ax.plot([r["task"] for r in mt], [r["mu"] for r in mt], "-", color=C_OURS, linewidth=1.3)
    ax.axvline(D["meta"]["regimeShiftAt"] + 0.5, color=C_ACCENT, linestyle="--", linewidth=1.0)
    ax.set_xlabel("task index"); ax.set_ylabel(r"$\mu$")
    ax.set_title(r"(d) Shadow price $\mu$")
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False); ax.margins(y=0.15)

    # (e) 竞价散点
    ax = fig.add_subplot(gs[1, 1])
    bs = D["biddingScatter"]
    rob = np.array([p["robGain"] for p in bs]); eco = np.array([p["ecoCost"] for p in bs]); ign = np.array([p["ignite"] for p in bs])
    ax.scatter(eco[ign == 0], rob[ign == 0], s=7, c=C_SKILL, alpha=0.55, edgecolors="none", label="System 1")
    ax.scatter(eco[ign == 1], rob[ign == 1], s=9, c=C_OURS, alpha=0.7, edgecolors="none", label="System 2")
    lim = max(eco.max(), rob.max()) * 1.05
    ax.plot([0, lim], [0, lim], color=C_ACCENT, linestyle="--", linewidth=1.0)
    ax.set_xlim(0, lim); ax.set_ylim(0, lim)
    ax.set_xlabel("ecoCost"); ax.set_ylabel("robGain")
    ax.set_title("(e) EMMS bidding")
    ax.legend(fontsize=6.5, loc="upper left"); ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)

    # (f) shift accuracy
    ax = fig.add_subplot(gs[1, 2])
    sb = D["shiftBars"]["arms"]
    sn = [a["name"] for a in sb]; sm = [a["mean"] for a in sb]; ss = [a["std"] for a in sb]
    sc = [C_SKILL, C_SKILL, C_SKILL, C_OURS]
    ax.bar(range(len(sn)), sm, yerr=ss, color=sc, width=0.62, edgecolor="black", linewidth=0.6, error_kw=dict(ecolor="black", lw=0.8, capsize=3))
    ax.set_xticks(range(len(sn))); ax.set_xticklabels(sn, rotation=18, ha="right")
    ax.set_ylabel("post-shift acc (%)"); ax.set_ylim(40, 70)
    ax.axhline(50, color="gray", linestyle=":", linewidth=0.8)
    ax.set_title("(f) Post-shift accuracy")
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)

    fig.suptitle("Metacognitive Compute Scheduler: long-horizon scheduling under mid-task regime shift",
                 fontsize=12, y=0.98)
    fig.savefig(os.path.join(OUT, "overview.png"))
    plt.close(fig)


if __name__ == "__main__":
    print("font in use:", TIMES)
    fig1_arm_cost()
    fig2_learning()
    fig3_mu_trace()
    fig4_bidding()
    fig5_shift_acc()
    overview()
    print("figures written to", OUT)
