// Pixel-distribution histogram with draggable scale-limit handles and a
// zoomable/pannable x-axis (#24). Counts come from the backend (same spatial
// sample as zscale); dragging a handle only updates shader uniforms via the
// callback, so it's one frame.
//
// The x-axis is a *view* range, independent of the data: it opens on the
// current limits widened by one limit-span each side (clipped to the data),
// so outliers don't squash the core into a few bins. Wheel zooms about the
// cursor, dragging the background pans, double-click resets, "full" shows
// the whole data range. After a zoom/pan settles, the sample is re-binned
// over just the visible range (BINS real bins across the view). ⌥-drag on a
// handle moves it at 1/10 speed.

import { getHistogram, type Histogram } from "../api";

const BINS = 200;
const HANDLE_GRAB_PX = 8;
/** Re-bin this long after the last zoom/pan step. */
const REBIN_MS = 120;
/** ⌥-drag speed factor for fine handle placement. */
const FINE = 0.1;

export class HistogramPanel {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly onLimits: (lo: number, hi: number) => void;

  /** Current bins (over hist.lo..hist.hi, which may lag the view while a
   *  re-bin is pending — bars are drawn by value, so that's seamless). */
  private hist: Histogram | null = null;
  private limits: [number, number] = [0, 1];
  /** Visible x range. */
  private view: [number, number] = [0, 1];
  private src: { path: string; hdu: number } | null = null;
  /** Bumped per request; stale responses are dropped. */
  private generation = 0;
  private rebinTimer: number | undefined;
  private drag:
    | { kind: "lo" | "hi"; x0: number; v0: number; fine: boolean }
    | { kind: "pan"; x0: number; view0: [number, number] }
    | null = null;

  /** `inline`: embedded in the sidebar Display section, always shown (#22). */
  constructor(container: HTMLElement, onLimits: (lo: number, hi: number) => void, inline = false) {
    this.onLimits = onLimits;
    this.root = document.createElement("div");
    this.root.className = inline ? "hist-panel hist-inline" : "hist-panel";
    if (!inline) this.root.style.display = "none";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "hist-canvas";
    const bar = document.createElement("div");
    bar.className = "hist-btns";
    const mk = (label: string, tip: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "hist-btn";
      b.textContent = label;
      b.title = tip;
      b.addEventListener("click", fn);
      return b;
    };
    bar.append(
      mk("fit", "View around the current limits (double-click the histogram also resets)", () =>
        this.resetView(),
      ),
      mk("full", "View the full data range (outliers included)", () => this.fullView()),
    );
    this.root.append(this.canvas, bar);
    this.root.title =
      "Drag the orange lines to set limits (⌥ = fine). Scroll to zoom the axis, drag the background to pan, double-click to reset.";
    container.append(this.root);
    this.bindInput();
    new ResizeObserver(() => this.draw()).observe(this.root);
  }

  get visible(): boolean {
    return this.root.style.display !== "none";
  }

  toggle(): boolean {
    this.root.style.display = this.visible ? "none" : "";
    if (this.visible) this.draw();
    return this.visible;
  }

  hide(): void {
    this.root.style.display = "none";
  }

  /** Fetch counts for a newly displayed HDU; the view opens around
   *  `limits` (the viewer's current display limits). */
  async load(path: string, hdu: number, limits?: [number, number]): Promise<void> {
    this.src = { path, hdu };
    if (limits) this.limits = limits;
    const gen = ++this.generation;
    this.hist = null;
    this.draw();
    try {
      const h = await getHistogram(path, hdu, BINS);
      if (gen !== this.generation) return;
      this.hist = h;
      this.view = this.defaultView();
      this.draw();
      this.rebin(0);
    } catch (err) {
      console.error("histogram failed:", err);
    }
  }

  clear(): void {
    this.generation++;
    this.src = null;
    this.hist = null;
    this.draw();
  }

  /** Viewer → panel: keep handles in sync with the active limits. */
  setLimits(lo: number, hi: number): void {
    this.limits = [lo, hi];
    if (this.visible) this.draw();
  }

  // ---- view ---------------------------------------------------------------

  /** Limits widened by one span each side, clipped to the data range. */
  private defaultView(): [number, number] {
    const h = this.hist;
    if (!h) return this.view;
    const [lo, hi] = this.limits;
    const span = hi - lo;
    if (!(span > 0)) return [h.data_lo, h.data_hi];
    const a = Math.max(h.data_lo, lo - span);
    const b = Math.min(h.data_hi, hi + span);
    return b > a ? [a, b] : [h.data_lo, h.data_hi];
  }

  private resetView(): void {
    this.view = this.defaultView();
    this.draw();
    this.rebin(0);
  }

  private fullView(): void {
    if (!this.hist) return;
    this.view = [this.hist.data_lo, this.hist.data_hi];
    this.draw();
    this.rebin(0);
  }

  /** Keep the view a sane span inside (a little beyond) the data range. */
  private clampView(v: [number, number]): [number, number] {
    const h = this.hist;
    if (!h) return v;
    const full = Math.max(h.data_hi - h.data_lo, 1e-30);
    const minSpan = full * 1e-6;
    let [a, b] = v;
    if (b - a < minSpan) {
      const c = (a + b) / 2;
      a = c - minSpan / 2;
      b = c + minSpan / 2;
    }
    if (b - a > full) return [h.data_lo, h.data_hi];
    if (a < h.data_lo) [a, b] = [h.data_lo, h.data_lo + (b - a)];
    if (b > h.data_hi) [a, b] = [h.data_hi - (b - a), h.data_hi];
    return [a, b];
  }

  /** Re-bin the sample over the view after `delay` ms (debounced). */
  private rebin(delay = REBIN_MS): void {
    clearTimeout(this.rebinTimer);
    this.rebinTimer = window.setTimeout(() => void this.fetchView(), delay);
  }

  private async fetchView(): Promise<void> {
    const src = this.src;
    if (!src || !this.hist) return;
    const gen = ++this.generation;
    const range: [number, number] = [this.view[0], this.view[1]];
    try {
      const h = await getHistogram(src.path, src.hdu, BINS, range);
      if (gen !== this.generation) return;
      this.hist = h;
      this.draw();
    } catch (err) {
      console.error("histogram re-bin failed:", err);
    }
  }

  // ---- input --------------------------------------------------------------

  private width(): number {
    return this.canvas.getBoundingClientRect().width || 1;
  }

  /** View value at a CSS-px offset from the canvas' left edge. */
  private valueAtPx(px: number): number {
    const [a, b] = this.view;
    return a + (px / this.width()) * (b - a);
  }

  private pxOf(value: number): number {
    const [a, b] = this.view;
    return b > a ? ((value - a) / (b - a)) * this.width() : 0;
  }

  private bindInput(): void {
    const localX = (e: MouseEvent): number => e.clientX - this.canvas.getBoundingClientRect().left;
    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.hist || e.button !== 0) return;
      const px = localX(e);
      const dLo = Math.abs(px - this.pxOf(this.limits[0]));
      const dHi = Math.abs(px - this.pxOf(this.limits[1]));
      const w = this.width();
      const onScreen = (v: number): boolean => this.pxOf(v) >= -1 && this.pxOf(v) <= w + 1;
      const canLo = onScreen(this.limits[0]) && dLo <= HANDLE_GRAB_PX;
      const canHi = onScreen(this.limits[1]) && dHi <= HANDLE_GRAB_PX;
      if (canLo || canHi) {
        const kind = canLo && (!canHi || dLo <= dHi) ? "lo" : "hi";
        this.drag = { kind, x0: px, v0: this.limits[kind === "lo" ? 0 : 1], fine: e.altKey };
      } else {
        this.drag = { kind: "pan", x0: px, view0: [this.view[0], this.view[1]] };
        this.canvas.style.cursor = "grabbing";
      }
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.hist) return;
      const px = localX(e);
      const d = this.drag;
      if (!d) {
        const near =
          Math.abs(px - this.pxOf(this.limits[0])) <= HANDLE_GRAB_PX ||
          Math.abs(px - this.pxOf(this.limits[1])) <= HANDLE_GRAB_PX;
        this.canvas.style.cursor = near ? "ew-resize" : "grab";
        return;
      }
      const perPx = (this.view[1] - this.view[0]) / this.width();
      if (d.kind === "pan") {
        const dv = (px - d.x0) * ((d.view0[1] - d.view0[0]) / this.width());
        this.view = this.clampView([d.view0[0] - dv, d.view0[1] - dv]);
        this.draw();
        return;
      }
      // Handle: delta-based so ⌥ can slow it; re-anchor when ⌥ toggles.
      if (e.altKey !== d.fine) {
        d.x0 = px;
        d.v0 = this.limits[d.kind === "lo" ? 0 : 1];
        d.fine = e.altKey;
      }
      const v = d.v0 + (px - d.x0) * perPx * (d.fine ? FINE : 1);
      let [lo, hi] = this.limits;
      // Keep a sliver of span so the shader division stays sane.
      const minSpan = (this.hist.data_hi - this.hist.data_lo) * 1e-9 || 1e-30;
      if (d.kind === "lo") lo = Math.min(v, hi - minSpan);
      else hi = Math.max(v, lo + minSpan);
      this.limits = [lo, hi];
      this.onLimits(lo, hi);
      this.draw();
    });
    this.canvas.addEventListener("pointerup", (e) => {
      if (this.drag?.kind === "pan") this.rebin();
      this.drag = null;
      this.canvas.style.cursor = "grab";
      this.canvas.releasePointerCapture(e.pointerId);
    });
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.hist) return;
        e.preventDefault();
        const px = localX(e);
        const anchor = this.valueAtPx(px);
        const f = Math.exp(e.deltaY * 0.0025); // > 1 zooms out
        const [a, b] = this.view;
        this.view = this.clampView([anchor - (anchor - a) * f, anchor + (b - anchor) * f]);
        this.draw();
        this.rebin();
      },
      { passive: false },
    );
    this.canvas.addEventListener("dblclick", () => this.resetView());
  }

  // ---- drawing --------------------------------------------------------------

  private draw(): void {
    if (!this.visible) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const hist = this.hist;
    if (!hist) {
      ctx.fillStyle = "rgba(200, 205, 215, 0.5)";
      ctx.font = `${12 * dpr}px system-ui`;
      ctx.fillText(this.src ? "loading histogram…" : "", 8 * dpr, h / 2);
      return;
    }
    const [va, vb] = this.view;
    const vspan = vb - va;
    const fx = (v: number): number => (vspan > 0 ? ((v - va) / vspan) * w : 0);
    const labelH = 11 * dpr;
    const plotH = h - labelH;

    // Bars by value (the bins may still span the previous view mid-zoom).
    const n = hist.counts.length;
    const bw = (hist.hi - hist.lo) / n;
    let maxLog = 0;
    for (let i = 0; i < n; i++) {
      const x0 = hist.lo + i * bw;
      if (x0 + bw >= va && x0 <= vb) maxLog = Math.max(maxLog, Math.log1p(hist.counts[i]));
    }
    ctx.fillStyle = "rgba(140, 170, 220, 0.75)";
    for (let i = 0; i < n; i++) {
      const x0 = fx(hist.lo + i * bw);
      const x1 = fx(hist.lo + (i + 1) * bw);
      if (x1 < 0 || x0 > w) continue;
      const bh = maxLog > 0 ? (Math.log1p(hist.counts[i]) / maxLog) * (plotH - 4) : 0;
      ctx.fillRect(x0, plotH - bh, Math.max(1, x1 - x0 - Math.min(1, dpr * 0.5)), bh);
    }

    // Shade outside the limits; handles, or edge arrows when off-view.
    const xLo = fx(this.limits[0]);
    const xHi = fx(this.limits[1]);
    ctx.fillStyle = "rgba(10, 12, 16, 0.55)";
    ctx.fillRect(0, 0, Math.max(0, Math.min(w, xLo)), plotH);
    ctx.fillRect(Math.max(0, Math.min(w, xHi)), 0, w - Math.max(0, Math.min(w, xHi)), plotH);
    ctx.fillStyle = "rgba(255, 190, 90, 0.95)";
    const handle = (x: number): void => {
      if (x >= 0 && x <= w) {
        ctx.fillRect(x - dpr, 0, 2 * dpr, plotH);
        return;
      }
      // Off-view: a small arrow at that edge.
      const s = 5 * dpr;
      const ex = x < 0 ? 1 * dpr : w - 1 * dpr;
      const dir = x < 0 ? 1 : -1;
      const y = plotH / 2;
      ctx.beginPath();
      ctx.moveTo(ex, y);
      ctx.lineTo(ex + dir * s, y - s);
      ctx.lineTo(ex + dir * s, y + s);
      ctx.closePath();
      ctx.fill();
    };
    handle(xLo);
    handle(xHi);

    // Axis: the view's end values.
    ctx.fillStyle = "rgba(200, 205, 215, 0.6)";
    ctx.font = `${9 * dpr}px ui-monospace, monospace`;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.fillText(fmt(va), 2 * dpr, h);
    ctx.textAlign = "right";
    ctx.fillText(fmt(vb), w - 2 * dpr, h);
  }
}

function fmt(v: number): string {
  const a = Math.abs(v);
  return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(2) : v.toPrecision(4);
}
