/**
 * Adapter for TradingView Lightweight Charts (v4/v5): draws an Analysis on a chart
 * as native price lines and line series, and cleans up after itself.
 *
 * Structurally typed on purpose - `lightweight-charts` stays a peer you already have,
 * not a dependency of this package.
 */
import type { Analysis, Point } from './index.js';

type PriceLine = { applyOptions(o: object): void };
type Series = {
  createPriceLine(o: object): PriceLine;
  removePriceLine(l: PriceLine): void;
};
type LineSeries = Series & {
  setData(d: { time: number; value: number }[]): void;
  applyOptions(o: object): void;
};
type ChartLike = {
  addSeries?(def: unknown, o?: object): LineSeries; // v5
  addLineSeries?(o?: object): LineSeries; // v4
  removeSeries(s: unknown): void;
};

export type AttachOptions = {
  /** v5 only: the LineSeries definition, e.g. `LightweightCharts.LineSeries`. Not needed on v4. */
  lineSeries?: unknown;
  /** Added to every point time before it reaches the chart (e.g. a timezone shift you already apply). */
  timeOffset?: number;
  colors?: Partial<{
    support: string;
    resistance: string;
    channel: string;
    channelEdge: string;
    range: string;
    volumeNode: string;
    swing: string;
  }>;
  /** Axis label titles; set any to '' to hide the text. */
  titles?: Partial<{ support: string; resistance: string; range: string; volumeNode: string }>;
};

export type Attached = {
  /** Redraw with a fresh analysis (or null to hide). */
  update(a: Analysis | null): void;
  /** Remove every line and series this attach created. */
  remove(): void;
};

const DEFAULTS = {
  support: '#1f9d63',
  resistance: '#d6455e',
  channel: 'rgba(120,120,120,0.9)',
  channelEdge: 'rgba(120,120,120,0.45)',
  range: 'rgba(120,120,120,0.8)',
  volumeNode: 'rgba(120,120,120,0.7)',
  swing: 'rgba(90,90,90,0.9)',
};

/** Attach an analysis to a chart: the main (price) series receives the labelled price lines. */
export function attachLevels(chart: ChartLike, mainSeries: Series, opts: AttachOptions = {}): Attached {
  const colors = { ...DEFAULTS, ...(opts.colors || {}) };
  const titles = { support: 'Support', resistance: 'Resist', range: 'Range', volumeNode: 'Vol Node', ...(opts.titles || {}) };
  const off = opts.timeOffset || 0;
  const mkSeries = (): LineSeries => {
    if (chart.addSeries) return chart.addSeries(opts.lineSeries, base);
    if (chart.addLineSeries) return chart.addLineSeries(base);
    throw new Error('chart has neither addSeries (v5) nor addLineSeries (v4)');
  };
  const base = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: false };
  const center = mkSeries();
  const upper = mkSeries();
  const lower = mkSeries();
  const swing = mkSeries();
  center.applyOptions({ color: colors.channel, lineWidth: 2 });
  upper.applyOptions({ color: colors.channelEdge, lineStyle: 2 });
  lower.applyOptions({ color: colors.channelEdge, lineStyle: 2 });
  swing.applyOptions({ color: colors.swing, lineWidth: 2 });
  let lines: PriceLine[] = [];
  const pts = (a: Point[]) => a.map((x) => ({ time: x.t + off, value: x.v }));

  function update(a: Analysis | null) {
    for (const l of lines) {
      try {
        mainSeries.removePriceLine(l);
      } catch {
        /* the series may have been rebuilt by the host app */
      }
    }
    lines = [];
    const on = !!a;
    center.applyOptions({ visible: on });
    upper.applyOptions({ visible: on });
    lower.applyOptions({ visible: on });
    swing.applyOptions({ visible: !!(a && a.swing) });
    if (!a) return;
    center.setData(pts(a.trend.line));
    upper.setData(pts(a.trend.up));
    lower.setData(pts(a.trend.dn));
    swing.setData(a.swing ? [{ time: a.swing.t1 + off, value: a.swing.p1 }, { time: a.swing.t2 + off, value: a.swing.p2 }] : []);
    const mk = (price: number, color: string, title: string, lineStyle = 0, lineWidth = 1) => {
      if (price > 0 && isFinite(price)) lines.push(mainSeries.createPriceLine({ price, color, title, lineStyle, lineWidth, axisLabelVisible: true }));
    };
    a.sup.forEach((p, i) => mk(p, colors.support, titles.support + (a.sup.length > 1 ? ' ' + (i + 1) : '')));
    a.res.forEach((p, i) => mk(p, colors.resistance, titles.resistance + (a.res.length > 1 ? ' ' + (i + 1) : '')));
    mk(a.band.hi, colors.range, titles.range, 1);
    mk(a.band.lo, colors.range, titles.range, 1);
    if (a.poc != null) mk(a.poc, colors.volumeNode, titles.volumeNode, 4);
  }

  function remove() {
    update(null);
    for (const s of [center, upper, lower, swing]) {
      try {
        chart.removeSeries(s);
      } catch {
        /* already gone */
      }
    }
  }

  return { update, remove };
}
