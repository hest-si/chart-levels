import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyze, atr, rsiSeries } from '../dist/index.js';

// deterministic candles: a seeded random walk with optional drift and a sine wave
function candles(n, { start = 100, drift = 0, wave = 0, seed = 42, vol = 0.004 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);
  const out = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const base = start + drift * i + wave * Math.sin(i / 9);
    c = base * (1 + rnd() * vol);
    const o = i ? out[i - 1].c : c;
    const h = Math.max(o, c) * (1 + Math.abs(rnd()) * vol);
    const l = Math.min(o, c) * (1 - Math.abs(rnd()) * vol);
    out.push({ t: 1700000000 + i * 3600, o, h, l, c, v: 10 + Math.abs(rnd()) * 100 });
  }
  return out;
}

test('too little history returns null instead of guessing', () => {
  assert.equal(analyze(candles(20)), null);
});

test('a flat noisy market reads as a range with levels on both sides', () => {
  const a = analyze(candles(300, { vol: 0.012 }));
  assert.ok(a);
  assert.equal(a.trend.dir, 'range');
  assert.ok(a.sup.length >= 1 && a.sup.every((p) => p < a.price));
  assert.ok(a.res.length >= 1 && a.res.every((p) => p > a.price));
  assert.ok(a.band.lo < a.price && a.price < a.band.hi);
  assert.ok(a.trend.r2 >= 0 && a.trend.r2 <= 1);
});

test('a steady climb reads as an uptrend with a positive daily slope', () => {
  const a = analyze(candles(300, { drift: 0.2 }));
  assert.ok(a);
  assert.equal(a.trend.dir, 'up');
  assert.ok(a.trend.slopeDay > 0);
  assert.ok(a.trend.r2 > 0.5);
  assert.ok(a.rsi > 50);
});

test('a steady fall reads as a downtrend and can carry a swing line above price', () => {
  const a = analyze(candles(300, { drift: -0.2 }));
  assert.ok(a);
  assert.equal(a.trend.dir, 'down');
  assert.ok(a.trend.slopeDay < 0);
  if (a.swing) assert.ok(a.swing.t2 > a.swing.t1);
});

test('broken candles (zero lows) never become levels', () => {
  const d = candles(200, { wave: 3 });
  for (let i = 40; i < 60; i++) d[i].l = 0;
  const a = analyze(d);
  assert.ok(a);
  for (const p of [...a.sup, ...a.res]) assert.ok(p > 0 && isFinite(p));
});

test('the volume node sits inside the traded range', () => {
  const a = analyze(candles(300, { wave: 4 }));
  assert.ok(a && a.poc != null);
  const lows = Math.min(...candles(300, { wave: 4 }).map((c) => c.l));
  const highs = Math.max(...candles(300, { wave: 4 }).map((c) => c.h));
  assert.ok(a.poc >= lows && a.poc <= highs);
});

test('rsiSeries warms up and stays within 0..100', () => {
  const r = rsiSeries(candles(100));
  assert.equal(r[5], null);
  for (const x of r.slice(14)) assert.ok(x >= 0 && x <= 100);
});

test('atr is positive on real candles', () => {
  assert.ok(atr(candles(50)) > 0);
});
