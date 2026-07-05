// Tiled WebGL2 image viewer: pan/zoom camera over an image pyramid served
// by the Rust backend. Level L samples every 2^L-th pixel (DS9 block-sample
// semantics), so tiles are cheap even on multi-GB mmap'd files.
//
// Draw strategy: the coarsest level (whole image in one tile per axis) is
// fetched eagerly and drawn as a backdrop every frame; visible tiles at the
// target level draw on top as they stream in. Missing tiles therefore show
// a low-res preview instead of holes.

import { getReadout, getScaleLimits, getTile, TILE, type PixelRegion, type ScaleMode } from "../api";
import { COLORMAPS } from "./colormaps.gen";
import { drawRegions } from "./regionlayer";
import {
  createTileProgram,
  createTileTexture,
  uploadLut,
  type Stretch,
  type TileProgram,
  STRETCHES,
} from "./gl";

const MAX_GPU_TILES = 600; // ~150 MB of R32F at 256²
const NAN_READOUT = "NaN";

interface CachedTile {
  tex: WebGLTexture;
  w: number;
  h: number;
  lastUsed: number;
}

export interface ReadoutInfo {
  /** FITS 1-based pixel coordinates, or null when off-image. */
  x: number | null;
  y: number | null;
  value: string;
  /** Sexagesimal sky position, or "" when the HDU has no WCS. */
  sky: string;
}

export interface ViewerCallbacks {
  onReadout(info: ReadoutInfo): void;
  onLimits(lo: number, hi: number): void;
  /** Right-drag colormap adjustment (defaults: bias 0.5, contrast 1). */
  onContrastBias(bias: number, contrast: number): void;
}

interface ImageRef {
  path: string;
  hdu: number;
  nx: number;
  ny: number;
  maxLevel: number;
}

export class Viewer {
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly p: TileProgram;
  private readonly callbacks: ViewerCallbacks;
  /** Loaded region overlay (pixel space of the current HDU), or null. */
  private regions: PixelRegion[] | null = null;

  private image: ImageRef | null = null;
  /** Bumped on setImage; stale async responses are discarded. */
  private generation = 0;

  // Camera: image-pixel coordinates of the canvas center, and device pixels
  // per image pixel.
  private cx = 0;
  private cy = 0;
  private scale = 1;
  /** Until the user pans/zooms, resizes re-fit (covers the canvas getting
   *  its real size only after the pane becomes visible). */
  private userNavigated = false;

  private limits: [number, number] = [0, 1];
  /** Tiles draw only once real limits arrive — avoids a wrong-stretch flash. */
  private limitsReady = false;
  private stretchIndex = 0;
  // DS9-style colormap manipulation (right-drag), applied in the shader.
  private bias = 0.5;
  private contrast = 1.0;

  private tiles = new Map<string, CachedTile>();
  private inflight = new Set<string>();
  private tick = 0;
  private drawQueued = false;

  // Readout throttling: at most one get_readout in flight.
  private readoutBusy = false;
  private readoutPending: [number, number] | null = null;
  /** Last sky string, shown while the next readout is in flight so the
   *  status bar doesn't flicker between updates. */
  private lastSky = "";

  constructor(container: HTMLElement, callbacks: ViewerCallbacks) {
    this.callbacks = callbacks;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "image-canvas";
    container.append(this.canvas);
    this.overlay = document.createElement("canvas");
    this.overlay.className = "region-canvas";
    container.append(this.overlay);
    this.p = createTileProgram(this.canvas);
    this.setColormap("gray");

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.bindInput();
  }

  // ---- public API -------------------------------------------------------

  async setImage(path: string, hdu: number, nx: number, ny: number): Promise<void> {
    this.generation++;
    this.clearTiles();
    this.limitsReady = false;
    this.regions = null;
    let maxLevel = 0;
    while (Math.ceil(Math.max(nx, ny) / 2 ** maxLevel) > TILE) maxLevel++;
    this.image = { path, hdu, nx, ny, maxLevel };
    this.fit();
    this.resetContrastBias();
    await this.applyScaleMode("zscale");
  }

  clear(): void {
    this.generation++;
    this.image = null;
    this.regions = null;
    this.clearTiles();
    this.requestDraw();
  }

  /** Replace (or clear, with null) the region overlay. Regions are in the
   *  current HDU's 0-based pixel space (backend-resolved). */
  setRegions(regions: PixelRegion[] | null): void {
    this.regions = regions;
    this.requestDraw();
  }

  hasRegions(): boolean {
    return this.regions !== null && this.regions.length > 0;
  }

  fit(): void {
    if (!this.image) return;
    const { nx, ny } = this.image;
    this.userNavigated = false;
    this.scale = Math.max(
      1e-6,
      0.98 * Math.min(this.canvas.width / nx, this.canvas.height / ny),
    );
    this.cx = nx / 2;
    this.cy = ny / 2;
    this.requestDraw();
  }

  async applyScaleMode(mode: ScaleMode): Promise<void> {
    if (!this.image) return;
    const gen = this.generation;
    const lim = await getScaleLimits(this.image.path, this.image.hdu, mode);
    if (gen !== this.generation) return;
    this.setLimits(lim.lo, lim.hi);
  }

  /** Set display limits directly (histogram handle drag). */
  setLimits(lo: number, hi: number): void {
    this.limits = [lo, hi];
    this.limitsReady = true;
    this.callbacks.onLimits(lo, hi);
    this.requestDraw();
  }

  getLimits(): [number, number] {
    return [this.limits[0], this.limits[1]];
  }

  /** Center the view on a FITS 0-based (possibly fractional) pixel,
   *  keeping the current zoom. */
  centerOn(x: number, y: number): void {
    this.userNavigated = true;
    this.cx = x + 0.5;
    this.cy = y + 0.5;
    this.requestDraw();
  }

  resetContrastBias(): void {
    this.bias = 0.5;
    this.contrast = 1.0;
    this.callbacks.onContrastBias(this.bias, this.contrast);
    this.requestDraw();
  }

  setStretch(name: Stretch): void {
    this.stretchIndex = STRETCHES.indexOf(name);
    this.requestDraw();
  }

  setColormap(name: string): void {
    const cmap = COLORMAPS.find((c) => c.name === name);
    if (!cmap) return;
    uploadLut(this.p, cmap.rgb);
    this.requestDraw();
  }

  // ---- camera & input ---------------------------------------------------

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.overlay.width = w;
      this.overlay.height = h;
      if (!this.userNavigated) this.fit();
      this.requestDraw();
    }
  }

  /** Event position → image pixel coordinates (0-based, continuous). */
  private toImage(e: MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const dx = (e.clientX - rect.left) * dpr - this.canvas.width / 2;
    const dy = (e.clientY - rect.top) * dpr - this.canvas.height / 2;
    // Screen y grows down, image y grows up.
    return [this.cx + dx / this.scale, this.cy - dy / this.scale];
  }

  /** Right-drag position → colormap params (DS9 semantics: horizontal =
   *  bias, vertical = contrast, exponential around 1 at mid-height).
   *  Bias spans −0.5..1.5 so the edges fully saturate even at contrast 1
   *  (t' = 0.5 + (t − bias)·c reaches all-white/all-black at bias ∓0.5). */
  private applyContrastBias(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    this.bias = 2 * fx - 0.5;
    this.contrast = 5 ** (1 - 2 * fy); // top 5×, middle 1, bottom ⅕
    this.callbacks.onContrastBias(this.bias, this.contrast);
    this.requestDraw();
  }

  private bindInput(): void {
    let dragging = false;
    let cbDragging = false;
    let lastX = 0;
    let lastY = 0;
    let lastRightDown = 0;

    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 2) {
        // Double-right-click resets contrast/bias, single starts a drag.
        const now = performance.now();
        if (now - lastRightDown < 350) {
          this.resetContrastBias();
        } else {
          cbDragging = true;
          this.applyContrastBias(e);
        }
        lastRightDown = now;
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
      this.updateReadout(e);
    });
    this.canvas.addEventListener("pointerup", (e) => {
      dragging = false;
      cbDragging = false;
      this.canvas.releasePointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (cbDragging) {
        this.applyContrastBias(e);
        return;
      }
      if (dragging) {
        this.userNavigated = true;
        const dpr = window.devicePixelRatio || 1;
        this.cx -= ((e.clientX - lastX) * dpr) / this.scale;
        this.cy += ((e.clientY - lastY) * dpr) / this.scale;
        lastX = e.clientX;
        lastY = e.clientY;
        this.requestDraw();
      }
      this.updateReadout(e);
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.callbacks.onReadout({ x: null, y: null, value: "", sky: "" });
    });

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (!this.image) return;
        this.userNavigated = true;
        const [ix, iy] = this.toImage(e);
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
        const minScale =
          0.5 * Math.min(this.canvas.width / this.image.nx, this.canvas.height / this.image.ny);
        this.scale = Math.min(64, Math.max(minScale, this.scale * factor));
        // Keep the image point under the cursor fixed.
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const dx = (e.clientX - rect.left) * dpr - this.canvas.width / 2;
        const dy = (e.clientY - rect.top) * dpr - this.canvas.height / 2;
        this.cx = ix - dx / this.scale;
        this.cy = iy + dy / this.scale;
        this.requestDraw();
      },
      { passive: false },
    );

    this.canvas.addEventListener("dblclick", () => this.fit());
  }

  private updateReadout(e: MouseEvent): void {
    if (!this.image) return;
    const [fx, fy] = this.toImage(e);
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    if (x < 0 || y < 0 || x >= this.image.nx || y >= this.image.ny) {
      this.callbacks.onReadout({ x: null, y: null, value: "", sky: "" });
      return;
    }
    // DS9 shows FITS 1-based coordinates.
    this.callbacks.onReadout({ x: x + 1, y: y + 1, value: "…", sky: this.lastSky });
    this.readoutPending = [x, y];
    void this.pumpReadout();
  }

  private async pumpReadout(): Promise<void> {
    if (this.readoutBusy || !this.readoutPending || !this.image) return;
    const [x, y] = this.readoutPending;
    this.readoutPending = null;
    this.readoutBusy = true;
    const gen = this.generation;
    try {
      const r = await getReadout(this.image.path, this.image.hdu, x, y);
      if (gen === this.generation) {
        const text = r.value === null ? NAN_READOUT : formatValue(r.value);
        this.lastSky = r.sky ?? "";
        this.callbacks.onReadout({ x: x + 1, y: y + 1, value: text, sky: this.lastSky });
      }
    } catch {
      // File may have been closed mid-flight; readout just goes blank.
    } finally {
      this.readoutBusy = false;
      if (this.readoutPending) void this.pumpReadout();
    }
  }

  // ---- tiles ------------------------------------------------------------

  private clearTiles(): void {
    for (const t of this.tiles.values()) this.p.gl.deleteTexture(t.tex);
    this.tiles.clear();
    this.inflight.clear();
  }

  private tileKey(level: number, tx: number, ty: number): string {
    return `${level}/${tx}/${ty}`;
  }

  private requestTile(level: number, tx: number, ty: number): void {
    if (!this.image) return;
    const key = this.tileKey(level, tx, ty);
    if (this.tiles.has(key) || this.inflight.has(key)) return;
    this.inflight.add(key);
    const gen = this.generation;
    const { path, hdu } = this.image;
    getTile(path, hdu, level, tx, ty)
      .then((tile) => {
        if (gen !== this.generation) return;
        this.inflight.delete(key);
        const tex = createTileTexture(this.p.gl, tile.w, tile.h, tile.data);
        this.tiles.set(key, { tex, w: tile.w, h: tile.h, lastUsed: this.tick });
        this.evict();
        this.requestDraw();
      })
      .catch((err: unknown) => {
        this.inflight.delete(key);
        console.error(`tile ${key} failed:`, err);
      });
  }

  private evict(): void {
    if (this.tiles.size <= MAX_GPU_TILES) return;
    const entries = [...this.tiles.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const drop = entries.slice(0, this.tiles.size - MAX_GPU_TILES);
    for (const [key, t] of drop) {
      // Never evict the backdrop level; it's tiny and always needed.
      if (this.image && key.startsWith(`${this.image.maxLevel}/`)) continue;
      this.p.gl.deleteTexture(t.tex);
      this.tiles.delete(key);
    }
  }

  // ---- drawing ----------------------------------------------------------

  private requestDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  /** Draw all cached tiles of `level` that intersect the view; request
   *  missing ones. With render=false only requests (prefetch while scale
   *  limits are still being computed). Returns true if fully covered. */
  private drawLevel(level: number, request: boolean, render = true): boolean {
    if (!this.image) return false;
    const { gl, uniforms } = this.p;
    const { nx, ny } = this.image;
    const stride = 2 ** level;
    const lw = Math.ceil(nx / stride);
    const lh = Math.ceil(ny / stride);

    // Visible image rect from the camera.
    const halfW = this.canvas.width / 2 / this.scale;
    const halfH = this.canvas.height / 2 / this.scale;
    const ix0 = Math.max(0, this.cx - halfW);
    const ix1 = Math.min(nx, this.cx + halfW);
    const iy0 = Math.max(0, this.cy - halfH);
    const iy1 = Math.min(ny, this.cy + halfH);
    if (ix0 >= ix1 || iy0 >= iy1) return true;

    const t0x = Math.floor(ix0 / stride / TILE);
    const t1x = Math.min(Math.ceil(lw / TILE) - 1, Math.floor((ix1 - 1) / stride / TILE));
    const t0y = Math.floor(iy0 / stride / TILE);
    const t1y = Math.min(Math.ceil(lh / TILE) - 1, Math.floor((iy1 - 1) / stride / TILE));

    let complete = true;
    for (let ty = t0y; ty <= t1y; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const key = this.tileKey(level, tx, ty);
        const tile = this.tiles.get(key);
        if (!tile) {
          complete = false;
          if (request) this.requestTile(level, tx, ty);
          continue;
        }
        tile.lastUsed = this.tick;
        if (!render) continue;
        const x0 = tx * TILE * stride;
        const y0 = ty * TILE * stride;
        const w = Math.min(tile.w * stride, nx - x0);
        const h = Math.min(tile.h * stride, ny - y0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tile.tex);
        gl.uniform4f(uniforms.rect, x0, y0, w, h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    return complete;
  }

  private drawOverlay(): void {
    drawRegions(this.overlay, this.image ? this.regions : null, {
      cx: this.cx,
      cy: this.cy,
      scale: this.scale,
      width: this.overlay.width,
      height: this.overlay.height,
      dpr: window.devicePixelRatio || 1,
    });
  }

  private draw(): void {
    const { gl, program, vao, uniforms, lutTex } = this.p;
    this.tick++;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.055, 0.06, 0.07, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawOverlay();
    if (!this.image) return;
    if (!this.limitsReady) {
      // Prefetch visible tiles while zscale runs; draw once limits arrive.
      const lvl = Math.min(
        this.image.maxLevel,
        Math.max(0, Math.floor(Math.log2(1 / this.scale))),
      );
      if (lvl !== this.image.maxLevel) this.drawLevel(this.image.maxLevel, true, false);
      this.drawLevel(lvl, true, false);
      return;
    }

    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.uniform2f(uniforms.center, this.cx, this.cy);
    gl.uniform1f(uniforms.scale, this.scale);
    gl.uniform2f(uniforms.viewport, this.canvas.width, this.canvas.height);
    gl.uniform2f(uniforms.limits, this.limits[0], this.limits[1]);
    gl.uniform2f(uniforms.cb, this.bias, this.contrast);
    gl.uniform1i(uniforms.stretch, this.stretchIndex);
    gl.uniform1i(uniforms.tex, 0);
    gl.uniform1i(uniforms.lut, 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);

    // Target level: finest level whose sampling is not coarser than the
    // screen (floor of log2 image-px-per-screen-px), clamped to the pyramid.
    const level = Math.min(
      this.image.maxLevel,
      Math.max(0, Math.floor(Math.log2(1 / this.scale))),
    );

    // Backdrop (coarsest level) first so missing tiles show a preview.
    if (level !== this.image.maxLevel) this.drawLevel(this.image.maxLevel, true);
    this.drawLevel(level, true);
    gl.bindVertexArray(null);
  }
}

function formatValue(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(6);
  return v.toPrecision(8);
}

export { STRETCHES, type Stretch } from "./gl";
export { COLORMAPS } from "./colormaps.gen";
