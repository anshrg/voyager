// Pixel-distribution histogram overlay with draggable scale-limit handles.
// Counts come from the backend (same spatial sample as zscale); dragging a
// handle only updates shader uniforms via the callback, so it's one frame.

import { getHistogram, type Histogram } from "../api";

const BINS = 200;
const HANDLE_GRAB_PX = 8;

export class HistogramPanel {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly onLimits: (lo: number, hi: number) => void;

  private hist: Histogram | null = null;
  private limits: [number, number] = [0, 1];
  /** Bumped per load; stale responses are dropped. */
  private generation = 0;
  private dragging: "lo" | "hi" | null = null;

  constructor(container: HTMLElement, onLimits: (lo: number, hi: number) => void) {
    this.onLimits = onLimits;
    this.root = document.createElement("div");
    this.root.className = "hist-panel";
    this.root.style.display = "none";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "hist-canvas";
    this.root.append(this.canvas);
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

  /** Fetch counts for a newly displayed HDU. */
  async load(path: string, hdu: number): Promise<void> {
    const gen = ++this.generation;
    this.hist = null;
    this.draw();
    try {
      const h = await getHistogram(path, hdu, BINS);
      if (gen !== this.generation) return;
      this.hist = h;
      this.draw();
    } catch (err) {
      console.error("histogram failed:", err);
    }
  }

  clear(): void {
    this.generation++;
    this.hist = null;
    this.draw();
  }

  /** Viewer → panel: keep handles in sync with the active limits. */
  setLimits(lo: number, hi: number): void {
    this.limits = [lo, hi];
    if (this.visible) this.draw();
  }

  // ---- input --------------------------------------------------------------

  private valueAt(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const h = this.hist;
    return h ? h.lo + f * (h.hi - h.lo) : f;
  }

  private handleX(value: number): number {
    const h = this.hist;
    if (!h || h.hi <= h.lo) return 0;
    const f = (value - h.lo) / (h.hi - h.lo);
    return Math.min(1, Math.max(0, f)) * this.canvas.getBoundingClientRect().width;
  }

  private bindInput(): void {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.hist || e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const dLo = Math.abs(px - this.handleX(this.limits[0]));
      const dHi = Math.abs(px - this.handleX(this.limits[1]));
      if (Math.min(dLo, dHi) > HANDLE_GRAB_PX) return;
      this.dragging = dLo <= dHi ? "lo" : "hi";
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.hist) return;
      if (!this.dragging) {
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const near =
          Math.abs(px - this.handleX(this.limits[0])) <= HANDLE_GRAB_PX ||
          Math.abs(px - this.handleX(this.limits[1])) <= HANDLE_GRAB_PX;
        this.canvas.style.cursor = near ? "ew-resize" : "default";
        return;
      }
      const v = this.valueAt(e.clientX);
      let [lo, hi] = this.limits;
      // Keep a sliver of span so the shader division stays sane.
      const minSpan = (this.hist.hi - this.hist.lo) * 1e-6;
      if (this.dragging === "lo") lo = Math.min(v, hi - minSpan);
      else hi = Math.max(v, lo + minSpan);
      this.limits = [lo, hi];
      this.onLimits(lo, hi);
      this.draw();
    });
    this.canvas.addEventListener("pointerup", (e) => {
      this.dragging = null;
      this.canvas.releasePointerCapture(e.pointerId);
    });
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
      ctx.fillText("loading histogram…", 8 * dpr, h / 2);
      return;
    }

    // Log-scaled bars (astronomical images are heavily peaked).
    const maxLog = Math.max(...hist.counts.map((c) => Math.log1p(c)));
    ctx.fillStyle = "rgba(140, 170, 220, 0.75)";
    const n = hist.counts.length;
    for (let i = 0; i < n; i++) {
      const bh = maxLog > 0 ? (Math.log1p(hist.counts[i]) / maxLog) * (h - 4) : 0;
      const x0 = (i / n) * w;
      const x1 = ((i + 1) / n) * w;
      ctx.fillRect(x0, h - bh, Math.max(1, x1 - x0 - Math.min(1, dpr * 0.5)), bh);
    }

    // Shade outside the active limits, then draw the handles.
    const span = hist.hi - hist.lo;
    const fx = (v: number): number =>
      span > 0 ? Math.min(1, Math.max(0, (v - hist.lo) / span)) * w : 0;
    const xLo = fx(this.limits[0]);
    const xHi = fx(this.limits[1]);
    ctx.fillStyle = "rgba(10, 12, 16, 0.55)";
    ctx.fillRect(0, 0, xLo, h);
    ctx.fillRect(xHi, 0, w - xHi, h);
    ctx.fillStyle = "rgba(255, 190, 90, 0.95)";
    ctx.fillRect(xLo - dpr, 0, 2 * dpr, h);
    ctx.fillRect(xHi - dpr, 0, 2 * dpr, h);
  }
}
