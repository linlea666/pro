"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/types";

export interface OverlayLine {
  data: (number | null)[];
  color: string;
  width?: 1 | 2 | 3;
  title: string;
  dashed?: boolean;
}

export interface PriceLineSpec {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
  width?: 1 | 2;
}

export interface MarkerSpec {
  t: number;
  position: "aboveBar" | "belowBar";
  color: string;
  text: string;
  shape?: "arrowUp" | "arrowDown" | "circle" | "square";
  size?: number;
}

export interface Segment {
  points: { t: number; v: number }[];
  color: string;
  width?: 1 | 2 | 3;
  dashed?: boolean;
}

export interface SubPane {
  title: string;
  kind: "line" | "histogram";
  /** aligned with candles */
  data: (number | null)[];
  colors?: (string | undefined)[];
  color?: string;
  height?: number;
  guides?: { value: number; color: string; title?: string }[];
  extra?: { data: (number | null)[]; color: string }[];
}

interface Props {
  candles: Candle[];
  height?: number;
  lines?: OverlayLine[];
  priceLines?: PriceLineSpec[];
  markers?: MarkerSpec[];
  segments?: Segment[];
  panes?: SubPane[];
  showVolume?: boolean;
  /** bars visible initially */
  initialBars?: number;
  onPick?: (p: { t: number; price: number; index: number }) => void;
}

/** Shift UTC timestamps so the time axis reads in the viewer's local time. */
const tzShift = () => -new Date().getTimezoneOffset() * 60;

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const fmtTime = (t: number) => {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function PriceChart({ candles, height = 440, lines = [], priceLines = [], markers = [], segments = [], panes = [], showVolume = true, initialBars = 160, onPick }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hover, setHover] = useState<{ c: Candle; extras: { title: string; color: string; v: number | null }[] } | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    const f = () => setThemeTick((x) => x + 1);
    window.addEventListener("sl-theme", f);
    const mq = matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", f);
    return () => {
      window.removeEventListener("sl-theme", f);
      mq.removeEventListener("change", f);
    };
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el || candles.length === 0) return;
    const shift = tzShift();
    const T = (t: number) => (t + shift) as UTCTimestamp;
    const up = cssVar("--up"), down = cssVar("--down");
    const text3 = cssVar("--text-3"), grid = cssVar("--chart-grid"), border = cssVar("--border");

    const paneHeights = panes.reduce((s, p) => s + (p.height ?? 110), 0);
    const chart = createChart(el, {
      height: height + paneHeights,
      autoSize: false,
      width: el.clientWidth,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: text3,
        fontSize: 11,
        attributionLogo: true,
        panes: { separatorColor: border, separatorHoverColor: border },
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: "zh-CN" },
    });
    chartRef.current = chart;

    const main = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
      priceLineVisible: true,
    });
    main.setData(candles.map((c) => ({ time: T(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));

    if (showVolume) {
      const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(candles.map((c) => ({ time: T(c.t), value: c.v, color: c.c >= c.o ? `${up}55` : `${down}55` })));
    }

    const lineSeries = lines.map((ln) => {
      const s = chart.addSeries(LineSeries, {
        color: ln.color,
        lineWidth: ln.width ?? 1,
        lineStyle: ln.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      s.setData(candles.map((c, i) => (ln.data[i] == null ? { time: T(c.t) } : { time: T(c.t), value: ln.data[i] as number })));
      return s;
    });

    for (const seg of segments) {
      const pts = [...seg.points].sort((a, b) => a.t - b.t).filter((p, i, arr) => i === 0 || p.t !== arr[i - 1].t);
      if (pts.length < 2) continue;
      const s = chart.addSeries(LineSeries, {
        color: seg.color,
        lineWidth: seg.width ?? 2,
        lineStyle: seg.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        pointMarkersVisible: false,
      });
      s.setData(pts.map((p) => ({ time: T(p.t), value: p.v })));
    }

    for (const pl of priceLines) {
      main.createPriceLine({ price: pl.price, color: pl.color, lineWidth: pl.width ?? 1, lineStyle: pl.dashed === false ? LineStyle.Solid : LineStyle.Dashed, axisLabelVisible: true, title: pl.title });
    }

    if (markers.length) {
      const ms: SeriesMarker<Time>[] = [...markers]
        .sort((a, b) => a.t - b.t)
        .map((m) => ({ time: T(m.t), position: m.position, color: m.color, shape: m.shape ?? "circle", text: m.text, size: m.size ?? 0.1 }));
      createSeriesMarkers(main, ms);
    }

    panes.forEach((p, k) => {
      const paneIndex = k + 1;
      const s =
        p.kind === "histogram"
          ? chart.addSeries(HistogramSeries, { color: p.color ?? text3, priceLineVisible: false, lastValueVisible: true, title: p.title }, paneIndex)
          : chart.addSeries(LineSeries, { color: p.color ?? cssVar("--accent"), lineWidth: 2, priceLineVisible: false, title: p.title, crosshairMarkerVisible: true }, paneIndex);
      s.setData(
        candles.map((c, i) => {
          const v = p.data[i];
          if (v == null) return { time: T(c.t) };
          return p.colors?.[i] ? { time: T(c.t), value: v, color: p.colors[i] } : { time: T(c.t), value: v };
        }),
      );
      for (const g of p.guides ?? []) s.createPriceLine({ price: g.value, color: g.color, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: g.title ?? "" });
      for (const ex of p.extra ?? []) {
        const e = chart.addSeries(LineSeries, { color: ex.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, paneIndex);
        e.setData(candles.map((c, i) => (ex.data[i] == null ? { time: T(c.t) } : { time: T(c.t), value: ex.data[i] as number })));
      }
      chart.panes()[paneIndex]?.setHeight(p.height ?? 110);
    });

    const n = candles.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - initialBars), to: n + 4 });

    const indexOf = new Map(candles.map((c, i) => [c.t + shift, i]));
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHover(null);
        return;
      }
      const i = indexOf.get(param.time as number);
      if (i === undefined) return;
      setHover({ c: candles[i], extras: lines.map((l) => ({ title: l.title, color: l.color, v: l.data[i] })) });
    });
    chart.subscribeClick((param) => {
      if (!pickRef.current || !param.time || !param.point) return;
      const i = indexOf.get(param.time as number);
      if (i === undefined) return;
      const price = main.coordinateToPrice(param.point.y);
      pickRef.current({ t: candles[i].t, price: price ?? candles[i].c, index: i });
    });

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, lines, priceLines, markers, segments, panes, height, showVolume, themeTick]);

  const last = candles[candles.length - 1];
  const shown = hover?.c ?? last;
  const chg = shown ? ((shown.c - shown.o) / shown.o) * 100 : 0;

  return (
    <div className="relative">
      {shown && (
        <div className="pointer-events-none absolute left-2 top-1 z-10 flex flex-wrap gap-x-3 gap-y-0.5 rounded-md bg-panel/80 px-2 py-1 text-[11px] text-ink-3 num">
          <span>{fmtTime(shown.t)}</span>
          <span>开 <b className="text-ink-2">{shown.o}</b></span>
          <span>高 <b className="text-ink-2">{shown.h}</b></span>
          <span>低 <b className="text-ink-2">{shown.l}</b></span>
          <span>收 <b className="text-ink-2">{shown.c}</b></span>
          <span style={{ color: chg >= 0 ? "var(--up)" : "var(--down)" }}>{chg >= 0 ? "↑" : "↓"} {chg.toFixed(2)}%</span>
          {(hover?.extras ?? lines.map((l) => ({ title: l.title, color: l.color, v: l.data[candles.length - 1] }))).map((e) => (
            <span key={e.title}>
              <span className="mr-1 inline-block h-0.5 w-3 align-middle" style={{ background: e.color }} />
              {e.title} {e.v == null ? "—" : Number(e.v).toFixed(2)}
            </span>
          ))}
        </div>
      )}
      <div ref={box} className="w-full" />
    </div>
  );
}
