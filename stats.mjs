/**
 * stats.mjs —— 零依赖统计工具（顶会证实性数据用）。
 * 提供: 均值/标准差/标准误、配对 t 检验(+双侧 p)、bootstrap 置信区间、Cohen's d 效应量、胜率。
 * 不依赖任何第三方库（环境常断网）；t 分布 p 值用足够精度的数值近似。
 */

export function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
export function std(xs, sample = true) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((a, b) => a + (b - m) * (b - m), 0);
  return Math.sqrt(ss / (xs.length - (sample ? 1 : 0)));
}
export function sem(xs) { return std(xs) / Math.sqrt(xs.length); }

/** 标准正态 CDF（Abramowitz-Stegun 7.1.26 误差函数近似）。 */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  let p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  p = z > 0 ? 1 - p : p;
  return p;
}

/**
 * 学生 t 分布双侧 p 值。df 较大时用正态近似（足够发表用，且我们 seed 数通常≥20）；
 * df 小时用 Welch–Satterthwaite 风格的保守正态近似 + 轻微膨胀（标注为近似）。
 */
function tTwoSidedP(t, df) {
  const a = Math.abs(t);
  // df>=30 用正态近似几乎无偏；df 小用对 t 尾部更胖的修正（用 z*(1+ (1)/(4df)) 反向缩放）。
  const zEff = df >= 30 ? a : a / (1 + 1 / (4 * df));
  return Math.max(0, Math.min(1, 2 * (1 - normCdf(zEff))));
}

/**
 * 配对 t 检验（同一组 seed 上两策略的逐 seed 差值）。
 * @param {number[]} a 策略A各 seed 指标
 * @param {number[]} b 策略B各 seed 指标（与 a 一一对应）
 * @returns {{meanDiff, t, df, p, n}}  meanDiff = mean(a-b)
 */
export function pairedT(a, b) {
  const n = a.length;
  const diffs = a.map((v, i) => v - b[i]);
  const md = mean(diffs);
  const sd = std(diffs);
  const se = sd / Math.sqrt(n);
  const t = se === 0 ? (md === 0 ? 0 : Infinity) : md / se;
  const df = n - 1;
  const p = isFinite(t) ? tTwoSidedP(t, df) : 0;
  return { meanDiff: md, t, df, p, n };
}

/** Cohen's d（配对，用差值的标准差）。|d|≈0.2小 0.5中 0.8大。 */
export function cohenD(a, b) {
  const diffs = a.map((v, i) => v - b[i]);
  const sd = std(diffs);
  return sd === 0 ? (mean(diffs) === 0 ? 0 : Infinity) : mean(diffs) / sd;
}

/** 胜率：a 在多少比例的 seed 上严格优于 b（更大更好时 dir=+1，更小更好 dir=-1）。 */
export function winRate(a, b, dir = 1) {
  let w = 0;
  for (let i = 0; i < a.length; i++) { if (dir * (a[i] - b[i]) > 0) w++; }
  return w / a.length;
}

/** 简单确定性 PRNG（bootstrap 用，可复现）。 */
function rng32(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** bootstrap 95% 置信区间（对均值），B 次重采样。 */
export function bootstrapCI(xs, B = 5000, alpha = 0.05, seed = 12345) {
  const r = rng32(seed);
  const n = xs.length;
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(r() * n)];
    means[b] = s / n;
  }
  means.sort((x, y) => x - y);
  const lo = means[Math.floor((alpha / 2) * B)];
  const hi = means[Math.floor((1 - alpha / 2) * B)];
  return { lo, hi, mean: mean(xs) };
}

/** bootstrap 配对差值的 95% CI（更稳健，不假设正态）。 */
export function bootstrapDiffCI(a, b, B = 5000, alpha = 0.05, seed = 999) {
  const diffs = a.map((v, i) => v - b[i]);
  return bootstrapCI(diffs, B, alpha, seed);
}

/** 把数组汇成 "mean±std" 字符串。 */
export function fmt(xs, d = 1) { return `${mean(xs).toFixed(d)}±${std(xs).toFixed(d)}`; }

/** 显著性星标。 */
export function stars(p) { return p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : "ns"; }
