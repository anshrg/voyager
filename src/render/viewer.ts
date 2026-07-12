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
import {
  drawCrosshair,
  drawPolygonDraft,
  drawRegions,
  drawRubberBand,
  drawSourceMarkers,
  hitTestHandle,
  hitTestRegion,
  hitTestSourceMarkers,
  makeRegion,
  regionsInRect,
  resizeRegion,
  translateRegion,
  type CreatableShape,
  type HandleRole,
  type RegionView,
} from "./regionlayer";
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
// After the last wheel event, wait this long before fetching the settled
// level's tiles. A fast zoom burst passes through many transient levels; if
// we requested each one we'd fetch (and mostly discard) hundreds of tiles.
// During the burst the backdrop + already-cached levels keep the view filled.
const ZOOM_SETTLE_MS = 120;
// Bound on the region-edit undo stack (Cmd+Z / Cmd+Shift+Z).
const MAX_UNDO = 50;

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
  /** A region was clicked (description string) or deselected (null). */
  onRegionPick(desc: string | null): void;
  /** The region set changed (create/delete) so toolbar state can refresh. */
  onRegionsChanged(): void;
  /** The camera moved (pan/zoom/fit/centerOn). Drives multi-frame camera
   *  lock — main.ts mirrors it onto the other frames. */
  onCameraChange?(cx: number, cy: number, scale: number): void;
  /** A catalog source marker was clicked on the image (image→row reverse
   *  link). `row` is the native table row index the marker was projected from.
   *  Only fired when the markers carry row indices (same-frame overlay). */
  onSourcePick?(row: number): void;
}

/** In-progress region edit gesture (edit mode, left-drag). */
type EditDrag =
  | { mode: "move"; index: number; last: [number, number] }
  | { mode: "resize"; index: number; role: HandleRole; nodeIndex: number }
  | { mode: "create"; index: number; anchor: [number, number]; moved: boolean };

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
  private readonly resizeObserver: ResizeObserver;
  private readonly callbacks: ViewerCallbacks;
  /** Loaded region overlay (pixel space of the current HDU), or null. */
  private regions: PixelRegion[] | null = null;
  /** Region indices under the cursor / clicked (-1 = none). */
  private hoverIndex = -1;
  /** Primary selected region (drives handles + description; -1 = none). */
  private selectedIndex = -1;
  /** All highlighted regions (multi-select). Always contains selectedIndex
   *  when it is ≥ 0; empty when nothing is selected. */
  private selection = new Set<number>();
  /** In-progress rubber-band select rectangle (device px), or null. */
  private rubberBand: { x0: number; y0: number; x1: number; y1: number } | null = null;

  /** Catalog source markers as flat image-pixel pairs [x0,y0,x1,y1,…], or
   *  null. Projected from a catalog frame's RA/Dec through this image's WCS
   *  (cross-file overlay); drawn on the overlay, tracking pan/zoom. */
  private sourceMarkers: Float64Array | null = null;
  /** Native table row index per marker (one per xy pair), or null when the
   *  markers carry no row identity (cross-file overlay → no reverse link). */
  private sourceRows: Int32Array | null = null;
  private sourceColor = "#ff3b6b";

  /** Locator crosshair, pinned to an image pixel (0-based center) or null.
   *  Set by goto and table-row linking; fades out only on Escape. */
  private marker: [number, number] | null = null;
  private markerAlpha = 1;
  private markerFadeRaf: number | undefined;

  /** Region edit mode: left-drag moves/resizes/creates regions instead of
   *  panning (pan moves to ⌥+left or right-drag). */
  private editMode = false;
  /** Shape the create tool draws on an empty-space drag. */
  private createShape: CreatableShape = "circle";
  private editDrag: EditDrag | null = null;
  /** In-progress new-polygon draft (click-to-add vertices): a separate state
   *  from EditDrag since it spans multiple clicks, not one drag. Non-null
   *  while drawing; committed to `regions` on close (Enter, click near the
   *  first vertex, or dblclick), discarded on Escape or too few vertices. */
  private polygonDraft: { xs: number[]; ys: number[] } | null = null;
  /** Cursor position (image px) while a polygon draft is in progress, for
   *  the live dashed preview segment. */
  private polygonCursor: [number, number] | null = null;
  /** Region-edit undo/redo: snapshots of the full region array taken just
   *  before each mutating gesture (create/move/resize/delete). Cleared
   *  whenever the region set is replaced wholesale (load, HDU/image switch). */
  private undoStack: PixelRegion[][] = [];
  private redoStack: PixelRegion[][] = [];

  private image: ImageRef | null = null;
  /** Bumped on setImage; stale async responses are discarded. */
  private generation = 0;

  // Camera: image-pixel coordinates of the canvas center, and device pixels
  // per image pixel.
  private cx = 0;
  private cy = 0;
  private scale = 1;
  /** View rotation (radians, CCW in image y-up space). Non-zero only under
   *  WCS-align lock, where each frame is rotated so north points up and pan/
   *  zoom directions match across frames. 0 = raster drawn axis-aligned. */
  private rot = 0;
  /** Until the user pans/zooms, resizes re-fit (covers the canvas getting
   *  its real size only after the pane becomes visible). */
  private userNavigated = false;

  private limits: [number, number] = [0, 1];
  /** Tiles draw only once real limits arrive — avoids a wrong-stretch flash. */
  private limitsReady = false;
  private stretchIndex = 0;
  /** Current colormap + scale-mode names, so a multi-frame frame switch can
   *  re-sync the toolbar selects to this frame's state. */
  private colormapName = "gray";
  private scaleMode: ScaleMode = "zscale";
  // DS9-style colormap manipulation (right-drag), applied in the shader.
  private bias = 0.5;
  private contrast = 1.0;

  private tiles = new Map<string, CachedTile>();
  private inflight = new Set<string>();
  private tick = 0;
  private drawQueued = false;
  /** performance.now() of the last wheel event; target tiles are only
   *  requested once the zoom has been idle for ZOOM_SETTLE_MS. */
  private lastWheelAt = -Infinity;
  private zoomSettleTimer: ReturnType<typeof setTimeout> | undefined;

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

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.bindInput();
  }

  /** Tear down this frame's Viewer: free GPU resources, stop observing, and
   *  detach its canvases. Called when a multi-frame frame is closed. */
  destroy(): void {
    this.resizeObserver.disconnect();
    if (this.markerFadeRaf !== undefined) cancelAnimationFrame(this.markerFadeRaf);
    clearTimeout(this.zoomSettleTimer);
    this.clearTiles();
    const gl = this.p.gl;
    gl.deleteTexture(this.p.lutTex);
    gl.deleteProgram(this.p.program);
    // Prompt the browser to reclaim the context immediately (WKWebView caps
    // simultaneous WebGL contexts; frames come and go).
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.remove();
    this.overlay.remove();
  }

  // ---- public API -------------------------------------------------------

  async setImage(path: string, hdu: number, nx: number, ny: number): Promise<void> {
    this.generation++;
    this.clearTiles();
    this.limitsReady = false;
    this.regions = null;
    this.hoverIndex = -1;
    this.clearSelection();
    this.editDrag = null;
    this.rubberBand = null;
    this.polygonDraft = null;
    this.polygonCursor = null;
    this.undoStack = [];
    this.redoStack = [];
    this.cancelMarker();
    // Markers are projected through the outgoing image's WCS; drop them.
    this.sourceMarkers = null;
    this.sourceRows = null;
    let maxLevel = 0;
    while (Math.ceil(Math.max(nx, ny) / 2 ** maxLevel) > TILE) maxLevel++;
    this.image = { path, hdu, nx, ny, maxLevel };
    // Rotation is re-applied by the host under WCS-align lock (loadFrameImage);
    // default to axis-aligned so a plain image open is never rotated.
    this.rot = 0;
    this.fit();
    this.resetContrastBias();
    await this.applyScaleMode("zscale");
  }

  clear(): void {
    this.generation++;
    this.image = null;
    this.rot = 0;
    this.regions = null;
    this.hoverIndex = -1;
    this.clearSelection();
    this.editDrag = null;
    this.rubberBand = null;
    this.polygonDraft = null;
    this.polygonCursor = null;
    this.undoStack = [];
    this.redoStack = [];
    this.cancelMarker();
    this.sourceMarkers = null;
    this.sourceRows = null;
    this.clearTiles();
    this.requestDraw();
  }

  /** Drop a locator crosshair at a FITS 0-based (fractional) image pixel and
   *  keep it there (no auto-fade). Used by goto and table-row linking. */
  setMarker(x: number, y: number): void {
    if (this.markerFadeRaf !== undefined) {
      cancelAnimationFrame(this.markerFadeRaf);
      this.markerFadeRaf = undefined;
    }
    this.marker = [x, y];
    this.markerAlpha = 1;
    this.requestDraw();
  }

  /** Overlay catalog source markers (flat [x0,y0,x1,y1,…] in this image's
   *  0-based pixel space), or null to clear. `rows` carries the native table
   *  row index per marker for the image→row reverse link (null = no link). */
  setSourceMarkers(pts: Float64Array | null, rows?: Int32Array | null, color?: string): void {
    this.sourceMarkers = pts;
    this.sourceRows = pts ? rows ?? null : null;
    if (color) this.sourceColor = color;
    this.requestDraw();
  }

  hasSourceMarkers(): boolean {
    return this.sourceMarkers !== null && this.sourceMarkers.length > 0;
  }

  /** Remove the marker immediately (no fade), e.g. on image switch. */
  private cancelMarker(): void {
    if (this.markerFadeRaf !== undefined) {
      cancelAnimationFrame(this.markerFadeRaf);
      this.markerFadeRaf = undefined;
    }
    this.marker = null;
    this.markerAlpha = 1;
  }

  /** Escape: fade out the marker and drop any region selection. */
  escape(): void {
    if (this.polygonDraft) {
      this.polygonDraft = null;
      this.polygonCursor = null;
      this.drawOverlay();
    }
    if (this.selection.size > 0 || this.rubberBand) {
      this.clearSelection();
      this.rubberBand = null;
      this.callbacks.onRegionPick(null);
      this.requestDraw();
    }
    this.startMarkerFade();
  }

  /** Animate the marker's alpha to zero over ~0.9 s, then remove it. */
  private startMarkerFade(): void {
    if (this.marker === null || this.markerFadeRaf !== undefined) return;
    const start = performance.now();
    const dur = 900;
    const step = (): void => {
      if (this.marker === null) {
        this.markerFadeRaf = undefined;
        return;
      }
      const t = (performance.now() - start) / dur;
      if (t >= 1) {
        this.markerFadeRaf = undefined;
        this.marker = null;
        this.markerAlpha = 1;
        this.requestDraw();
        return;
      }
      this.markerAlpha = 1 - t;
      this.requestDraw();
      this.markerFadeRaf = requestAnimationFrame(step);
    };
    this.markerFadeRaf = requestAnimationFrame(step);
  }

  /** Replace (or clear, with null) the region overlay. Regions are in the
   *  current HDU's 0-based pixel space (backend-resolved). */
  setRegions(regions: PixelRegion[] | null): void {
    this.regions = regions;
    this.hoverIndex = -1;
    this.clearSelection();
    this.polygonDraft = null;
    this.polygonCursor = null;
    this.undoStack = [];
    this.redoStack = [];
    this.callbacks.onRegionPick(null);
    this.requestDraw();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Snapshot the current region set for undo, just before a mutating edit
   *  gesture (create/move/resize/delete). Caps the stack and drops redo
   *  history (a fresh edit invalidates any undone-then-redone future). */
  private snapshotForUndo(): void {
    this.undoStack.push(this.regions ? structuredClone(this.regions) : []);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Undo the last region edit (create/move/resize/delete). No-op if there's
   *  nothing to undo. */
  undo(): void {
    if (this.undoStack.length === 0) return;
    const prev = this.undoStack.pop()!;
    this.redoStack.push(this.regions ? structuredClone(this.regions) : []);
    this.regions = prev;
    this.hoverIndex = -1;
    this.clearSelection();
    this.callbacks.onRegionPick(null);
    this.callbacks.onRegionsChanged();
    this.requestDraw();
  }

  /** Redo the last undone region edit. No-op if there's nothing to redo. */
  redo(): void {
    if (this.redoStack.length === 0) return;
    const next = this.redoStack.pop()!;
    this.undoStack.push(this.regions ? structuredClone(this.regions) : []);
    this.regions = next;
    this.hoverIndex = -1;
    this.clearSelection();
    this.callbacks.onRegionPick(null);
    this.callbacks.onRegionsChanged();
    this.requestDraw();
  }

  hasRegions(): boolean {
    return this.regions !== null && this.regions.length > 0;
  }

  /** The live (possibly edited) region array, for saving. */
  getRegions(): PixelRegion[] {
    return this.regions ?? [];
  }

  setEditMode(on: boolean): void {
    this.editMode = on;
    this.editDrag = null;
    this.polygonDraft = null;
    this.polygonCursor = null;
    // Edit mode can create regions even with no .reg loaded — give it an
    // array to append to.
    if (on && this.regions === null) this.regions = [];
    this.canvas.style.cursor = on ? "crosshair" : "";
    this.drawOverlay();
  }

  setCreateShape(shape: CreatableShape): void {
    this.createShape = shape;
    // Switching tools mid-draft would leave an orphaned, uncommittable draft.
    if (this.polygonDraft && shape !== "polygon") {
      this.polygonDraft = null;
      this.polygonCursor = null;
      this.drawOverlay();
    }
  }

  /** Finish the in-progress polygon draft (Enter key). Same as closing by
   *  clicking near the first vertex, but works with as few clicks as the
   *  user has placed (still needs ≥3 to commit). */
  finishPolygonDraft(): void {
    this.closePolygonDraft(false);
  }

  /** Delete every selected region (edit mode). No-op if none selected. */
  deleteSelected(): void {
    if (!this.regions || this.selection.size === 0) return;
    this.snapshotForUndo();
    // Remove high indices first so lower ones stay valid.
    for (const i of [...this.selection].sort((a, b) => b - a)) this.regions.splice(i, 1);
    this.clearSelection();
    this.hoverIndex = -1;
    this.callbacks.onRegionPick(null);
    this.callbacks.onRegionsChanged();
    this.requestDraw();
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
    this.emitCamera();
    this.requestDraw();
  }

  /** Notify the host that the camera moved (multi-frame lock broadcasts it). */
  private emitCamera(): void {
    this.callbacks.onCameraChange?.(this.cx, this.cy, this.scale);
  }

  async applyScaleMode(mode: ScaleMode): Promise<void> {
    if (!this.image) return;
    this.scaleMode = mode;
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
    this.emitCamera();
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
    this.colormapName = name;
    uploadLut(this.p, cmap.rgb);
    this.requestDraw();
  }

  getColormap(): string {
    return this.colormapName;
  }

  getScaleMode(): ScaleMode {
    return this.scaleMode;
  }

  getStretch(): Stretch {
    return STRETCHES[this.stretchIndex];
  }

  /** Camera state (image-pixel center + device px per image px). */
  getCamera(): { cx: number; cy: number; scale: number } {
    return { cx: this.cx, cy: this.cy, scale: this.scale };
  }

  /** Set the camera without emitting onCameraChange — used to mirror another
   *  frame's camera under multi-frame lock (avoids broadcast recursion). */
  setCamera(cx: number, cy: number, scale: number): void {
    this.userNavigated = true;
    this.cx = cx;
    this.cy = cy;
    this.scale = scale;
    this.requestDraw();
  }

  /** View rotation in radians (CCW, image y-up). Set by WCS-align lock so the
   *  raster + overlays render at a common sky orientation. */
  setRotation(rot: number): void {
    if (rot === this.rot) return;
    this.rot = rot;
    this.requestDraw();
  }

  getRotation(): number {
    return this.rot;
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

  /** Event position → device-pixel coordinates within the canvas (the frame
   *  the region overlay and hit-testing use). */
  private toCanvasPx(e: MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return [(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr];
  }

  /** Event position → image pixel coordinates (0-based, continuous). */
  private toImage(e: MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const dx = (e.clientX - rect.left) * dpr - this.canvas.width / 2;
    const dy = (e.clientY - rect.top) * dpr - this.canvas.height / 2;
    const [ox, oy] = this.deviceToImageOffset(dx, dy);
    return [this.cx + ox, this.cy + oy];
  }

  /** Device-pixel screen offset (from the canvas center) → image-pixel offset,
   *  inverting the view rotation + y-flip. Identity direction when rot=0
   *  (screen y down ↦ image y up). */
  private deviceToImageOffset(dx: number, dy: number): [number, number] {
    // Screen y grows down, image y grows up: work in a y-up screen frame.
    const vx = dx / this.scale;
    const vy = -dy / this.scale;
    const cos = Math.cos(this.rot);
    const sin = Math.sin(this.rot);
    // Inverse rotation R(−rot): image offset = R(−rot) · (vx, vy).
    return [cos * vx + sin * vy, -sin * vx + cos * vy];
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
    let panning = false;
    let cbDragging = false;
    let lastX = 0;
    let lastY = 0;
    let downX = 0;
    let downY = 0;
    let lastRightDown = 0;
    const startPan = (e: PointerEvent): void => {
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };

    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("pointerdown", (e) => {
      downX = e.clientX;
      downY = e.clientY;
      if (e.button === 2) {
        // Right button: pans in edit mode; otherwise contrast/bias (with
        // double-right-click reset).
        if (this.editMode) {
          startPan(e);
        } else {
          const now = performance.now();
          if (now - lastRightDown < 350) this.resetContrastBias();
          else {
            cbDragging = true;
            this.applyContrastBias(e);
          }
          lastRightDown = now;
        }
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      // A polygon draft in progress consumes every plain click as a vertex
      // (or a close), ahead of multi-select/pan — modifiers don't apply mid-draft.
      if (this.polygonDraft) {
        const [ix, iy] = this.toImage(e);
        this.addPolygonVertex(ix, iy);
        return;
      }
      // Multi-select takes precedence over pan/create: cmd/shift+click a
      // region toggles it in the set; shift+drag on empty space rubber-bands.
      if ((e.shiftKey || e.metaKey) && this.regions) {
        const [mx, my] = this.toCanvasPx(e);
        const hit = hitTestRegion(this.regions, this.regionView(), mx, my);
        if (hit >= 0) {
          this.toggleSelect(hit);
          return;
        }
        if (e.shiftKey) {
          this.rubberBand = { x0: mx, y0: my, x1: mx, y1: my };
          this.drawOverlay();
          return;
        }
      }
      if (this.editMode && !e.altKey) {
        // Left-drag edits regions; ⌥+left still pans.
        const [mx, my] = this.toCanvasPx(e);
        const [ix, iy] = this.toImage(e);
        this.beginEditGesture(mx, my, ix, iy);
      } else {
        startPan(e);
        this.updateReadout(e);
      }
    });
    this.canvas.addEventListener("pointerup", (e) => {
      if (this.rubberBand) {
        this.applyRubberBand();
        this.canvas.releasePointerCapture(e.pointerId);
        return;
      }
      const wasEdit = this.editDrag !== null;
      if (wasEdit) this.endEditGesture();
      // A left press that barely moved is a click: in normal mode select the
      // region under it (or deselect). A drag with movement was a pan.
      // cmd/shift+click was already handled on pointerdown (toggle select).
      const wasClick =
        e.button === 0 &&
        !this.editMode &&
        !cbDragging &&
        !wasEdit &&
        !e.shiftKey &&
        !e.metaKey &&
        Math.hypot(e.clientX - downX, e.clientY - downY) < 4;
      panning = false;
      cbDragging = false;
      this.canvas.releasePointerCapture(e.pointerId);
      if (wasClick) {
        const [mx, my] = this.toCanvasPx(e);
        this.pickRegionAt(mx, my, false);
      }
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this.rubberBand) {
        const [mx, my] = this.toCanvasPx(e);
        this.rubberBand.x1 = mx;
        this.rubberBand.y1 = my;
        this.drawOverlay();
        this.updateReadout(e);
        return;
      }
      if (cbDragging) {
        this.applyContrastBias(e);
        return;
      }
      if (panning) {
        this.userNavigated = true;
        const dpr = window.devicePixelRatio || 1;
        const [ox, oy] = this.deviceToImageOffset(
          (e.clientX - lastX) * dpr,
          (e.clientY - lastY) * dpr,
        );
        this.cx -= ox;
        this.cy -= oy;
        lastX = e.clientX;
        lastY = e.clientY;
        this.emitCamera();
        this.requestDraw();
      } else if (this.editDrag) {
        const [ix, iy] = this.toImage(e);
        this.updateEditGesture(ix, iy);
      } else if (this.polygonDraft) {
        const [ix, iy] = this.toImage(e);
        this.polygonCursor = [ix, iy];
        this.drawOverlay();
      } else {
        const [mx, my] = this.toCanvasPx(e);
        this.updateHover(mx, my);
      }
      this.updateReadout(e);
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.callbacks.onReadout({ x: null, y: null, value: "", sky: "" });
      if (this.hoverIndex !== -1) {
        this.hoverIndex = -1;
        this.canvas.style.cursor = "";
        this.drawOverlay();
      }
    });

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (!this.image) return;
        this.userNavigated = true;
        // Mark the zoom as active; fetch the settled level's tiles only once
        // the wheel goes quiet (see ZOOM_SETTLE_MS).
        this.lastWheelAt = performance.now();
        clearTimeout(this.zoomSettleTimer);
        this.zoomSettleTimer = setTimeout(() => this.requestDraw(), ZOOM_SETTLE_MS + 10);
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
        const minScale =
          0.5 * Math.min(this.canvas.width / this.image.nx, this.canvas.height / this.image.ny);
        // Zoom toward the view center (cx/cy fixed), not the cursor — the user
        // asked for this; a zoom-to-cursor option is a parked setting.
        this.scale = Math.min(64, Math.max(minScale, this.scale * factor));
        this.emitCamera();
        this.requestDraw();
      },
      { passive: false },
    );

    this.canvas.addEventListener("dblclick", () => {
      // A dblclick's two pointerdowns already each added a vertex (via the
      // polygonDraft branch above); dedupe the accidental extra and close.
      if (this.polygonDraft) {
        this.closePolygonDraft(true);
        return;
      }
      this.fit();
    });
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

  // ---- region interaction -----------------------------------------------

  /** Update the hovered region as the cursor moves; only repaints the
   *  overlay (the GL image is unchanged) when the hover target changes. */
  private updateHover(mx: number, my: number): void {
    const view = this.regionView();
    const idx = this.regions ? hitTestRegion(this.regions, view, mx, my) : -1;
    if (this.editMode) {
      // Cursor hints the gesture: resize a handle, move a body, or draw.
      const onHandle =
        this.regions !== null &&
        this.selectedIndex >= 0 &&
        hitTestHandle(this.regions[this.selectedIndex], view, mx, my) !== null;
      this.canvas.style.cursor = onHandle ? "pointer" : idx >= 0 ? "move" : "crosshair";
    } else {
      this.canvas.style.cursor = idx >= 0 ? "pointer" : "";
    }
    if (idx !== this.hoverIndex) {
      this.hoverIndex = idx;
      this.drawOverlay();
    }
  }

  /** Empty the selection set + primary. Does not repaint or emit on its own. */
  private clearSelection(): void {
    this.selection.clear();
    this.selectedIndex = -1;
  }

  /** Select (or deselect) the region under a click. `additive` (cmd/shift)
   *  toggles it in the multi-select set; otherwise it replaces the selection.
   *  A plain click that misses every region tries a catalog source marker
   *  (image→row reverse link) before deselecting. */
  private pickRegionAt(mx: number, my: number, additive: boolean): void {
    if (!this.image) return;
    const idx = this.regions ? hitTestRegion(this.regions, this.regionView(), mx, my) : -1;
    if (additive) {
      this.toggleSelect(idx);
      return;
    }
    if (idx < 0 && this.pickSourceAt(mx, my)) return;
    this.selectRegion(idx);
  }

  /** If a catalog source marker (with a row id) is near (mx, my), report its
   *  row and return true. Enables the image→row reverse link. */
  private pickSourceAt(mx: number, my: number): boolean {
    if (!this.sourceMarkers || !this.sourceRows) return false;
    const row = hitTestSourceMarkers(this.sourceMarkers, this.sourceRows, this.regionView(), mx, my);
    if (row < 0) return false;
    this.callbacks.onSourcePick?.(row);
    return true;
  }

  /** Replace the selection with just `idx` (−1 = none), repaint, report. */
  private selectRegion(idx: number): void {
    if (!this.regions || !this.image) return;
    this.selection.clear();
    if (idx >= 0) this.selection.add(idx);
    this.selectedIndex = idx;
    this.drawOverlay();
    this.emitSelectionPick();
  }

  /** Toggle `idx` in the multi-select set (cmd/shift+click). A −1 (empty
   *  space) additive click leaves the selection unchanged. */
  private toggleSelect(idx: number): void {
    if (!this.regions || idx < 0) return;
    if (this.selection.has(idx)) {
      this.selection.delete(idx);
      if (this.selectedIndex === idx) {
        const rest = [...this.selection];
        this.selectedIndex = rest.length > 0 ? rest[rest.length - 1] : -1;
      }
    } else {
      this.selection.add(idx);
      this.selectedIndex = idx;
    }
    this.drawOverlay();
    this.emitSelectionPick();
  }

  /** Report the current selection: a single region's full description (plus
   *  its sky position, async), a count when several are selected, or clear. */
  private emitSelectionPick(): void {
    const n = this.selection.size;
    if (n === 0 || !this.regions || !this.image) {
      this.callbacks.onRegionPick(n === 0 ? null : `${n} regions selected`);
      return;
    }
    if (n > 1) {
      this.callbacks.onRegionPick(`${n} regions selected`);
      return;
    }
    const idx = this.selectedIndex >= 0 ? this.selectedIndex : [...this.selection][0];
    const reg = this.regions[idx];
    const desc = describeRegion(reg);
    this.callbacks.onRegionPick(desc);
    // Augment with the sky position of the region center, if the HDU has WCS.
    const [cx, cy] = regionCenter(reg);
    const { nx, ny, path, hdu } = this.image;
    if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return;
    const gen = this.generation;
    getReadout(path, hdu, Math.round(cx), Math.round(cy))
      .then((r) => {
        if (gen === this.generation && this.selectedIndex === idx && this.selection.size === 1 && r.sky) {
          this.callbacks.onRegionPick(`${desc}  ${r.sky}`);
        }
      })
      .catch(() => {
        // HDU has no WCS or the file closed; the pixel description stands.
      });
  }

  /** Finalize a rubber-band drag: add every region whose center lies inside
   *  the rectangle to the selection. */
  private applyRubberBand(): void {
    const rb = this.rubberBand;
    this.rubberBand = null;
    if (!rb || !this.regions) {
      this.requestDraw();
      return;
    }
    const inside = regionsInRect(this.regions, this.regionView(), rb.x0, rb.y0, rb.x1, rb.y1);
    for (const i of inside) this.selection.add(i);
    if (this.selectedIndex < 0 && inside.length > 0) {
      this.selectedIndex = inside[inside.length - 1];
    }
    this.emitSelectionPick();
    this.requestDraw();
  }

  // ---- region editing (edit mode) ---------------------------------------

  /** Decide what a left-press in edit mode starts: resize a handle of the
   *  selected region, move it, select a different one, or create a new one.
   *  Returns true (always) — the press is consumed by editing, not a pan. */
  private beginEditGesture(mx: number, my: number, ix: number, iy: number): void {
    const view = this.regionView();
    if (this.regions === null) this.regions = [];
    const regs = this.regions;
    // 1. Handle of the already-selected region → resize/rotate/node-drag.
    if (this.selectedIndex >= 0) {
      const hd = hitTestHandle(regs[this.selectedIndex], view, mx, my);
      if (hd) {
        this.snapshotForUndo();
        this.editDrag = {
          mode: "resize",
          index: this.selectedIndex,
          role: hd.role,
          nodeIndex: hd.index,
        };
        return;
      }
    }
    // 2. Body of a region → select it; move it (with the whole multi-select
    //    group) only if it was already selected (click to select first).
    const hit = hitTestRegion(regs, view, mx, my);
    if (hit >= 0) {
      if (this.selection.has(hit)) {
        this.snapshotForUndo();
        this.selectedIndex = hit;
        this.editDrag = { mode: "move", index: hit, last: [ix, iy] };
      } else {
        this.selectRegion(hit);
        this.editDrag = null;
      }
      return;
    }
    // 3. Empty space → start drawing a new region of the chosen shape.
    //    Polygon is a multi-click draft (see addPolygonVertex/closePolygonDraft);
    //    everything else is a single drag.
    if (this.createShape === "polygon") {
      this.selectRegion(-1);
      this.polygonDraft = { xs: [ix], ys: [iy] };
      this.polygonCursor = [ix, iy];
      this.drawOverlay();
      return;
    }
    this.snapshotForUndo();
    const reg = makeRegion(this.createShape, "#00ff00", ix, iy, ix, iy);
    regs.push(reg);
    this.selectedIndex = regs.length - 1;
    this.selection = new Set([this.selectedIndex]);
    this.editDrag = { mode: "create", index: this.selectedIndex, anchor: [ix, iy], moved: false };
    this.drawOverlay();
  }

  /** Add a vertex to the in-progress polygon draft, or close it if the click
   *  lands near the first vertex (with ≥3 vertices placed already). */
  private addPolygonVertex(ix: number, iy: number): void {
    const d = this.polygonDraft;
    if (!d) return;
    if (d.xs.length >= 3) {
      const dist = Math.hypot(ix - d.xs[0], iy - d.ys[0]) * this.scale;
      if (dist < this.closeThresholdPx()) {
        this.closePolygonDraft(false);
        return;
      }
    }
    d.xs.push(ix);
    d.ys.push(iy);
    this.drawOverlay();
  }

  /** Screen-space (device px) radius within which a click on the first
   *  vertex closes the polygon draft — matches the ~6 CSS-px region hit
   *  tolerance used elsewhere, with a little slack since closing is coarser
   *  than picking. */
  private closeThresholdPx(): number {
    return 8 * (window.devicePixelRatio || 1);
  }

  /** Commit the in-progress polygon draft as a new region, or discard it if
   *  fewer than 3 vertices were placed. `dedupeLast` drops the draft's final
   *  vertex if it's right on top of the previous one — a dblclick's second
   *  pointerdown adds a vertex before the dblclick event fires, so closing
   *  via dblclick needs to undo that extra point first. */
  private closePolygonDraft(dedupeLast: boolean): void {
    const d = this.polygonDraft;
    if (!d) return;
    if (dedupeLast && d.xs.length >= 2) {
      const n = d.xs.length;
      const dist = Math.hypot(d.xs[n - 1] - d.xs[n - 2], d.ys[n - 1] - d.ys[n - 2]) * this.scale;
      if (dist < this.closeThresholdPx()) {
        d.xs.pop();
        d.ys.pop();
      }
    }
    this.polygonDraft = null;
    this.polygonCursor = null;
    if (d.xs.length < 3) {
      // Too few vertices for a real polygon — discard the draft silently.
      this.drawOverlay();
      return;
    }
    this.snapshotForUndo();
    if (this.regions === null) this.regions = [];
    const reg: PixelRegion = {
      include: true,
      color: "#00ff00",
      width: null,
      dash: false,
      text: null,
      point: null,
      shape: "polygon",
      xs: d.xs,
      ys: d.ys,
    };
    this.regions.push(reg);
    this.callbacks.onRegionsChanged();
    this.selectRegion(this.regions.length - 1);
  }

  private updateEditGesture(ix: number, iy: number): void {
    const regs = this.regions;
    const d = this.editDrag;
    if (!regs || !d) return;
    switch (d.mode) {
      case "move": {
        const dx = ix - d.last[0];
        const dy = iy - d.last[1];
        // Move the whole multi-select group together (fall back to just the
        // dragged region if it somehow isn't in the set).
        const targets = this.selection.has(d.index) ? [...this.selection] : [d.index];
        for (const i of targets) translateRegion(regs[i], dx, dy);
        d.last = [ix, iy];
        break;
      }
      case "resize":
        resizeRegion(regs[d.index], d.role, d.nodeIndex, ix, iy);
        break;
      case "create": {
        d.moved = true;
        const [ax, ay] = d.anchor;
        regs[d.index] = makeRegion(this.createShape, "#00ff00", ax, ay, ix, iy);
        break;
      }
    }
    this.requestDraw();
  }

  private endEditGesture(): void {
    const d = this.editDrag;
    this.editDrag = null;
    if (!d || !this.regions) return;
    if (d.mode === "create" && !d.moved && this.createShape !== "point") {
      // A bare click on empty space (no drag): treat as deselect, not a
      // zero-size region. Nothing actually changed, so drop the snapshot
      // beginEditGesture pushed for this gesture.
      this.undoStack.pop();
      this.regions.splice(d.index, 1);
      this.selectRegion(-1);
      return;
    }
    // Report the finished region and refresh toolbar (create adds to the set).
    this.selectRegion(d.index);
    if (d.mode === "create") this.callbacks.onRegionsChanged();
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

  /** Finest pyramid level whose sampling is no coarser than the screen. */
  private targetLevel(): number {
    if (!this.image) return 0;
    return Math.min(this.image.maxLevel, Math.max(0, Math.floor(Math.log2(1 / this.scale))));
  }

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

    // Visible image rect from the camera. Under a rotated view the screen
    // rectangle maps to a rotated rectangle in image space; use its
    // axis-aligned bounding box so corner tiles are still requested.
    const sw = this.canvas.width / 2 / this.scale;
    const sh = this.canvas.height / 2 / this.scale;
    const cos = Math.abs(Math.cos(this.rot));
    const sin = Math.abs(Math.sin(this.rot));
    const halfW = sw * cos + sh * sin;
    const halfH = sw * sin + sh * cos;
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

  private regionView(): RegionView {
    return {
      cx: this.cx,
      cy: this.cy,
      scale: this.scale,
      width: this.overlay.width,
      height: this.overlay.height,
      dpr: window.devicePixelRatio || 1,
      rot: this.rot,
    };
  }

  private drawOverlay(): void {
    const view = this.regionView();
    drawRegions(this.overlay, this.image ? this.regions : null, view, {
      hover: this.hoverIndex,
      selected: this.selectedIndex,
      selection: this.selection,
      edit: this.editMode,
    });
    if (this.image && this.sourceMarkers) {
      drawSourceMarkers(this.overlay, this.sourceMarkers, view, this.sourceColor);
    }
    if (this.image && this.marker) {
      drawCrosshair(this.overlay, view, this.marker[0], this.marker[1], this.markerAlpha);
    }
    if (this.rubberBand) {
      const rb = this.rubberBand;
      drawRubberBand(this.overlay, rb.x0, rb.y0, rb.x1, rb.y1, view.dpr);
    }
    if (this.polygonDraft) {
      drawPolygonDraft(this.overlay, view, this.polygonDraft.xs, this.polygonDraft.ys, this.polygonCursor);
    }
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
      const lvl = this.targetLevel();
      if (lvl !== this.image.maxLevel) this.drawLevel(this.image.maxLevel, true, false);
      this.drawLevel(lvl, true, false);
      return;
    }

    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.uniform2f(uniforms.center, this.cx, this.cy);
    gl.uniform1f(uniforms.scale, this.scale);
    gl.uniform2f(uniforms.viewport, this.canvas.width, this.canvas.height);
    gl.uniform2f(uniforms.rot, Math.cos(this.rot), Math.sin(this.rot));
    gl.uniform2f(uniforms.limits, this.limits[0], this.limits[1]);
    gl.uniform2f(uniforms.cb, this.bias, this.contrast);
    gl.uniform1i(uniforms.stretch, this.stretchIndex);
    gl.uniform1i(uniforms.tex, 0);
    gl.uniform1i(uniforms.lut, 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);

    // Target level: finest level whose sampling is not coarser than the
    // screen (floor of log2 image-px-per-screen-px), clamped to the pyramid.
    const target = this.targetLevel();
    const zooming = performance.now() - this.lastWheelAt < ZOOM_SETTLE_MS;

    // Paint every level we already have, coarsest first so finer tiles land
    // on top. This keeps the previously-viewed (finer) level visible while
    // the new target streams in, instead of dropping to the coarse backdrop
    // — that drop was the "low-res flash" during a zoom. Only the backdrop
    // and the settled target actually request tiles; intermediate levels are
    // drawn from cache only, so we never fetch transient zoom levels.
    for (let lvl = this.image.maxLevel; lvl >= target; lvl--) {
      const request = lvl === this.image.maxLevel || (lvl === target && !zooming);
      this.drawLevel(lvl, request);
    }
    gl.bindVertexArray(null);
  }
}

/** Center pixel (0-based) of a region; polygon uses its vertex centroid. */
function regionCenter(reg: PixelRegion): [number, number] {
  if (reg.shape === "polygon") {
    const n = reg.xs.length || 1;
    const sxs = reg.xs.reduce((a, b) => a + b, 0) / n;
    const sys = reg.ys.reduce((a, b) => a + b, 0) / n;
    return [sxs, sys];
  }
  return [reg.x, reg.y];
}

/** One-line human-readable description of a region for the status bar.
 *  Coordinates are shown FITS 1-based, like the pixel readout. */
function describeRegion(reg: PixelRegion): string {
  const [cx, cy] = regionCenter(reg);
  const c = `(${(cx + 1).toFixed(1)}, ${(cy + 1).toFixed(1)})`;
  const px = (v: number): string => `${v.toFixed(1)} px`;
  switch (reg.shape) {
    case "circle":
      return `circle · center ${c} · r ${px(reg.r)}`;
    case "annulus":
      return `annulus · center ${c} · r ${reg.rin.toFixed(1)}–${px(reg.rout)}`;
    case "ellipse":
      return `ellipse · center ${c} · a ${px(reg.rx)} · b ${px(reg.ry)} · PA ${reg.angle.toFixed(1)}°`;
    case "box":
      return `box · center ${c} · ${reg.w.toFixed(1)}×${px(reg.h)} · PA ${reg.angle.toFixed(1)}°`;
    case "polygon":
      return `polygon · ${reg.xs.length} vertices · centroid ${c}`;
    case "point":
      return `point · ${c}`;
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
