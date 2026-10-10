/**
 * chart-levels - technical analysis levels computed from raw candles.
 *
 * Zero dependencies. Feed it OHLCV candles, get back everything a terminal
 * draws over price: support and resistance from clustered pivots, the
 * regression trend channel that fits the data best, an EWMA expected range,
 * the highest-volume price (volume node / POC), the classic swing trendline
 * and RSI divergence.
 *
 * All of it is plain, auditable math: no indicators-as-magic, no network, no
 * state. With too little history the analysis returns `null` instead of
 * guessing.
 */

export type Candle = {
  /** Unix time in seconds (bar open). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base-asset volume for the bar; optional, used to weight levels. */
  v?: number;
};

export type Point = { t: number; v: number };

export type Trend = {
  dir: 'up' | 'down' | 'range';
  /** Regression slope, in percent of the last price per day. */
  slopeDay: number;
  /** R² of the winning regression window: how much of the movement the line explains (0..1). */
  r2: number;
  /** Centre line of the regression channel. */
  line: Point[];
  /** Upper channel edge (+2σ of the residuals). */
  up: Point[];
  /** Lower channel edge (−2σ of the residuals). */
  dn: Point[];
};

export type Swing = { t1: number; p1: number; t2: number; p2: number };

export type Analysis = {
  /** Last close. */
  price: number;
  /** Up to two support prices below the last close, strongest first by position. */
  sup: number[];
  /** Up to two resistance prices above the last close. */
  res: number[];
  trend: Trend;
  /** The classic trendline through the last two higher lows (uptrend) or lower highs (downtrend); null in a range. */
  swing: Swing | null;
  /** The price bucket where the most volume traded (volume profile point of control); null without volume. */
  poc: number | null;
  /** RSI divergence against the last two pivots, when present. */
  div: 'bearish' | 'bullish' | null;
  /** ATR(14) as a percent of the last price. */
  atrPct: number;
  /** RSI(14), Wilder smoothing. */
  rsi: number;
  /** Expected one-day move, percent, from EWMA volatility (≈68% band). */
  bandPct: number;
  /** The same band as absolute prices around the last close. */
  band: { hi: number; lo: number };
};

export type Options = {
  /** Bar length in seconds; used to scale slope and volatility to one day. Default 3600. */
  stepSeconds?: number;
  /** Candles examined for pivots, levels and the volume node. Default 200. */
  window?: number;
  /** Candidate regression windows; the best R² wins. Default [48, 96, 168]. */
  trendWindows?: number[];
  /** Bars on each side that a pivot must dominate. Default 3. */
  pivotSpan?: number;
  /** Cluster width for levels, in ATRs. Default 0.5. */
  clusterAtr?: number;
  /** EWMA decay for the expected range. Default 0.94 (RiskMetrics). */
  ewmaLambda?: number;
  /** Minimum candles before anything is computed. Default 40. */
  minCandles?: number;
};

type Pivot = { p: number; t: number; v: number; r: number | null };

/** RSI(14) with Wilder smoothing, as a series aligned to the candles (null before it warms up). */
export function rsiSeries(data: Candle[], period = 14): (number | null)[] {
  const n = data.length;
  const out: (number | null)[] = new Array(n).fill(null);
  let g = 0;
  let l = 0;
  for (let i = 1; i < n; i++) {
    const ch = data[i].c - data[i - 1].c;
    const up = ch > 0 ? ch : 0;
    const dn = ch < 0 ? -ch : 0;
    if (i <= period) {
      g += up;
      l += dn;
      if (i === period) {
        g /= period;
        l /= period;
        out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
      }
    } else {
      g = (g * (period - 1) + up) / period;
      l = (l * (period - 1) + dn) / period;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}

/** Average true range over the last `period` bars, absolute. */
export function atr(data: Candle[], period = 14): number {
  const n = data.length;
  let sum = 0;
  let k = 0;
  for (let i = Math.max(1, n - period); i < n; i++) {
    sum += Math.max(data[i].h - data[i].l, Math.abs(data[i].h - data[i - 1].c), Math.abs(data[i].l - data[i - 1].c));
    k++;
  }
  return k ? sum / k : 0;
}

/** The full analysis. Returns null when there is not enough honest history to read. */
export function analyze(data: Candle[], opts: Options = {}): Analysis | null {
  const step = opts.stepSeconds ?? 3600;
  const windowN = opts.window ?? 200;
  const span = opts.pivotSpan ?? 3;
  const clusterW = opts.clusterAtr ?? 0.5;
  const lambda = opts.ewmaLambda ?? 0.94;
  const minN = opts.minCandles ?? 40;
  const wins = opts.trendWindows ?? [48, 96, 168];

  const n = data.length;
  if (n < minN) return null;
  const last = data[n - 1].c;
  if (!(last > 0) || !isFinite(last)) return null;

  let range = atr(data);
  if (!(range > 0)) range = last * 0.001;

  const rsiArr = rsiSeries(data);
  const rsi = Math.round(rsiArr[n - 1] ?? 50);

  // pivots over the window, with their volume and RSI; broken candles (zero or non-finite) never become levels
  const from = Math.max(15, n - windowN);
  const his: Pivot[] = [];
  const los: Pivot[] = [];
  let avgV = 0;
  for (let i = from; i < n; i++) avgV += data[i].v || 0;
  avgV /= n - from || 1;
  for (let i = from; i < n - span; i++) {
    let hi = true;
    let lo = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (data[j].h >= data[i].h) hi = false;
      if (data[j].l <= data[i].l) lo = false;
    }
    if (hi && data[i].h > 0 && isFinite(data[i].h)) his.push({ p: data[i].h, t: data[i].t, v: data[i].v || 0, r: rsiArr[i] });
    if (lo && data[i].l > 0 && isFinite(data[i].l)) los.push({ p: data[i].l, t: data[i].t, v: data[i].v || 0, r: rsiArr[i] });
  }

  // levels: pivots clustered within `clusterW` ATRs; touches, recency and the volume behind them set the strength
  type Level = { p: number; n: number; last: number; vol: number; w: number };
  const lv: Level[] = [];
  for (const x of [...his, ...los]) {
    const hit = lv.find((c) => Math.abs(c.p - x.p) <= range * clusterW);
    if (hit) {
      hit.p = (hit.p * hit.n + x.p) / (hit.n + 1);
      hit.n++;
      hit.last = Math.max(hit.last, x.t);
      hit.vol += x.v;
    } else lv.push({ p: x.p, n: 1, last: x.t, vol: x.v, w: 0 });
  }
  const tSpan = data[n - 1].t - data[from].t || 1;
  for (const c of lv) c.w = c.n + (c.last - data[from].t) / tSpan + Math.min(1.5, avgV > 0 ? (c.vol / (c.n * avgV)) * 0.5 : 0);
  const sup = lv
    .filter((c) => c.p > 0 && c.p < last * 0.998)
    .sort((a, b) => b.w - a.w)
    .slice(0, 3)
    .sort((a, b) => b.p - a.p)
    .slice(0, 2)
    .map((c) => c.p);
  const res = lv
    .filter((c) => c.p > last * 1.002 && isFinite(c.p))
    .sort((a, b) => b.w - a.w)
    .slice(0, 3)
    .sort((a, b) => a.p - b.p)
    .slice(0, 2)
    .map((c) => c.p);

  // trend: the regression window that explains the closes best (highest R²) wins; a poor fit is a range, not a trend
  let best: { m0: number; slope: number; icpt: number; sd: number; r2: number } | null = null;
  for (const wRaw of wins) {
    const W = Math.min(wRaw, n);
    if (W < 24) continue;
    const m0 = n - W;
    let xs = 0;
    let ys = 0;
    let xx = 0;
    let xy = 0;
    for (let i = m0; i < n; i++) {
      const x = i - m0;
      const y = data[i].c;
      xs += x;
      ys += y;
      xx += x * x;
      xy += x * y;
    }
    const den = W * xx - xs * xs;
    const slope = den ? (W * xy - xs * ys) / den : 0;
    const icpt = (ys - slope * xs) / W;
    const mean = ys / W;
    let sse = 0;
    let sst = 0;
    for (let i = m0; i < n; i++) {
      const d0 = data[i].c - (icpt + slope * (i - m0));
      sse += d0 * d0;
      const dm = data[i].c - mean;
      sst += dm * dm;
    }
    const r2 = sst > 0 ? Math.max(0, 1 - sse / sst) : 0;
    if (!best || r2 > best.r2) best = { m0, slope, icpt, sd: Math.sqrt(sse / W), r2 };
  }
  if (!best) return null;
  const line: Point[] = [];
  const up: Point[] = [];
  const dn: Point[] = [];
  for (let i = best.m0; i < n; i++) {
    const v = best.icpt + best.slope * (i - best.m0);
    line.push({ t: data[i].t, v });
    up.push({ t: data[i].t, v: v + 2 * best.sd });
    dn.push({ t: data[i].t, v: v - 2 * best.sd });
  }
  const slopeDay = (best.slope / last) * 100 * (86400 / step);

  // expected one-day range from EWMA volatility (RiskMetrics): reacts to a regime change faster than a flat average
  let v2 = 0;
  let seen = false;
  for (let i = Math.max(1, n - 168); i < n; i++) {
    const r0 = Math.log(data[i].c / data[i - 1].c);
    if (isFinite(r0)) {
      v2 = seen ? lambda * v2 + (1 - lambda) * r0 * r0 : r0 * r0;
      seen = true;
    }
  }
  const sig = Math.sqrt(v2) * Math.sqrt(86400 / step);
  const bandPct = sig * 100;

  // volume node: the price bucket where the most volume traded (the price the market keeps returning to)
  let poc: number | null = null;
  let pmin = Infinity;
  let pmax = 0;
  for (let i = from; i < n; i++) {
    const mid = (data[i].h + data[i].l) / 2;
    if (mid > 0 && isFinite(mid)) {
      if (mid < pmin) pmin = mid;
      if (mid > pmax) pmax = mid;
    }
  }
  if (pmax > pmin) {
    const BINS = 36;
    const vols = new Array(BINS).fill(0);
    for (let i = from; i < n; i++) {
      const mid = (data[i].h + data[i].l) / 2;
      if (!(mid > 0 && isFinite(mid))) continue;
      const b = Math.min(BINS - 1, Math.floor(((mid - pmin) / (pmax - pmin)) * BINS));
      vols[b] += data[i].v || 0;
    }
    let bi = 0;
    for (let i = 1; i < BINS; i++) if (vols[i] > vols[bi]) bi = i;
    if (vols[bi] > 0) poc = pmin + (bi + 0.5) * ((pmax - pmin) / BINS);
  }

  // direction: slope, EMA order and fit quality must agree, otherwise it is a range
  const emaN = (nn: number) => {
    const k = 2 / (nn + 1);
    let e: number | null = null;
    for (let q = 0; q < n; q++) e = e == null ? data[q].c : data[q].c * k + e * (1 - k);
    return e as number;
  };
  const e20 = emaN(20);
  const e50 = emaN(50);
  const th = Math.max(0.35, bandPct * 0.12);
  const dir: Trend['dir'] =
    slopeDay > th && e20 >= e50 && best.r2 >= 0.2 ? 'up' : slopeDay < -th && e20 <= e50 && best.r2 >= 0.2 ? 'down' : 'range';

  // swing trendline: the classic line through the last two higher lows (uptrend) or lower highs (downtrend)
  let swing: Swing | null = null;
  const tLast = data[n - 1].t;
  if (dir === 'up' && los.length >= 2) {
    const a1 = los[los.length - 2];
    const a2 = los[los.length - 1];
    if (a2.p > a1.p && a2.t > a1.t) swing = { t1: a1.t, p1: a1.p, t2: tLast, p2: a1.p + ((a2.p - a1.p) * (tLast - a1.t)) / (a2.t - a1.t) };
  }
  if (dir === 'down' && his.length >= 2) {
    const b1 = his[his.length - 2];
    const b2 = his[his.length - 1];
    if (b2.p < b1.p && b2.t > b1.t) swing = { t1: b1.t, p1: b1.p, t2: tLast, p2: b1.p + ((b2.p - b1.p) * (tLast - b1.t)) / (b2.t - b1.t) };
  }
  if (swing && !(swing.p2 > 0 && isFinite(swing.p2))) swing = null;

  // RSI divergence: price makes a new extreme, RSI refuses to confirm it
  let div: Analysis['div'] = null;
  if (his.length >= 2) {
    const h1 = his[his.length - 2];
    const h2 = his[his.length - 1];
    if (h2.p > h1.p + range * 0.1 && h1.r != null && h2.r != null && h2.r < h1.r - 2) div = 'bearish';
  }
  if (!div && los.length >= 2) {
    const q1 = los[los.length - 2];
    const q2 = los[los.length - 1];
    if (q2.p < q1.p - range * 0.1 && q1.r != null && q2.r != null && q2.r > q1.r + 2) div = 'bullish';
  }

  return {
    price: last,
    sup,
    res,
    trend: { dir, slopeDay, r2: best.r2, line, up, dn },
    swing,
    poc,
    div,
    atrPct: (range / last) * 100,
    rsi,
    bandPct,
    band: { hi: last * Math.exp(sig), lo: last * Math.exp(-sig) },
  };
}

export { attachLevels, type Attached, type AttachOptions } from './lwc.js';
