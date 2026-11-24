import {
  closeFits,
  exportTable,
  getBandInfo,
  getHeader,
  listOpenFiles,
  loadRegionFile,
  onOpenRequest,
  openFits,
  parseCoord,
  pickFitsFile,
  pickFitsSavePath,
  pickRegionFiles,
  pickRegionSavePath,
  getWcs,
  resolveCoord,
  savePixelRegions,
  transferRegions,
  tableColumns,
  tableColumnsF64,
  takePendingOpens,
  xmatchTables,
  type CardValue,
  type DetectedBand,
  type FileSummary,
  type HduInfo,
  type HeaderCard,
  type PixelRegion,
  type ScaleMode,
  type TableCell,
  type TableColumn,
  type XmatchSummary,
} from "./api";
import type { CreatableShape } from "./render/regionlayer";
import { HistogramPanel } from "./render/histogram";
import { TableView } from "./render/table";
import { COLORMAPS, STRETCHES, Viewer, type RegionTool, type Stretch } from "./render/viewer";
import { Wcs } from "./render/wcs";
import { MAX_BANDS, gridMismatch } from "./render/trilogy";
import {
  buildRegionPanel,
  newLayer,
  renderRegionLayers,
  type RegionLayer,
  type RegionPanelHost,
} from "./regionpanel";
import { RegionProps } from "./regionprops";
import { RegionTools } from "./regiontools";
import { compositeDraw, distinctUnits, initialRgbState, moveRgbBand, renderRgbPanel, type RgbState } from "./rgb";

type ViewTab = "image" | "table" | "header";

/** One open FITS file = one DS9-style frame. Each frame owns its own Viewer
 *  (its own canvas + WebGL context) so pan/zoom, scale limits, stretch,
 *  colormap, contrast/bias, regions, and marker all persist per frame with
 *  no capture/restore plumbing. The Viewer is created lazily the first time
 *  the frame is shown (keeps WebGL contexts down until needed). */
interface Frame {
  file: FileSummary;
  selectedHdu: number;
  tab: ViewTab;
  cards: HeaderCard[];
  /** Region layers (loaded .reg files + untitled drawn layers); file
   *  layers re-resolve per HDU (sky→WCS). Regions live in the Viewer. */
  regionLayers: RegionLayer[];
  /** Layer new regions are drawn into (null = none yet). */
  activeLayer: number | null;
  /** Container div in #frames-grid holding this frame's canvas + overlay. */
  cell: HTMLElement;
  /** Lazily created on first show; null until then. */
  viewer: Viewer | null;
  /** The image HDU currently loaded in the viewer (may differ from
   *  selectedHdu in split mode, where the sidebar can point at the table HDU
   *  while the viewer shows the file's linked image). null = viewer cleared. */
  viewerHdu: number | null;
  /** WCS of the currently shown image HDU (null = no WCS / non-image HDU).
   *  Refreshed in loadFrameImage; drives WCS-lock + catalog overlay. */
  wcs: Wcs | null;
  /** Provenance of the source markers currently on this frame's viewer: the
   *  catalog frame + its table HDU that produced them (for the marker→row
   *  reverse link, including cross-file overlays). null = no markers, or they
   *  did not come from a catalog overlay. May go stale if the markers are later
   *  cleared by an image reload — harmless, since a hit test then finds none. */
  sourceFrom: { frame: Frame; tableHdu: number } | null;
  /** Manual override for this frame's table position columns (row→image
   *  locate + overlay), bypassing the RA/Dec/X/Y name heuristics. Column
   *  indices refer to the frame's table HDU. null = auto-detect by name. */
  posOverride: PosOverride | null;
  /** RGB composite frame: its bands + display state. Its `file`/HDU are the
   *  reference band's (same grid), so WCS, lock, regions, goto and overlays
   *  work unchanged. null = an ordinary file frame. */
  composite: RgbState<Frame> | null;
  /** Band frame folded into this composite: hidden from the frame bar, grid,
   *  and cycling unless the composite chip is expanded. Kept open — the
   *  composite reads its pixels through it. */
  hiddenBy: Frame | null;
  /** Display + region state saved when this frame's Viewer was destroyed
   *  (folded into a composite), reapplied when it is rebuilt. */
  savedView?: SavedView | null;
  /** Regions to install (instead of re-reading files) on the next image
   *  load: a restored band's edits, or band layers carried into a composite. */
  pendingRegions?: PixelRegion[] | null;
}

/** A Viewer's user-visible state, kept across its destroy/rebuild. */
interface SavedView {
  colormap: string;
  stretch: Stretch;
  scaleMode: ScaleMode;
  limits: [number, number];
  bias: number;
  contrast: number;
  camera: { cx: number; cy: number; scale: number };
}

/** Destroy a frame's Viewer, keeping its display settings and regions
 *  (including unsaved edits) for when it's rebuilt. */
function retireViewer(frame: Frame): void {
  const v = frame.viewer;
  if (!v) return;
  const cb = v.getContrastBias();
  frame.savedView = {
    colormap: v.getColormap(),
    stretch: v.getStretch(),
    scaleMode: v.getScaleMode(),
    limits: v.getLimits(),
    bias: cb.bias,
    contrast: cb.contrast,
    camera: v.getCamera(),
  };
  frame.pendingRegions = structuredClone(v.getRegions());
  v.destroy();
  frame.viewer = null;
  frame.viewerHdu = null;
}

/** Reapply a retired Viewer's settings after its image has loaded (zscale
 *  has run by then, so the saved limits win). */
async function restoreSavedView(frame: Frame): Promise<void> {
  const v = frame.viewer;
  const sv = frame.savedView;
  if (!v || !sv || frame.composite) return;
  frame.savedView = null;
  v.setColormap(sv.colormap);
  v.setStretch(sv.stretch);
  if (sv.scaleMode !== v.getScaleMode()) await v.applyScaleMode(sv.scaleMode);
  v.setLimits(sv.limits[0], sv.limits[1]);
  v.setContrastBias(sv.bias, sv.contrast);
  if (lockMode === "none") v.setCamera(sv.camera.cx, sv.camera.cy, sv.camera.scale);
  if (frame === activeFrame()) syncToolbar(frame);
}

/** Manual position-column choice: RA/Dec (sky) or X/Y (pixel) column
 *  indices, set via the table tab's column picker. */
type PosOverride =
  | { kind: "sky"; raCol: number; decCol: number }
  | { kind: "pixel"; xCol: number; yCol: number };

const frames: Frame[] = [];
let active = -1;
/** Header-card filter text (shared UI, applied to the active frame's cards). */
let headerFilter = "";
/** Tiled grid layout (several frames at once) vs single active frame. */
let gridMode = false;
/** Split view: image + table side by side (for a file with both). File-level,
 *  so it persists across HDU selection; only takes effect when the active
 *  frame's file has both an image and a table HDU. */
let splitMode = false;
/** Camera-lock across frames: "wcs" aligns by sky (world→pixel per frame),
 *  "pixel" mirrors raw pixel camera (same-size images), "none" is unlocked.
 *  The Lock button cycles none→wcs→pixel. */
type LockMode = "none" | "wcs" | "pixel";
let lockMode: LockMode = "none";
/** Blink auto-cycle timer (undefined = off). */
let blinkTimer: number | undefined;
/** Region tool + draw shape (left tool bar) are global, applied to the
 *  active frame's viewer (only the active frame is editable at a time). */
let regionTool: RegionTool = "pan";
let createShape: CreatableShape = "circle";
let regionTools: RegionTools | null = null;

const BLINK_MS = 500;

let tableView: TableView | null = null;
/** `${path}#${hdu}` the shared TableView currently displays. */
let tableLoadedFor: string | null = null;
let histPanel: HistogramPanel | null = null;
/** `${path}#${hdu}` the shared histogram currently displays. */
let histLoadedFor: string | null = null;

function activeFrame(): Frame | null {
  return active >= 0 && active < frames.length ? frames[active] : null;
}

/** A band frame folded into a collapsed composite (not shown anywhere). */
function isHidden(f: Frame): boolean {
  return f.hiddenBy !== null && !f.hiddenBy.composite?.expanded;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Display names for derived (crossmatch) tables, keyed by their synthetic
 *  `voyager-derived://N` backend path. */
const derivedNames = new Map<string, string>();

function isDerivedPath(path: string): boolean {
  return path.startsWith("voyager-derived://");
}

/** User-facing name for a frame's path (match name for derived tables). */
function displayName(path: string): string {
  return derivedNames.get(path) ?? basename(path);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function kindLabel(hdu: HduInfo): string {
  switch (hdu.kind) {
    case "image":
      return hdu.shape.length === 0 ? "empty" : "image";
    case "bin_table":
      return "table";
    case "ascii_table":
      return "ascii table";
    default:
      return "unknown";
  }
}

function hduDetail(hdu: HduInfo): string {
  if (hdu.kind === "bin_table" || hdu.kind === "ascii_table") {
    const rows = hdu.nrows ?? 0;
    const cols = hdu.ncols ?? 0;
    return `${rows.toLocaleString()} rows × ${cols} cols`;
  }
  if (hdu.shape.length === 0) return "no data";
  return `${hdu.shape.join(" × ")}  (BITPIX ${hdu.bitpix})`;
}

function valueText(v: CardValue | null): string {
  if (v === null) return "";
  switch (v.type) {
    case "Str":
      return v.value;
    case "Logical":
      return v.value ? "T" : "F";
    case "Int":
      return String(v.value);
    case "Float":
      return String(v.value);
    case "Undefined":
      return "";
    case "Raw":
      return v.value;
  }
}

/** An image HDU the viewer can display (2-D or a cube's first plane). */
function isViewableImage(hdu: HduInfo): boolean {
  return (
    hdu.kind === "image" &&
    hdu.shape.length >= 2 &&
    hdu.shape[0] > 0 &&
    hdu.shape[1] > 0 &&
    hdu.data_len > 0
  );
}

/** A table HDU the table viewer can display. */
function isTableHdu(hdu: HduInfo): boolean {
  return hdu.kind === "bin_table" || hdu.kind === "ascii_table";
}

function frameHdu(frame: Frame): HduInfo {
  return frame.file.hdus[frame.selectedHdu];
}

/** A file with both an image and a table HDU → split view is available. */
function frameCanSplit(frame: Frame): boolean {
  if (frame.composite) return false;
  return frame.file.hdus.some(isViewableImage) && frame.file.hdus.some(isTableHdu);
}

/** Split view is on AND meaningful for this frame's file. */
function frameSplit(frame: Frame): boolean {
  return splitMode && frameCanSplit(frame);
}

/** The image HDU the viewer should display: the selected HDU when it is an
 *  image, else (split mode) the file's first viewable image HDU. null = the
 *  viewer shows nothing. */
function frameImageHdu(frame: Frame): number | null {
  if (isViewableImage(frameHdu(frame))) return frame.selectedHdu;
  if (frameSplit(frame)) {
    const h = frame.file.hdus.find(isViewableImage);
    return h ? h.index : null;
  }
  return null;
}

/** The table HDU the table pane should show: the selected HDU when it is a
 *  table, else (split mode) the file's first table HDU. null = no table. */
function frameTableHdu(frame: Frame): number | null {
  if (isTableHdu(frameHdu(frame))) return frame.selectedHdu;
  if (frameSplit(frame)) {
    const h = frame.file.hdus.find(isTableHdu);
    return h ? h.index : null;
  }
  return null;
}

function renderHduList(): void {
  const list = must<HTMLElement>("hdu-list");
  list.replaceChildren();
  const frame = activeFrame();
  must<HTMLElement>("sidebar-head").textContent = frame?.composite ? "RGB composite" : "HDUs";
  if (!frame) return;
  const comp = frame.composite;
  if (comp) {
    renderRgbPanel(list, comp, {
      changed: (structural) => pushComposite(frame, structural),
      rerender: () => {
        if (frame === activeFrame()) renderHduList();
      },
    });
    return;
  }
  for (const hdu of frame.file.hdus) {
    const item = el("button", "hdu-item");
    if (hdu.index === frame.selectedHdu) item.classList.add("selected");
    const title = hdu.name
      ? `${hdu.index}: ${hdu.name}`
      : `${hdu.index}: ${hdu.index === 0 ? "PRIMARY" : "(unnamed)"}`;
    item.append(
      el("div", "hdu-title", title),
      el("div", "hdu-kind", kindLabel(hdu)),
      el("div", "hdu-detail", hduDetail(hdu)),
    );
    item.addEventListener("click", () => void selectHdu(hdu.index));
    list.append(item);
  }
}

function renderCards(): void {
  const tbody = must<HTMLTableSectionElement>("card-body");
  tbody.replaceChildren();
  const frame = activeFrame();
  if (!frame) return;
  const needle = headerFilter.toLowerCase();
  for (const card of frame.cards) {
    if (
      needle &&
      !card.key.toLowerCase().includes(needle) &&
      !valueText(card.value).toLowerCase().includes(needle) &&
      !(card.comment ?? "").toLowerCase().includes(needle)
    ) {
      continue;
    }
    const tr = el("tr");
    tr.append(
      el("td", "card-key", card.key),
      el("td", "card-value", valueText(card.value)),
      el("td", "card-comment", card.comment ?? ""),
    );
    tbody.append(tr);
  }
}

function renderStatus(): void {
  const status = must<HTMLElement>("status-file");
  const frame = activeFrame();
  if (!frame) {
    status.textContent = "No file open";
    return;
  }
  const f = frame.file;
  if (frame.composite) {
    const c = frame.composite;
    const n = c.bands.filter((b) => b.include).length;
    status.textContent =
      `RGB composite (${c.mode}) — ${c.bands.map((b) => b.label).join(" + ")} — ` +
      `${c.nx}×${c.ny} — ${c.mode === "trilogy" ? `${n} of ${c.bands.length} bands mixed` : "3-color"}`;
    return;
  }
  if (isDerivedPath(f.path)) {
    const rows = f.hdus[0]?.nrows ?? 0;
    status.textContent = `${displayName(f.path)} — crossmatch result — ${rows.toLocaleString()} rows (in memory; Export… to save)`;
    return;
  }
  const plural = f.hdus.length === 1 ? "" : "s";
  status.textContent = `${f.path} — ${formatBytes(f.size)} — ${f.hdus.length} HDU${plural} — opened in ${f.open_ms.toFixed(1)} ms`;
}

/** The frame chips + multi-frame toggle button states. */
function renderFrameBar(): void {
  const bar = must<HTMLElement>("frame-bar");
  bar.replaceChildren();
  bar.style.display = frames.length > 0 ? "" : "none";
  const addChip = (frame: Frame, nested: boolean): void => {
    const i = frames.indexOf(frame);
    const chip = el("div", nested ? "frame-chip nested" : "frame-chip");
    if (i === active) chip.classList.add("active");
    const comp = frame.composite;
    if (comp) {
      chip.classList.add("rgb-chip");
      const tog = el("button", "frame-chip-close", comp.expanded ? "▾" : "▸");
      tog.title = comp.expanded ? "Hide the band frames" : "Show the band frames";
      tog.addEventListener("click", (e) => {
        e.stopPropagation();
        comp.expanded = !comp.expanded;
        // Collapsing while a band frame is active: fall back to the composite.
        if (!comp.expanded && activeFrame()?.hiddenBy === frame) void setActive(frames.indexOf(frame));
        else {
          applyGridLayout();
          renderFrameBar();
        }
      });
      chip.append(tog);
    }
    const name = el("span", "frame-chip-name", frameName(frame));
    name.title =
      (comp ? comp.bands.map((b) => `${b.label}: ${b.path}`).join("\n") : frame.file.path) +
      "\n(drag to reorder)";
    chipFrames.set(chip, frame);
    bindChipDrag(chip, frame);
    const close = el("button", "frame-chip-close", "×");
    close.title = comp ? "Close the composite (the band frames reappear)" : "Close frame";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeFrame(frames.indexOf(frame));
    });
    chip.append(name, close);
    bar.append(chip);
  };
  chipFrames.clear();
  for (const frame of frames) {
    if (frame.hiddenBy) continue; // drawn nested under its composite
    addChip(frame, false);
    // Nested in the composite's band order (which drives the rainbow).
    if (frame.composite?.expanded) for (const b of frame.composite.bands) addChip(b.frame, true);
  }
  // Previous/next frame (also [ and ]), right-aligned in the frame bar.
  if (frames.length > 1) {
    const nav = el("div", "frame-nav");
    const prev = el("button", "frame-nav-btn", "◀");
    prev.title = "Previous frame ([)";
    prev.addEventListener("click", () => cycleFrame(-1));
    const next = el("button", "frame-nav-btn", "▶");
    next.title = "Next frame (])";
    next.addEventListener("click", () => cycleFrame(1));
    nav.append(prev, next);
    bar.append(nav);
  }
  regionTools?.syncView({
    grid: gridMode,
    blink: blinkTimer !== undefined,
    lock: lockMode,
    multi: frames.length > 1,
  });
}

// ---- drag-to-reorder frame chips (#16) ---------------------------------------

/** Chip element → its frame, rebuilt on every renderFrameBar. */
const chipFrames = new Map<HTMLElement, Frame>();
/** Pointer travel (CSS px) before a press on a chip becomes a drag. */
const DRAG_START_PX = 4;

/** Press on a chip: a click activates the frame; a drag past DRAG_START_PX
 *  reorders it among its siblings — top-level chips, or (for a band chip)
 *  the other bands of the same composite. Pointer events, not HTML5 DnD
 *  (unreliable in WKWebView). */
function bindChipDrag(chip: HTMLElement, frame: Frame): void {
  chip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const bar = must<HTMLElement>("frame-bar");
    const parent = frame.hiddenBy;
    const siblings = [...chipFrames.entries()]
      .filter(([c, f]) => c !== chip && f.hiddenBy === parent)
      .map(([c]) => c);
    const x0 = e.clientX;
    let dragging = false;
    let drop: { chip: HTMLElement; after: boolean } | null = null;
    chip.setPointerCapture(e.pointerId);

    const clearMarks = (): void => {
      for (const c of siblings) c.classList.remove("drop-before", "drop-after");
    };
    const onMove = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.abs(ev.clientX - x0) < DRAG_START_PX) return;
        dragging = true;
        chip.classList.add("dragging");
      }
      // Auto-scroll the (horizontally scrolling) bar near its edges.
      const br = bar.getBoundingClientRect();
      if (ev.clientX < br.left + 30) bar.scrollLeft -= 12;
      else if (ev.clientX > br.right - 30) bar.scrollLeft += 12;
      // Nearest sibling by center; drop on whichever side the pointer is.
      clearMarks();
      drop = null;
      let best = Infinity;
      for (const c of siblings) {
        const r = c.getBoundingClientRect();
        const mid = (r.left + r.right) / 2;
        const d = Math.abs(ev.clientX - mid);
        if (d < best) {
          best = d;
          drop = { chip: c, after: ev.clientX > mid };
        }
      }
      if (drop) drop.chip.classList.add(drop.after ? "drop-after" : "drop-before");
    };
    const onEnd = (ev: PointerEvent): void => {
      chip.removeEventListener("pointermove", onMove);
      chip.removeEventListener("pointerup", onEnd);
      chip.removeEventListener("pointercancel", onEnd);
      if (chip.hasPointerCapture(ev.pointerId)) chip.releasePointerCapture(ev.pointerId);
      chip.classList.remove("dragging");
      clearMarks();
      if (!dragging) {
        if (ev.type === "pointerup") void setActive(frames.indexOf(frame));
        return;
      }
      const target = drop ? chipFrames.get(drop.chip) : undefined;
      if (target && drop) reorderFrame(frame, target, drop.after);
    };
    chip.addEventListener("pointermove", onMove);
    chip.addEventListener("pointerup", onEnd);
    chip.addEventListener("pointercancel", onEnd);
  });
}

/** Move `f` before/after `target` (same level). Top level: reorders `frames`
 *  (grid tiles, cycling, blink follow). Band chips: reorders the composite's
 *  bands, which re-spreads the rainbow unless weights were hand-edited. */
function reorderFrame(f: Frame, target: Frame, after: boolean): void {
  if (f === target || f.hiddenBy !== target.hiddenBy) return;
  const comp = f.hiddenBy;
  if (comp?.composite) {
    const bands = comp.composite.bands;
    const from = bands.findIndex((b) => b.frame === f);
    const ti = bands.findIndex((b) => b.frame === target);
    if (from < 0 || ti < 0) return;
    // Index after removing `from`, so the drop side stays right either way.
    const to = (ti > from ? ti - 1 : ti) + (after ? 1 : 0);
    moveRgbBand(comp.composite, from, to);
    syncFrameOrder(frames.filter((x) => !x.hiddenBy));
    pushComposite(comp, true);
    const label = comp.cell.querySelector(".frame-label");
    if (label) label.textContent = frameName(comp);
    if (comp === activeFrame()) {
      renderHduList(); // weight rows follow the new order
      renderStatus();
    }
  } else {
    const units = frames.filter((x) => !x.hiddenBy);
    units.splice(units.indexOf(f), 1);
    units.splice(units.indexOf(target) + (after ? 1 : 0), 0, f);
    syncFrameOrder(units);
  }
  applyGridLayout();
  renderFrameBar();
}

/** Rebuild `frames` from top-level units in order, each composite followed by
 *  its band frames (band order), keeping `active` on the same frame. */
function syncFrameOrder(units: Frame[]): void {
  const act = activeFrame();
  const flat: Frame[] = [];
  for (const u of units) {
    flat.push(u);
    if (u.composite) for (const b of u.composite.bands) flat.push(b.frame);
  }
  for (const x of frames) if (!flat.includes(x)) flat.push(x); // defensive
  frames.splice(0, frames.length, ...flat);
  active = act ? frames.indexOf(act) : -1;
}

/** Chip/label name: "RGB (F115W+F277W+F444W)" for a composite. */
function frameName(frame: Frame): string {
  if (frame.composite) return `RGB (${frame.composite.bands.map((b) => b.label).join("+")})`;
  return displayName(frame.file.path);
}

/** Show/hide panes + toolbar controls to match the active frame's tab (or the
 *  split view, which shows the image and table panes side by side). */
function renderView(): void {
  const frame = activeFrame();
  if (frame?.composite) frame.tab = "image"; // a composite has no table/header view
  const hdu = frame ? frameHdu(frame) : null;
  const isImg = hdu !== null && isViewableImage(hdu);
  const isTbl = hdu !== null && isTableHdu(hdu);
  const canSplit = frame ? frameCanSplit(frame) : false;
  const split = frame ? frameSplit(frame) : false;

  // In single-view, keep the active tab valid for this HDU's kind.
  if (frame && !split) {
    if (frame.tab === "image" && !isImg) frame.tab = isTbl ? "table" : "header";
    if (frame.tab === "table" && !isTbl) frame.tab = isImg ? "image" : "header";
  }
  const tab = frame?.tab ?? "header";

  const showImg = split || (tab === "image" && isImg);
  const showTbl = split || (tab === "table" && isTbl);
  const showHdr = !split && tab === "header";

  must<HTMLElement>("view-panes").classList.toggle("split", split);
  must<HTMLElement>("image-pane").style.display = showImg ? "" : "none";
  must<HTMLElement>("table-pane").style.display = showTbl ? "" : "none";
  must<HTMLElement>("header-pane").style.display = showHdr ? "" : "none";
  // Sidebar Display section: single-band images only (a composite's RGB
  // panel owns its levels/stretch/color).
  must<HTMLElement>("display-section").style.display = showImg && !frame?.composite ? "" : "none";
  if (showTbl) refreshOverlayButtons();

  must<HTMLElement>("view-tabs").style.display =
    !frame?.composite && (isImg || isTbl || canSplit) ? "" : "none";
  must<HTMLElement>("tab-image").style.display = isImg ? "" : "none";
  must<HTMLElement>("tab-table").style.display = isTbl ? "" : "none";
  const splitBtn = must<HTMLElement>("tab-split");
  splitBtn.style.display = canSplit ? "" : "none";
  splitBtn.classList.toggle("active", split);
  for (const t of ["image", "table", "header"] as const) {
    must<HTMLElement>(`tab-${t}`).classList.toggle("active", !split && tab === t);
  }
  if (showTbl) tableView?.refresh();
}

/** Load histogram counts if the panel is open and showing a stale HDU. */
function ensureHistogram(): void {
  const frame = activeFrame();
  if (!histPanel?.visible || !frame) return;
  if (frame.composite) {
    // Per-band histograms don't map onto a composite; the panel owns levels.
    histPanel.clear();
    histLoadedFor = null;
    return;
  }
  const hdu = frame.viewerHdu;
  if (hdu === null) return;
  const key = `${frame.file.path}#${hdu}`;
  if (histLoadedFor === key) return;
  histLoadedFor = key;
  void histPanel.load(frame.file.path, hdu);
}

/** (Re)load the shared TableView for a frame's table HDU. */
async function ensureTable(frame: Frame): Promise<void> {
  if (!tableView) return;
  const tblHdu = frameTableHdu(frame);
  if (tblHdu === null) return;
  const key = `${frame.file.path}#${tblHdu}`;
  if (tableLoadedFor !== key) {
    tableLoadedFor = key;
    await tableView.load(frame.file.path, tblHdu);
  }
  if (frame === activeFrame()) {
    tableView.refresh();
    // Metadata-only call (no data touch); cheap enough to refresh on every
    // activation so the column picker always matches this frame's table.
    try {
      refreshPosColumnPicker(await tableColumns(frame.file.path, tblHdu));
    } catch {
      // Picker just won't have columns to offer; overlay/locate still fall
      // back to the name heuristics.
    }
  }
}

/** (Re)load every file layer of a frame against the image the viewer shows
 *  (its WCS/grid — in split mode that differs from the sidebar-selected table
 *  HDU). Untitled layers keep their metadata but their regions don't survive
 *  an image reload (pixel coordinates of another grid). */
async function applyRegionsFor(frame: Frame): Promise<void> {
  if (!frame.viewer) return;
  const pending = frame.pendingRegions;
  if (pending) {
    // Restored band / composite carry-over: install the live regions as-is
    // (file layers keep their edits; untitled layers survive).
    frame.pendingRegions = null;
    frame.viewer.setRegions(pending.length > 0 || frame.regionLayers.length > 0 ? pending : null);
    frame.viewer.setLayerStyle(layerStyleOf(frame));
    if (frame === activeFrame()) renderRegionPanel();
    return;
  }
  const hdu = frame.viewerHdu ?? frame.selectedHdu;
  const all: PixelRegion[] = [];
  for (const layer of frame.regionLayers) {
    if (!layer.path) continue;
    try {
      const result = await loadRegionFile(frame.file.path, hdu, layer.path);
      layer.warnings = result.warnings;
      for (const r of result.regions) all.push({ ...r, layer: layer.id });
    } catch (err) {
      layer.warnings = [String(err)];
    }
  }
  frame.viewer.setRegions(all.length > 0 || frame.regionLayers.length > 0 ? all : null);
  frame.viewer.setLayerStyle(layerStyleOf(frame));
  if (frame === activeFrame()) renderRegionPanel();
}

/** Visibility of a frame's layers, for the viewer. */
function layerStyleOf(frame: Frame): { hidden: Set<number> } {
  const hidden = new Set<number>();
  for (const l of frame.regionLayers) {
    if (!l.visible) hidden.add(l.id);
  }
  return { hidden };
}

/** Load .reg files as new layers on a frame (each appended, nothing replaced). */
async function loadRegionLayers(frame: Frame, paths: string[]): Promise<void> {
  if (!frame.viewer || paths.length === 0) return;
  const hdu = frame.viewerHdu ?? frame.selectedHdu;
  const readout = must<HTMLElement>("readout");
  const msgs: string[] = [];
  for (const path of paths) {
    try {
      const result = await loadRegionFile(frame.file.path, hdu, path);
      const layer = newLayer(basename(path), path);
      layer.warnings = result.warnings;
      frame.regionLayers.push(layer);
      frame.viewer.addRegions(result.regions.map((r) => ({ ...r, layer: layer.id })));
      if (frame.activeLayer === null) frame.activeLayer = layer.id;
      msgs.push(
        `${layer.name}: ${result.regions.length}` +
          (result.warnings.length > 0 ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : ""),
      );
      if (result.warnings.length > 0) console.warn(`region warnings (${path}):`, result.warnings);
    } catch (err) {
      msgs.push(`${basename(path)}: ${String(err)}`);
    }
  }
  frame.viewer.setLayerStyle(layerStyleOf(frame));
  if (frame === activeFrame()) {
    readout.textContent = `regions — ${msgs.join(" · ")}`;
    showRegionPanel(true);
  }
}

/** The layer to draw a new region into: the active layer (re-shown if it
 *  was hidden), else a fresh "untitled" layer. Called by the viewer at the
 *  start of a create gesture. */
function drawLayerFor(frame: Frame): number {
  let layer = frame.regionLayers.find((l) => l.id === frame.activeLayer);
  if (!layer) {
    layer = newLayer(`untitled ${frame.regionLayers.filter((l) => !l.path).length + 1}`, null);
    frame.regionLayers.push(layer);
    frame.activeLayer = layer.id;
  }
  if (!layer.visible) {
    layer.visible = true;
    frame.viewer?.setLayerStyle(layerStyleOf(frame));
  }
  if (frame === activeFrame()) renderRegionPanel();
  return layer.id;
}

/** Save one layer as a .reg (image or sky frame); the layer then points at
 *  the saved file (so a later image reload re-reads the saved version). */
async function saveRegionLayer(frame: Frame, id: number): Promise<void> {
  const layer = frame.regionLayers.find((l) => l.id === id);
  if (!layer || !frame.viewer) return;
  const readout = must<HTMLElement>("readout");
  const regions = frame.viewer.layerRegions(id).map(({ layer: _l, ...r }) => r as PixelRegion);
  if (regions.length === 0) {
    readout.textContent = `layer ${layer.name} has no regions to save`;
    return;
  }
  const out = await pickRegionSavePath(layer.path ?? `${layer.name.replace(/\s+/g, "_")}.reg`);
  if (!out) return;
  try {
    const result = await savePixelRegions(
      frame.file.path,
      frame.viewerHdu ?? frame.selectedHdu,
      regions,
      regionSaveFrame?.value ?? "image",
      out,
    );
    layer.path = out;
    layer.name = basename(out);
    readout.textContent =
      result.warnings.length > 0
        ? `saved ${result.count} regions (${result.warnings.length} warned — see console)`
        : `saved ${result.count} region${result.count === 1 ? "" : "s"} to ${out}`;
    if (result.warnings.length > 0) console.warn("region save warnings:", result.warnings);
    renderRegionPanel();
  } catch (err) {
    readout.textContent = `region save failed: ${String(err)}`;
  }
}

/** Copy one layer of `src` onto other image frames as new layers (same
 *  name, never saved). Each region is matched on the sky (source WCS →
 *  target WCS); without a WCS on either side it is copied pixel-for-pixel.
 *  A target whose Viewer is retired (hidden band) gets it on rebuild. */
async function copyRegionLayer(src: Frame, id: number, targets: Frame[]): Promise<void> {
  const layer = src.regionLayers.find((l) => l.id === id);
  const srcHdu = src.viewerHdu ?? frameImageHdu(src);
  if (!layer || !src.viewer || srcHdu === null) return;
  const regions = src.viewer.layerRegions(id).map(({ layer: _l, ...r }) => r as PixelRegion);
  const readout = must<HTMLElement>("readout");
  if (regions.length === 0) {
    readout.textContent = `layer ${layer.name} has no regions to copy`;
    return;
  }
  const msgs: string[] = [];
  for (const t of targets) {
    const dstHdu = t.viewerHdu ?? frameImageHdu(t);
    if (dstHdu === null) continue;
    try {
      const res = await transferRegions(src.file.path, srcHdu, t.file.path, dstHdu, regions);
      const copy = newLayer(layer.name, null);
      copy.warnings = res.warnings;
      t.regionLayers.push(copy);
      if (t.activeLayer === null) t.activeLayer = copy.id;
      const tagged = res.regions.map((r) => ({ ...r, layer: copy.id }));
      if (t.viewer) {
        t.viewer.addRegions(tagged);
        t.viewer.setLayerStyle(layerStyleOf(t));
      } else {
        t.pendingRegions = [...(t.pendingRegions ?? []), ...tagged];
      }
      msgs.push(
        `${frameName(t)}: ${res.regions.length}${res.sky ? "" : " (pixel copy — no WCS)"}` +
          (res.warnings.length > 0 ? ` (${res.warnings.length} skipped)` : ""),
      );
    } catch (err) {
      msgs.push(`${frameName(t)}: ${String(err)}`);
    }
  }
  readout.textContent = `copied ${layer.name} → ${msgs.join(" · ")}`;
}

/** Region panel body + save-frame select (built in buildUi). */
let regionPanelBody: HTMLElement | null = null;
/** Selected-region properties section of the panel (#7). */
let regionProps: RegionProps | null = null;
let regionSaveFrame: HTMLSelectElement | null = null;

function showRegionPanel(show: boolean): void {
  must<HTMLElement>("region-panel").style.display = show ? "" : "none";
  syncRegionTools();
  if (show) renderRegionPanel();
}

/** Reflect tool / panel / undo state on the region tool bar. */
function syncRegionTools(): void {
  const v = activeFrame()?.viewer;
  regionTools?.sync({
    tool: regionTool,
    shape: createShape,
    layersOpen: document.getElementById("region-panel")?.style.display !== "none",
    canUndo: v?.canUndo() ?? false,
    canRedo: v?.canRedo() ?? false,
    hasSelection: v?.hasSelection() ?? false,
    hasLayers: (activeFrame()?.regionLayers.length ?? 0) > 0,
  });
}

/** Typed limit fields (Display section); a focused field isn't overwritten. */
function showLimits(lo: number, hi: number): void {
  for (const [id, v] of [
    ["limit-lo", lo],
    ["limit-hi", hi],
  ] as const) {
    const inp = must<HTMLInputElement>(id);
    if (document.activeElement !== inp) inp.value = v.toPrecision(6);
  }
}

/** Paint the current colormap into the Display section's color bar. */
function drawColorbar(name: string): void {
  const c = must<HTMLCanvasElement>("colorbar");
  const cm = COLORMAPS.find((m) => m.name === name);
  const ctx = c.getContext("2d");
  if (!cm || !ctx) return;
  c.width = 256;
  c.height = 1;
  const img = ctx.createImageData(256, 1);
  for (let i = 0; i < 256; i++) {
    img.data[4 * i] = cm.rgb[3 * i];
    img.data[4 * i + 1] = cm.rgb[3 * i + 1];
    img.data[4 * i + 2] = cm.rgb[3 * i + 2];
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Host callbacks for the panel, acting on the active frame. */
const regionHost: RegionPanelHost = {
  counts: () => activeFrame()?.viewer?.layerCounts() ?? new Map(),
  toggleVisible: (id) => {
    const f = activeFrame();
    const l = f?.regionLayers.find((x) => x.id === id);
    if (!f || !l) return;
    l.visible = !l.visible;
    f.viewer?.setLayerStyle(layerStyleOf(f));
    renderRegionPanel();
  },
  setActive: (id) => {
    const f = activeFrame();
    if (!f) return;
    f.activeLayer = id;
    renderRegionPanel();
  },
  colors: () => activeFrame()?.viewer?.layerColors() ?? new Map(),
  setColor: (id, color, session) => {
    // Writes each region's own color (undoable, saved with the layer). The
    // layer list isn't re-rendered here: that would detach the open picker.
    const v = activeFrame()?.viewer;
    if (!v) return;
    v.editRegions(v.layerIndices(id), (r) => {
      r.color = color;
    }, `layer-color-${id}-${session}`);
  },
  save: (id) => {
    const f = activeFrame();
    if (f) void saveRegionLayer(f, id);
  },
  copyTargets: () => {
    const src = activeFrame();
    return frames
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f !== src && frameImageHdu(f) !== null)
      .map(({ f, i }) => ({ key: i, name: frameName(f) }));
  },
  copyTo: (id, targets) => {
    const f = activeFrame();
    if (f) void copyRegionLayer(f, id, targets.map((i) => frames[i]).filter((t): t is Frame => !!t));
  },
  close: (id) => {
    const f = activeFrame();
    if (!f) return;
    f.regionLayers = f.regionLayers.filter((l) => l.id !== id);
    if (f.activeLayer === id) f.activeLayer = f.regionLayers[f.regionLayers.length - 1]?.id ?? null;
    f.viewer?.removeLayer(id);
    renderRegionPanel();
  },
  load: () => void loadRegionsViaDialog(),
  newLayer: () => {
    const f = activeFrame();
    if (!f) return;
    const layer = newLayer(`untitled ${f.regionLayers.filter((l) => !l.path).length + 1}`, null);
    f.regionLayers.push(layer);
    f.activeLayer = layer.id;
    renderRegionPanel();
  },
  showAll: (visible) => {
    const f = activeFrame();
    if (!f) return;
    for (const l of f.regionLayers) l.visible = visible;
    f.viewer?.setLayerStyle(layerStyleOf(f));
    renderRegionPanel();
  },
};

async function loadRegionsViaDialog(): Promise<void> {
  const frame = activeFrame();
  if (!frame?.viewer) return;
  const picked = await pickRegionFiles();
  await loadRegionLayers(frame, picked);
}

/** Re-render the layer list + selected-region section (if the panel is open). */
function renderRegionPanel(): void {
  syncRegionTools(); // layer count drives the tool bar's edit section
  if (!renderRegionLayerList()) return;
  regionProps?.sync();
}

/** Re-render just the layer list; false if the panel is closed. */
function renderRegionLayerList(): boolean {
  const panel = document.getElementById("region-panel");
  if (!regionPanelBody || !panel || panel.style.display === "none") return false;
  const f = activeFrame();
  renderRegionLayers(regionPanelBody, f?.regionLayers ?? [], f?.activeLayer ?? null, regionHost);
  return true;
}

// ---- frame Viewer lifecycle ----------------------------------------------

/** Build the per-frame Viewer callbacks (they close over `frame`). Readout is
 *  updated by whichever frame the cursor is over (natural in grid mode);
 *  toolbar-driving callbacks only fire for the active frame. */
function makeViewer(frame: Frame): Viewer {
  return new Viewer(frame.cell, {
    onReadout: (info) => {
      must<HTMLElement>("readout").textContent =
        info.x === null
          ? ""
          : `x ${info.x}  y ${info.y}  ${info.value}${info.sky ? `  ${info.sky}` : ""}`;
    },
    onLimits: (lo, hi) => {
      if (frame !== activeFrame()) return;
      showLimits(lo, hi);
      histPanel?.setLimits(lo, hi);
    },
    onContrastBias: (bias, contrast) => {
      if (frame !== activeFrame()) return;
      const isDefault = Math.abs(bias - 0.5) < 1e-3 && Math.abs(contrast - 1) < 1e-3;
      must<HTMLElement>("cb-label").textContent = `bias ${bias.toFixed(2)} · contrast ${contrast.toFixed(2)}`;
      must<HTMLElement>("cb-reset").style.visibility = isDefault ? "hidden" : "";
    },
    onRegionPick: (desc) => {
      if (frame !== activeFrame()) return;
      must<HTMLElement>("region-info").textContent = desc ?? "";
      if (must<HTMLElement>("region-panel").style.display !== "none") regionProps?.sync();
      syncRegionTools();
    },
    onRegionsChanged: () => {
      if (frame !== activeFrame()) return;
      renderRegionPanel();
      syncRegionTools();
    },
    drawLayer: () => drawLayerFor(frame),
    onCameraChange: (cx, cy, scale) => mirrorCameraFrom(frame, cx, cy, scale),
    onSourcePick: (row) => void locateSourceRow(frame, row),
  });
}

/** Broadcast one frame's camera to every other frame under the active lock
 *  mode. No-op when unlocked. setCamera does not re-emit onCameraChange, so
 *  this doesn't recurse. */
function mirrorCameraFrom(src: Frame, cx: number, cy: number, scale: number): void {
  if (lockMode === "none") return;
  for (const f of frames) {
    if (f !== src && f.viewer) applyLockedCamera(src, f, cx, cy, scale);
  }
}

/** Map a source camera (image-pixel center + device-px/image-px) onto `dst`.
 *  Under "wcs" lock, when both frames have a WCS, align by sky: the source
 *  center pixel → world → dst pixel, and match angular zoom via the plate-scale
 *  ratio. Otherwise (or if the point is off dst's sky) mirror raw pixels. */
function applyLockedCamera(
  src: Frame,
  dst: Frame,
  cx: number,
  cy: number,
  scale: number,
): void {
  if (!dst.viewer) return;
  // WCS-align rotation is independent of the source: each frame renders
  // north-up so pan/zoom directions match (pixel/none modes → axis-aligned).
  dst.viewer.setRotation(alignRotation(dst));
  if (lockMode === "wcs" && src.wcs && dst.wcs) {
    const [ra, dec] = src.wcs.pixToWorld(cx, cy);
    const p = dst.wcs.worldToPix(ra, dec);
    if (p) {
      const s = (scale * dst.wcs.pixScale()) / src.wcs.pixScale();
      dst.viewer.setCamera(p[0], p[1], s);
      return;
    }
  }
  dst.viewer.setCamera(cx, cy, scale);
}

/** The view rotation (radians) that renders `frame` north-up, so that under
 *  WCS-align lock every frame shares one sky orientation and panning/zooming
 *  one does the same on the others. 0 unless in "wcs" mode with a WCS. */
function alignRotation(frame: Frame): number {
  if (lockMode !== "wcs" || !frame.wcs || !frame.viewer) return 0;
  const c = frame.viewer.getCamera();
  return northUpRotation(frame.wcs, c.cx, c.cy);
}

/** Angle to rotate the image so celestial north (+Dec) points up on screen,
 *  measured at the view-center pixel (near-constant across a TAN field). */
function northUpRotation(wcs: Wcs, cx: number, cy: number): number {
  const [ra, dec] = wcs.pixToWorld(cx, cy);
  const eps = 1 / 3600; // 1 arcsec toward +Dec
  const north = wcs.worldToPix(ra, dec + eps);
  if (!north) return 0;
  const nx = north[0] - cx;
  const ny = north[1] - cy;
  if (nx === 0 && ny === 0) return 0;
  // Image y is up; the shader rotates CCW. North currently points along
  // atan2(ny, nx); rotate by (90° − that) to bring it to straight up.
  return Math.PI / 2 - Math.atan2(ny, nx);
}

/** Bind a frame's viewer to the image HDU it should show (image or clear).
 *  In split mode this is the file's linked image even when the sidebar points
 *  at the table HDU; otherwise it's the selected HDU when that's an image. */
async function loadFrameImage(frame: Frame): Promise<void> {
  if (!frame.viewer) return;
  const imgHdu = frameImageHdu(frame);
  frame.viewerHdu = imgHdu;
  if (imgHdu !== null) {
    const hdu = frame.file.hdus[imgHdu];
    frame.viewer.setTool(frame === activeFrame() ? regionTool : "pan");
    frame.viewer.setCreateShape(createShape);
    if (frame.composite) {
      const { sources, display } = compositeDraw(frame.composite);
      frame.viewer.setComposite(sources, frame.composite.nx, frame.composite.ny);
      frame.viewer.setCompositeDisplay(display);
    } else {
      await frame.viewer.setImage(frame.file.path, imgHdu, hdu.shape[0], hdu.shape[1]);
    }
    await loadFrameWcs(frame);
    await applyRegionsFor(frame);
    await restoreSavedView(frame);
    // Under camera-lock, a freshly shown frame adopts the shared camera (and
    // WCS-align rotation). setImage reset rotation to 0, so re-apply it here.
    if (lockMode !== "none") {
      const other = frames.find((f) => f !== frame && f.viewer);
      if (other) {
        const c = other.viewer!.getCamera();
        applyLockedCamera(other, frame, c.cx, c.cy, c.scale);
      } else {
        frame.viewer.setRotation(alignRotation(frame));
      }
    }
  } else {
    frame.wcs = null;
    frame.viewer.clear();
  }
}

/** Fetch and cache the WCS of the image HDU the viewer shows (for lock +
 *  overlay). Keyed off viewerHdu, which loadFrameImage sets before calling. */
async function loadFrameWcs(frame: Frame): Promise<void> {
  frame.wcs = null;
  const hdu = frame.viewerHdu;
  if (hdu === null) return;
  try {
    const params = await getWcs(frame.file.path, hdu);
    // Ignore a stale result if the frame switched HDUs during the fetch.
    if (params && frame.viewerHdu === hdu) frame.wcs = new Wcs(params);
  } catch {
    // No WCS is a normal case; lock/overlay fall back to pixel space.
  }
}

/** Create the frame's Viewer (and load its image) the first time it's shown. */
async function ensureViewer(frame: Frame): Promise<void> {
  if (frame.viewer) return;
  frame.viewer = makeViewer(frame);
  await loadFrameImage(frame);
}

/** Sync the image toolbar controls to a frame's current viewer state. */
function syncToolbar(frame: Frame): void {
  const v = frame.viewer;
  if (!v) return;
  must<HTMLSelectElement>("colormap-select").value = v.getColormap();
  drawColorbar(v.getColormap());
  must<HTMLSelectElement>("stretch-select").value = v.getStretch();
  must<HTMLSelectElement>("scale-select").value = v.getScaleMode();
  const [lo, hi] = v.getLimits();
  showLimits(lo, hi);
  histPanel?.setLimits(lo, hi);
  syncRegionTools();
  renderRegionPanel();
  must<HTMLElement>("region-info").textContent = "";
}

/** Lay out the frame cells: single (only active visible) vs tiled grid. The
 *  grid is image-only — a catalog/header-only frame gets no tile (it has
 *  nothing to render), so the grid dims count image frames alone. */
function applyGridLayout(): void {
  const grid = must<HTMLElement>("frames-grid");
  grid.classList.toggle("grid", gridMode);
  // Tile order follows tab order (CSS order: no DOM moves, canvases stay put).
  frames.forEach((f, i) => {
    f.cell.style.order = String(i);
  });
  if (gridMode) {
    let n = 0;
    frames.forEach((f, i) => {
      const show = isViewableImage(frameHdu(f)) && !isHidden(f);
      // Inline display overrides the .grid .frame-cell rule for non-image
      // frames; cleared again in single mode below.
      f.cell.style.display = show ? "" : "none";
      f.cell.classList.toggle("active", i === active && show);
      if (show) {
        n++;
        void ensureViewer(f);
      }
    });
    const cols = Math.ceil(Math.sqrt(Math.max(1, n)));
    const rows = Math.ceil(Math.max(1, n) / cols);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  } else {
    frames.forEach((f, i) => {
      f.cell.style.display = ""; // let the CSS show only the .active cell
      f.cell.classList.toggle("active", i === active);
    });
    grid.style.gridTemplateColumns = "";
    grid.style.gridTemplateRows = "";
  }
}

/** Make frame `i` active: sync layout, toolbar, sidebar, and shared panels.
 *  Does NOT reload the viewer image (state persists in the frame's Viewer). */
async function setActive(i: number): Promise<void> {
  if (i < 0 || i >= frames.length) return;
  active = i;
  const frame = frames[i];
  // Reveal the active cell first so a first-time Viewer fits to real size,
  // not the hidden (display:none, 0×0) size.
  applyGridLayout();
  await ensureViewer(frame);
  // Reconcile the loaded image with the current mode (split may have toggled
  // while this frame was inactive, changing which HDU the viewer should show).
  if (frame.viewer && frame.viewerHdu !== frameImageHdu(frame)) await loadFrameImage(frame);
  // Only the active frame is editable at a time.
  for (const f of frames) f.viewer?.setTool(f === frame ? regionTool : "pan");
  renderFrameBar();
  renderHduList();
  renderView();
  syncToolbar(frame);
  renderStatus();
  frame.cards = await getHeader(frame.file.path, frame.selectedHdu);
  renderCards();
  ensureHistogram();
  await ensureTable(frame);
}

async function selectHdu(index: number): Promise<void> {
  const frame = activeFrame();
  if (!frame) return;
  const hdu = frame.file.hdus[index];
  frame.selectedHdu = index;
  // In split view the panes are file-level, so keep both showing; otherwise
  // follow the selected HDU's kind.
  if (!frameSplit(frame)) {
    frame.tab = isViewableImage(hdu) ? "image" : isTableHdu(hdu) ? "table" : "header";
  }
  histLoadedFor = null; // HDU changed → histogram is stale
  renderHduList();
  renderView();

  await ensureViewer(frame);
  await loadFrameImage(frame); // shows the right image (or clears) for the mode
  if (frame.viewerHdu === null) histPanel?.clear();
  ensureHistogram();
  await ensureTable(frame);
  frame.cards = await getHeader(frame.file.path, index);
  renderCards();
}

/** Toggle split (image + table side by side) for the active frame's file. */
async function toggleSplit(): Promise<void> {
  const frame = activeFrame();
  if (!frame || !frameCanSplit(frame)) return;
  splitMode = !splitMode;
  if (splitMode && gridMode) gridMode = false; // exclusive with tiled grid
  histLoadedFor = null;
  applyGridLayout();
  renderView();
  await ensureViewer(frame);
  await loadFrameImage(frame); // load the linked image (split on) or clear (off)
  ensureHistogram();
  await ensureTable(frame);
  syncToolbar(frame);
}

function setTab(tab: ViewTab): void {
  const frame = activeFrame();
  if (!frame) return;
  frame.tab = tab;
  // Clicking a tab while split leaves split into that single pane.
  if (frameSplit(frame)) {
    void toggleSplit();
    return;
  }
  renderView();
}

// ---- multi-frame controls -------------------------------------------------

function cycleFrame(dir: number): void {
  // Visible frames only (band frames of a collapsed composite are skipped).
  const vis = frames.map((f, i): [Frame, number] => [f, i]).filter(([f]) => !isHidden(f));
  if (vis.length === 0) return;
  const pos = vis.findIndex(([, i]) => i === active);
  const n = vis.length;
  void setActive(vis[(pos + dir + n) % n][1]);
}

function imageFrameIndices(): number[] {
  return frames
    .map((f, i): [Frame, number] => [f, i])
    .filter(([f]) => isViewableImage(frameHdu(f)) && !isHidden(f))
    .map(([, i]) => i);
}

function stopBlink(): void {
  if (blinkTimer !== undefined) {
    clearInterval(blinkTimer);
    blinkTimer = undefined;
  }
  renderFrameBar();
}

function toggleBlink(): void {
  if (blinkTimer !== undefined) {
    stopBlink();
    return;
  }
  if (imageFrameIndices().length < 2) {
    must<HTMLElement>("readout").textContent = "blink needs ≥2 image frames";
    return;
  }
  // Blink is a single-view compare; drop grid mode if it's on.
  if (gridMode) {
    gridMode = false;
    applyGridLayout();
    renderView();
  }
  blinkTimer = window.setInterval(() => {
    const imgs = imageFrameIndices();
    if (imgs.length < 2) {
      stopBlink();
      return;
    }
    const pos = imgs.indexOf(active);
    const next = imgs[(pos + 1) % imgs.length] ?? imgs[0];
    void setActive(next);
  }, BLINK_MS);
  renderFrameBar();
}

function toggleGrid(): void {
  gridMode = !gridMode;
  if (gridMode) {
    splitMode = false; // grid (multi-frame) and split (one file) are exclusive
    stopBlink();
    // Grid is image-focused. Put the active frame on the image tab if it can;
    // otherwise jump to the first image frame so the tiled grid is visible
    // (a catalog/header-only frame has no tile to show).
    const frame = activeFrame();
    if (frame && isViewableImage(frameHdu(frame))) {
      frame.tab = "image";
    } else {
      const imgIdx = frames.findIndex((f) => isViewableImage(frameHdu(f)));
      if (imgIdx >= 0) {
        frames[imgIdx].tab = "image";
        void setActive(imgIdx); // runs applyGridLayout + renderView + frame bar
        return;
      }
    }
  }
  applyGridLayout();
  renderView();
  renderFrameBar();
}

/** Cycle the Lock button: none → WCS (sky-aligned) → pixel (raw) → none.
 *  On engaging, snap the other frames to the active frame immediately. */
function cycleLock(): void {
  lockMode = lockMode === "none" ? "wcs" : lockMode === "wcs" ? "pixel" : "none";
  const frame = activeFrame();
  if (lockMode !== "none" && frame?.viewer) {
    // Orient the active frame first (north-up in wcs mode, axis-aligned else),
    // then broadcast its camera + each frame's own alignment to the rest.
    frame.viewer.setRotation(alignRotation(frame));
    const c = frame.viewer.getCamera();
    mirrorCameraFrom(frame, c.cx, c.cy, c.scale);
  } else {
    // Unlocked: every frame returns to axis-aligned.
    for (const f of frames) f.viewer?.setRotation(0);
  }
  renderFrameBar();
}

// ---- RGB composites ---------------------------------------------------------

/** Re-derive what a composite draws after a panel change. Structural changes
 *  (band set / mode / channel roles) swap the viewer's sources; the rest is
 *  uniforms only — one frame, no refetch. */
function pushComposite(frame: Frame, structural: boolean): void {
  const c = frame.composite;
  if (!c || !frame.viewer) return;
  const { sources, display } = compositeDraw(c);
  if (sources.length === 0) return;
  if (structural) frame.viewer.setCompositeSources(sources);
  frame.viewer.setCompositeDisplay(display);
  if (structural && frame === activeFrame()) renderStatus();
}

/** An image frame offered by the RGB… dialog. */
interface RgbCandidate {
  frame: Frame;
  hdu: number;
  nx: number;
  ny: number;
  wcs: Wcs | null;
  band: DetectedBand | null;
  label: string;
  /** Why it can't join the reference grid (null = it can). */
  reason: string | null;
}

let rgbCandidates: RgbCandidate[] = [];

/** Open the RGB… dialog: list open image frames (header-only band detection,
 *  instant), pre-tick those on the active frame's pixel grid (≤ MAX_BANDS),
 *  and disable the rest with the reason. */
async function openRgbDialog(): Promise<void> {
  const readout = must<HTMLElement>("readout");
  const pool = frames.filter((f) => !f.composite && !f.hiddenBy && !isDerivedPath(f.file.path));
  const cands: RgbCandidate[] = [];
  for (const f of pool) {
    const hdu = frameImageHdu(f) ?? linkImageHdu(f);
    if (hdu === null) continue;
    const info = f.file.hdus[hdu];
    let wcs = f.viewerHdu === hdu ? f.wcs : null;
    if (!wcs) {
      try {
        const params = await getWcs(f.file.path, hdu);
        wcs = params ? new Wcs(params) : null;
      } catch {
        wcs = null;
      }
    }
    let band: DetectedBand | null = null;
    try {
      band = (await getBandInfo(f.file.path, hdu, false)).band;
    } catch {
      band = null;
    }
    const label = band?.filter ?? displayName(f.file.path).replace(/\.fits?(\.gz)?$/i, "");
    cands.push({ frame: f, hdu, nx: info.shape[0], ny: info.shape[1], wcs, band, label, reason: null });
  }
  if (cands.length < 2) {
    readout.textContent = "RGB needs at least 2 open image frames of the same field (same pixel grid)";
    return;
  }
  const act = activeFrame();
  const ref = cands.find((c) => c.frame === act || c.frame === act?.hiddenBy) ?? cands[0];
  for (const c of cands) c.reason = c === ref ? null : gridMismatch(ref, c);
  // Blue → red, unrecognized filters last (stable for ties).
  cands.sort((a, b) => (a.band?.pivot_um ?? Infinity) - (b.band?.pivot_um ?? Infinity));
  rgbCandidates = cands;

  const list = must<HTMLElement>("rgb-dialog-list");
  list.replaceChildren();
  let ticked = 0;
  cands.forEach((c, i) => {
    const row = el("label", "rgb-cand");
    const cb = el("input");
    cb.type = "checkbox";
    cb.id = `rgb-cand-${i}`;
    cb.disabled = c.reason !== null;
    cb.checked = c.reason === null && ticked < MAX_BANDS;
    if (cb.checked) ticked++;
    const name = el("span", "rgb-cand-label", c.label);
    const file = el("span", "rgb-cand-file", displayName(c.frame.file.path));
    file.title = c.frame.file.path;
    const st = el("span", c.reason ? "rgb-cand-bad" : "rgb-cand-ok", c === ref ? "reference grid" : c.reason ?? "same grid");
    row.append(cb, name, file, st);
    list.append(row);
  });
  const bad = cands.filter((c) => c.reason).length;
  must<HTMLElement>("rgb-dialog-status").textContent =
    `${cands.length - bad} of ${cands.length} frames share ${ref.label}'s ${ref.nx}×${ref.ny} grid` +
    (bad > 0 ? " (mismatched grids need reprojection — not supported yet)" : "") +
    (ticked >= MAX_BANDS ? ` · at most ${MAX_BANDS} bands` : "");
  must<HTMLElement>("rgb-dialog").style.display = "";
}

/** Build the composite from the ticked bands: sample each band's stats
 *  (parallel, off the main thread), then add the composite frame and fold
 *  the band frames into it. */
async function createComposite(): Promise<void> {
  const statusEl = must<HTMLElement>("rgb-dialog-status");
  const chosen = rgbCandidates.filter(
    (_, i) => (document.getElementById(`rgb-cand-${i}`) as HTMLInputElement | null)?.checked,
  );
  if (chosen.length === 0) {
    statusEl.textContent = "tick at least one band";
    return;
  }
  if (chosen.length > MAX_BANDS) {
    statusEl.textContent = `at most ${MAX_BANDS} bands per composite`;
    return;
  }
  const btn = must<HTMLButtonElement>("rgb-create-btn");
  btn.disabled = true;
  statusEl.textContent = "measuring band noise + saturation levels…";
  try {
    const infos = await Promise.all(chosen.map((c) => getBandInfo(c.frame.file.path, c.hdu, true)));
    const bands = chosen.map((c, i) => ({
      frame: c.frame,
      path: c.frame.file.path,
      hdu: c.hdu,
      label: c.label,
      band: infos[i].band,
      stats: infos[i].stats,
      zscale: infos[i].zscale,
      bunit: infos[i].bunit,
    }));
    if (bands.every((b) => b.stats === null && b.zscale === null)) {
      statusEl.textContent = "the chosen bands have no usable (finite, non-constant) pixels";
      return;
    }
    const state = initialRgbState(bands, chosen[0].nx, chosen[0].ny);
    must<HTMLElement>("rgb-dialog").style.display = "none";
    await addFrame(chosen[0].frame.file, { composite: state, hdu: chosen[0].hdu });
    const units = distinctUnits(state);
    if (units.length > 1) {
      must<HTMLElement>("readout").textContent = `⚠ RGB bands have different units: ${units.join(", ")}`;
    }
  } catch (err) {
    statusEl.textContent = `RGB failed: ${String(err)}`;
  } finally {
    btn.disabled = false;
  }
}

// ---- M5: table row → image locate ----------------------------------------

const RA_NAMES = new Set([
  "ra", "raj2000", "ra_icrs", "alpha", "alpha_j2000", "alphawin_j2000",
  "cen_ra", "sky_centroid_ra", "right_ascension", "ra_deg",
]);
const DEC_NAMES = new Set([
  "dec", "dej2000", "dec_icrs", "delta", "delta_j2000", "deltawin_j2000",
  "cen_dec", "sky_centroid_dec", "declination", "dec_deg",
]);
const X_NAMES = new Set(["x", "xcentroid", "x_image", "xwin_image", "xcen", "x_pix", "xpix"]);
const Y_NAMES = new Set(["y", "ycentroid", "y_image", "ywin_image", "ycen", "y_pix", "ypix"]);

type RowPosition = { kind: "sky"; ra: number; dec: number } | { kind: "pixel"; x: number; y: number };

/** Heuristic name key: lowercased, with a crossmatch `_1`/`_2` suffix
 *  stripped so joined tables (RA_1, DEC_2, …) still auto-detect. */
function heurName(name: string): string {
  const n = name.toLowerCase();
  return n.endsWith("_1") || n.endsWith("_2") ? n.slice(0, -2) : n;
}

/** First column (by index) whose lowercased name is in `names` and whose cell
 *  value is a finite number, or null. */
function findNumericCol(
  cells: TableCell[],
  columns: TableColumn[],
  names: Set<string>,
): number | null {
  for (const c of columns) {
    if (!names.has(heurName(c.name))) continue;
    const v = cells[c.index];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Detect a row's position: a manual column override if set, else RA/Dec
 *  (degrees) preferred, else X/Y pixels, by name heuristic. */
function rowPosition(
  cells: TableCell[],
  columns: TableColumn[],
  override: PosOverride | null,
): RowPosition | null {
  if (override) return overridePosition(cells, override);
  const ra = findNumericCol(cells, columns, RA_NAMES);
  const dec = findNumericCol(cells, columns, DEC_NAMES);
  if (ra !== null && dec !== null) return { kind: "sky", ra, dec };
  const x = findNumericCol(cells, columns, X_NAMES);
  const y = findNumericCol(cells, columns, Y_NAMES);
  if (x !== null && y !== null) return { kind: "pixel", x, y };
  return null;
}

/** Read a row's position from manually-picked columns (no name matching). */
function overridePosition(cells: TableCell[], override: PosOverride): RowPosition | null {
  const [a, b] = override.kind === "sky" ? [override.raCol, override.decCol] : [override.xCol, override.yCol];
  const va = cells[a];
  const vb = cells[b];
  if (typeof va !== "number" || typeof vb !== "number" || !Number.isFinite(va) || !Number.isFinite(vb)) {
    return null;
  }
  return override.kind === "sky" ? { kind: "sky", ra: va, dec: vb } : { kind: "pixel", x: va, y: vb };
}

/** The image HDU a catalog links to: the first viewable image in the file. */
function linkImageHdu(frame: Frame): number | null {
  const hdu = frame.file.hdus.find(isViewableImage);
  return hdu ? hdu.index : null;
}

/** Clicking a catalog row: locate the source on the linked image and mark it. */
async function locateRow(cells: TableCell[], columns: TableColumn[]): Promise<void> {
  const frame = activeFrame();
  if (!frame) return;
  const readout = must<HTMLElement>("readout");
  const imgHdu = linkImageHdu(frame);
  if (imgHdu === null) {
    readout.textContent = "no image HDU in this file to locate on";
    return;
  }
  const pos = rowPosition(cells, columns, frame.posOverride);
  if (!pos) {
    readout.textContent = frame.posOverride
      ? "the picked position columns aren't numeric for this row"
      : "no RA/Dec or X/Y columns found in this table";
    return;
  }
  // Split view already shows the linked image beside the table, so stay put;
  // otherwise switch to it (leaving the Table tab — the single-view limitation).
  if (!frameSplit(frame) && frame.viewerHdu !== imgHdu) await selectHdu(imgHdu);
  const viewer = frame.viewer;
  if (!viewer) return;
  let x: number;
  let y: number;
  if (pos.kind === "pixel") {
    // Catalog pixel columns are FITS 1-based; the viewer uses 0-based.
    x = pos.x - 1;
    y = pos.y - 1;
  } else {
    try {
      const r = await resolveCoord(frame.file.path, imgHdu, `${pos.ra} ${pos.dec}`);
      x = r.x;
      y = r.y;
    } catch (err) {
      readout.textContent = `locate failed: ${String(err)}`;
      return;
    }
  }
  viewer.centerOn(x, y);
  viewer.setMarker(x, y);
}

// ---- cross-file catalog → image overlay ----------------------------------

/** Index of the first column whose (lowercased, `_1`/`_2`-stripped) name is
 *  in `names`, or null. */
function findColIndex(columns: TableColumn[], names: Set<string>): number | null {
  const c = columns.find((col) => names.has(heurName(col.name)));
  return c ? c.index : null;
}

/** Project catalog rows onto one image: through its WCS (RA/Dec) or, when no
 *  sky mapping is available (same-frame only), its X/Y pixel columns. Returns
 *  flat [x0,y0,x1,y1,…] pairs + a parallel native-row-index array (for the
 *  reverse link), or null if nothing landed. */
function projectRows(
  wcs: Wcs | null,
  ra: number[] | null,
  dec: number[] | null,
  xs: number[] | null,
  ys: number[] | null,
): { pts: Float64Array; rows: Int32Array } | null {
  const useSky = wcs !== null && ra !== null && dec !== null;
  const usePix = !useSky && xs !== null && ys !== null;
  const n = useSky ? ra!.length : usePix ? xs!.length : 0;
  if (n === 0) return null;
  const pts = new Float64Array(n * 2);
  const rows = new Int32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    let px: number;
    let py: number;
    if (useSky) {
      if (!Number.isFinite(ra![i]) || !Number.isFinite(dec![i])) continue;
      const p = wcs!.worldToPix(ra![i], dec![i]);
      if (!p) continue;
      px = p[0];
      py = p[1];
    } else {
      if (!Number.isFinite(xs![i]) || !Number.isFinite(ys![i])) continue;
      px = xs![i] - 1; // FITS 1-based → 0-based
      py = ys![i] - 1;
    }
    pts[k * 2] = px;
    pts[k * 2 + 1] = py;
    rows[k] = i;
    k++;
  }
  if (k === 0) return null;
  return { pts: pts.subarray(0, k * 2), rows: rows.subarray(0, k) };
}

/** Overlay the active frame's catalog sources as markers: onto its own linked
 *  image (split view — with row ids for the image→row reverse link) and onto
 *  every other open WCS image frame (sky only, no reverse link). */
async function overlayCatalogSources(): Promise<void> {
  const src = activeFrame();
  const status = must<HTMLElement>("readout");
  if (!src) return;
  const tblHdu = frameTableHdu(src);
  if (tblHdu === null) {
    status.textContent = "select a table HDU to overlay its sources";
    return;
  }
  let columns: TableColumn[];
  try {
    columns = await tableColumns(src.file.path, tblHdu);
  } catch (err) {
    status.textContent = `overlay failed: ${String(err)}`;
    return;
  }
  let raCol: number | null = null;
  let decCol: number | null = null;
  let xCol: number | null = null;
  let yCol: number | null = null;
  if (src.posOverride?.kind === "sky") {
    raCol = src.posOverride.raCol;
    decCol = src.posOverride.decCol;
  } else if (src.posOverride?.kind === "pixel") {
    xCol = src.posOverride.xCol;
    yCol = src.posOverride.yCol;
  } else {
    raCol = findColIndex(columns, RA_NAMES);
    decCol = findColIndex(columns, DEC_NAMES);
    xCol = findColIndex(columns, X_NAMES);
    yCol = findColIndex(columns, Y_NAMES);
  }
  const hasSky = raCol !== null && decCol !== null;
  const hasPix = xCol !== null && yCol !== null;
  if (!hasSky && !hasPix) {
    status.textContent = "no RA/Dec or X/Y columns found in this table";
    return;
  }
  let ra: number[] | null = null;
  let dec: number[] | null = null;
  let xs: number[] | null = null;
  let ys: number[] | null = null;
  try {
    if (hasSky) [ra, dec] = await tableColumnsF64(src.file.path, tblHdu, [raCol!, decCol!]);
    if (hasPix) [xs, ys] = await tableColumnsF64(src.file.path, tblHdu, [xCol!, yCol!]);
  } catch (err) {
    status.textContent = `overlay failed: ${String(err)}`;
    return;
  }
  const total = hasSky ? ra!.length : xs!.length;
  let targets = 0;

  const origin = { frame: src, tableHdu: tblHdu };

  // 1. The frame's own image (split view): row ids drive the reverse link.
  if (src.viewer && src.viewerHdu !== null) {
    const proj = projectRows(src.wcs, ra, dec, xs, ys);
    if (proj) {
      src.viewer.setSourceMarkers(proj.pts, proj.rows);
      src.sourceFrom = origin;
      targets++;
    }
  }
  // 2. Other open WCS image frames — sky projection only (X/Y is this file's
  //    own pixel grid, meaningless on another image). Row ids + provenance let
  //    a marker click there jump back to the catalog frame's table row.
  if (hasSky) {
    for (const f of frames) {
      if (f === src || !f.viewer || !f.wcs) continue;
      const proj = projectRows(f.wcs, ra, dec, null, null);
      if (proj) {
        f.viewer.setSourceMarkers(proj.pts, proj.rows);
        f.sourceFrom = origin;
        targets++;
      }
    }
  }

  if (targets === 0) {
    status.textContent = frameSplit(src)
      ? "the image has no WCS/pixel mapping for these sources"
      : "enable Split, or open an image frame with WCS, to overlay onto";
    return;
  }
  status.textContent = `overlaid ${total} sources onto ${targets} image${targets === 1 ? "" : "s"}`;
  refreshOverlayButtons();
}

/** Image→row reverse link: a source marker was clicked on `frame`'s image.
 *  Route to the catalog frame that produced the markers (its own frame for a
 *  same-file overlay, or a separate catalog frame for a cross-file overlay),
 *  bring that frame + its table forward, and scroll to + highlight the row. */
async function locateSourceRow(frame: Frame, row: number): Promise<void> {
  if (!tableView) return;
  const origin = frame.sourceFrom;
  const catFrame = origin?.frame ?? frame;
  const tblHdu = origin?.tableHdu ?? frameTableHdu(catFrame);
  if (tblHdu === null) return;
  const idx = frames.indexOf(catFrame);
  if (idx < 0) return;
  if (idx !== active) await setActive(idx);

  if (catFrame === frame && frameCanSplit(frame)) {
    // Same file has both image + table: keep the image, reveal the row beside it.
    if (!frameSplit(frame)) await toggleSplit();
  } else if (catFrame.selectedHdu !== tblHdu && !frameSplit(catFrame)) {
    // Cross-file (or table-only frame): select the catalog's table HDU.
    await selectHdu(tblHdu);
  } else if (!frameSplit(catFrame)) {
    catFrame.tab = "table";
    renderView();
    await ensureTable(catFrame);
  }
  await tableView.revealRow(row);
}

/** Clear catalog source markers + their provenance from every frame. */
function clearSourceOverlays(): void {
  for (const f of frames) {
    f.viewer?.setSourceMarkers(null);
    f.sourceFrom = null;
  }
  tableView?.clearHighlight();
  must<HTMLElement>("readout").textContent = "";
  refreshOverlayButtons();
}

/** Show the "Clear overlay" button only when some frame has markers. */
function refreshOverlayButtons(): void {
  const any = frames.some((f) => f.viewer?.hasSourceMarkers());
  must<HTMLElement>("clear-overlay-btn").style.display = any ? "" : "none";
}

// ---- manual position-column picker ----------------------------------------
// Overrides the RA/DEC/X/Y name heuristics for a frame's table, for row→image
// locate and the catalog overlay, when a catalog uses non-standard column
// names. One picker in the toolbar, reflecting the active frame's table.

/** Columns currently offered by the picker (the active frame's table). */
let posPickerColumns: TableColumn[] = [];

/** Read the picker's current selects into the active frame's posOverride. */
function applyPosOverrideFromPicker(): void {
  const frame = activeFrame();
  if (!frame) return;
  const kind = must<HTMLSelectElement>("pos-kind-select").value;
  const aSel = must<HTMLSelectElement>("pos-col-a-select");
  const bSel = must<HTMLSelectElement>("pos-col-b-select");
  aSel.style.display = kind === "auto" ? "none" : "";
  bSel.style.display = kind === "auto" ? "none" : "";
  if (kind === "auto") {
    frame.posOverride = null;
    return;
  }
  if (aSel.value === "" || bSel.value === "") return; // no columns loaded yet
  const a = Number(aSel.value);
  const b = Number(bSel.value);
  frame.posOverride =
    kind === "sky" ? { kind: "sky", raCol: a, decCol: b } : { kind: "pixel", xCol: a, yCol: b };
}

/** Rebuild the column selects for a newly-loaded table, then reflect the
 *  active frame's current override (called whenever a table (re)loads). */
function refreshPosColumnPicker(columns: TableColumn[]): void {
  posPickerColumns = columns;
  const aSel = must<HTMLSelectElement>("pos-col-a-select");
  const bSel = must<HTMLSelectElement>("pos-col-b-select");
  const opts = (): HTMLOptionElement[] =>
    columns.map((c) => {
      const opt = el("option", "", c.name);
      opt.value = String(c.index);
      return opt;
    });
  aSel.replaceChildren(...opts());
  bSel.replaceChildren(...opts());
  syncPosColumnPicker();
}

/** Reflect the active frame's posOverride into the picker's selects, without
 *  triggering a change (called on frame switch as well as table load). */
function syncPosColumnPicker(): void {
  const frame = activeFrame();
  const kindSel = must<HTMLSelectElement>("pos-kind-select");
  const aSel = must<HTMLSelectElement>("pos-col-a-select");
  const bSel = must<HTMLSelectElement>("pos-col-b-select");
  const override = frame?.posOverride ?? null;
  kindSel.value = override?.kind ?? "auto";
  if (override) {
    aSel.value = String(override.kind === "sky" ? override.raCol : override.xCol);
    bSel.value = String(override.kind === "sky" ? override.decCol : override.yCol);
  }
  const show = kindSel.value !== "auto";
  aSel.style.display = show ? "" : "none";
  bSel.style.display = show ? "" : "none";
}

// ---- open / close ---------------------------------------------------------

// ---- crossmatch UI (M5+: Match dialog, export, coordinate probe) ----------

/** Frames offering a table HDU, for the Match panel's pickers. */
function matchCandidates(): { frame: Frame; hdu: number }[] {
  const out: { frame: Frame; hdu: number }[] = [];
  for (const frame of frames) {
    const hdu = frameTableHdu(frame);
    if (hdu !== null) out.push({ frame, hdu });
  }
  return out;
}

/** Table A (fixed = active frame) and the current Table B candidates. */
let matchA: { frame: Frame; hdu: number } | null = null;
let matchBList: { frame: Frame; hdu: number }[] = [];

function matchSelsA(): { ra: HTMLSelectElement; dec: HTMLSelectElement } {
  return { ra: must<HTMLSelectElement>("match-a-ra"), dec: must<HTMLSelectElement>("match-a-dec") };
}

function matchSelsB(): { ra: HTMLSelectElement; dec: HTMLSelectElement } {
  return { ra: must<HTMLSelectElement>("match-b-ra"), dec: must<HTMLSelectElement>("match-b-dec") };
}

/** Fill RA/Dec column selects with a table's numeric columns, pre-seeded
 *  from its position override (sky) or the name heuristics. */
function fillMatchColSelects(
  sels: { ra: HTMLSelectElement; dec: HTMLSelectElement },
  columns: TableColumn[],
  override: PosOverride | null,
): void {
  const numeric = columns.filter((c) => (c.kind === "int" || c.kind === "float") && c.sortable);
  for (const s of [sels.ra, sels.dec]) {
    s.replaceChildren();
    for (const c of numeric) {
      const opt = el("option", "", c.name);
      opt.value = String(c.index);
      s.append(opt);
    }
  }
  const ra = override?.kind === "sky" ? override.raCol : findColIndex(columns, RA_NAMES);
  const dec = override?.kind === "sky" ? override.decCol : findColIndex(columns, DEC_NAMES);
  if (ra !== null) sels.ra.value = String(ra);
  if (dec !== null) sels.dec.value = String(dec);
}

async function openMatchPanel(): Promise<void> {
  const frame = activeFrame();
  const readout = must<HTMLElement>("readout");
  if (!frame) return;
  const aHdu = frameTableHdu(frame);
  if (aHdu === null) {
    readout.textContent = "select a table HDU to crossmatch";
    return;
  }
  matchA = { frame, hdu: aHdu };
  must<HTMLElement>("match-a-label").textContent = `${displayName(frame.file.path)} [${aHdu}]`;
  matchBList = matchCandidates();
  const bSel = must<HTMLSelectElement>("match-b-select");
  bSel.replaceChildren();
  matchBList.forEach((c, i) => {
    const opt = el("option", "", `${displayName(c.frame.file.path)} [${c.hdu}]`);
    opt.value = String(i);
    bSel.append(opt);
  });
  // Default B: the first other frame's catalog (self-match stays possible).
  const other = matchBList.findIndex((c) => c.frame !== frame);
  bSel.value = String(other >= 0 ? other : 0);
  must<HTMLElement>("match-status").textContent = "";
  must<HTMLElement>("match-panel").style.display = "";
  try {
    fillMatchColSelects(matchSelsA(), await tableColumns(frame.file.path, aHdu), frame.posOverride);
    await refreshMatchB();
  } catch (err) {
    must<HTMLElement>("match-status").textContent = String(err);
  }
}

/** Reload Table B's column selects after the B table changes. */
async function refreshMatchB(): Promise<void> {
  const c = matchBList[Number(must<HTMLSelectElement>("match-b-select").value)];
  if (!c) return;
  fillMatchColSelects(matchSelsB(), await tableColumns(c.frame.file.path, c.hdu), c.frame.posOverride);
}

async function runMatch(): Promise<void> {
  const statusEl = must<HTMLElement>("match-status");
  const a = matchA;
  const b = matchBList[Number(must<HTMLSelectElement>("match-b-select").value)];
  if (!a || !b) return;
  const radius = Number(must<HTMLInputElement>("match-radius").value);
  if (!Number.isFinite(radius) || radius <= 0) {
    statusEl.textContent = "radius must be a positive number of arcsec";
    return;
  }
  const selsA = matchSelsA();
  const selsB = matchSelsB();
  if (!selsA.ra.value || !selsA.dec.value || !selsB.ra.value || !selsB.dec.value) {
    statusEl.textContent = "pick RA and Dec columns for both tables";
    return;
  }
  const runBtn = must<HTMLButtonElement>("match-run-btn");
  runBtn.disabled = true;
  statusEl.textContent = "matching…";
  try {
    const sum = await xmatchTables({
      pathA: a.frame.file.path,
      hduA: a.hdu,
      raColA: Number(selsA.ra.value),
      decColA: Number(selsA.dec.value),
      pathB: b.frame.file.path,
      hduB: b.hdu,
      raColB: Number(selsB.ra.value),
      decColB: Number(selsB.dec.value),
      radiusArcsec: radius,
      join: must<HTMLSelectElement>("match-join").value === "all1" ? "all1" : "1and2",
    });
    must<HTMLElement>("match-panel").style.display = "none";
    await openDerivedFrame(sum);
    const skipped = sum.skippedA + sum.skippedB;
    must<HTMLElement>("readout").textContent =
      `matched ${sum.matched.toLocaleString()} of ${sum.totalA.toLocaleString()} rows` +
      (sum.medianSepArcsec !== null ? ` (median sep ${sum.medianSepArcsec.toFixed(3)}″)` : "") +
      (skipped > 0 ? ` — skipped ${skipped} row${skipped === 1 ? "" : "s"} with invalid coordinates` : "");
  } catch (err) {
    statusEl.textContent = `match failed: ${String(err)}`;
  } finally {
    runBtn.disabled = false;
  }
}

/** Save the active table (through its current sort/filter) as a FITS file. */
async function exportActiveTable(): Promise<void> {
  const frame = activeFrame();
  const readout = must<HTMLElement>("readout");
  if (!frame) return;
  const tblHdu = frameTableHdu(frame);
  if (tblHdu === null) {
    readout.textContent = "select a table HDU to export";
    return;
  }
  const name = displayName(frame.file.path);
  const suggested = isDerivedPath(frame.file.path)
    ? `${name}.fits`
    : `${name.replace(/\.fits?$/i, "")}_table.fits`;
  const out = await pickFitsSavePath(suggested);
  if (!out) return;
  readout.textContent = "exporting…";
  try {
    const n = await exportTable(frame.file.path, tblHdu, out, true);
    readout.textContent = `exported ${n.toLocaleString()} rows → ${out}`;
  } catch (err) {
    readout.textContent = `export failed: ${String(err)}`;
  }
}

/** Coordinate probe ("goto" for tables): find catalog rows near a typed
 *  coordinate, reveal the nearest in the table, mark it on a shown image. */
async function probeCoordinate(query: string): Promise<void> {
  const frame = activeFrame();
  const readout = must<HTMLElement>("readout");
  const box = must<HTMLInputElement>("probe-box");
  if (!frame || !query.trim()) return;
  const tblHdu = frameTableHdu(frame);
  if (tblHdu === null) {
    readout.textContent = "select a table HDU to search";
    return;
  }
  const radius = Number(must<HTMLInputElement>("probe-radius").value);
  if (!Number.isFinite(radius) || radius <= 0) {
    readout.textContent = "probe radius must be a positive number of arcsec";
    return;
  }
  try {
    const { ra, dec } = await parseCoord(query);
    const columns = await tableColumns(frame.file.path, tblHdu);
    let raCol: number | null;
    let decCol: number | null;
    if (frame.posOverride?.kind === "sky") {
      raCol = frame.posOverride.raCol;
      decCol = frame.posOverride.decCol;
    } else {
      raCol = findColIndex(columns, RA_NAMES);
      decCol = findColIndex(columns, DEC_NAMES);
    }
    if (raCol === null || decCol === null) {
      readout.textContent = "no RA/Dec columns found (pick them with the position-column selector)";
      return;
    }
    const [ras, decs] = await tableColumnsF64(frame.file.path, tblHdu, [raCol, decCol]);
    // One cone query is a linear scan over unit-vector chord distances —
    // even 1M rows is milliseconds, no index needed for a single probe.
    const d2r = Math.PI / 180;
    const qx = Math.cos(dec * d2r) * Math.cos(ra * d2r);
    const qy = Math.cos(dec * d2r) * Math.sin(ra * d2r);
    const qz = Math.sin(dec * d2r);
    const chord = 2 * Math.sin(((radius / 3600) * d2r) / 2);
    const chord2 = chord * chord;
    let bestRow = -1;
    let bestD2 = Infinity;
    let count = 0;
    for (let i = 0; i < ras.length; i++) {
      const r = ras[i];
      const d = decs[i];
      if (!Number.isFinite(r) || !Number.isFinite(d)) continue;
      const cx = Math.cos(d * d2r) * Math.cos(r * d2r) - qx;
      const cy = Math.cos(d * d2r) * Math.sin(r * d2r) - qy;
      const cz = Math.sin(d * d2r) - qz;
      const d2 = cx * cx + cy * cy + cz * cz;
      if (d2 <= chord2) {
        count++;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestRow = i;
        }
      }
    }
    if (bestRow < 0) {
      readout.textContent = `no rows within ${radius}″ of ${query.trim()}`;
      box.classList.add("goto-error");
      return;
    }
    box.classList.remove("goto-error");
    const sep = ((2 * Math.asin(Math.min(1, Math.sqrt(bestD2) / 2))) / d2r) * 3600;
    await tableView?.revealRow(bestRow);
    // Drop the goto crosshair at the probed coordinate on a shown image.
    if (frame.viewer && frame.wcs) {
      const p = frame.wcs.worldToPix(ra, dec);
      if (p) frame.viewer.setMarker(p[0], p[1]);
    }
    readout.textContent =
      `${count.toLocaleString()} row${count === 1 ? "" : "s"} within ${radius}″ — ` +
      `nearest is row ${bestRow} at ${sep.toFixed(3)}″`;
  } catch (err) {
    readout.textContent = `probe failed: ${String(err)}`;
    box.classList.add("goto-error");
  }
}

async function openPath(path: string): Promise<void> {
  const status = must<HTMLElement>("status-file");
  // Already open? Just activate its frame (backend dedupes by path anyway).
  const existing = frames.findIndex((f) => f.file.path === path && !f.composite);
  if (existing >= 0) {
    await setActive(existing);
    return;
  }
  try {
    status.textContent = `Opening ${path}…`;
    const file = await openFits(path);
    await addFrame(file);
  } catch (err) {
    status.textContent = `Failed to open ${path}: ${String(err)}`;
  }
}

/** Create + activate a frame for an already-open file (real or derived), or
 *  — with `rgb` — an RGB composite over that (reference band's) file. */
async function addFrame(
  file: FileSummary,
  rgb?: { composite: RgbState<Frame>; hdu: number },
): Promise<void> {
  const cell = el("div", "frame-cell");
  must<HTMLElement>("frames-grid").append(cell);
  // JWST-style files have an empty primary HDU; jump to the first image HDU
  // that actually has pixels (usually SCI).
  const firstImg = file.hdus.find(isViewableImage);
  const selectedHdu = rgb ? rgb.hdu : firstImg ? firstImg.index : 0;
  const hdu = file.hdus[selectedHdu];
  const tab: ViewTab = isViewableImage(hdu) ? "image" : isTableHdu(hdu) ? "table" : "header";
  const frame: Frame = {
    file, selectedHdu, tab, cards: [], regionLayers: [], activeLayer: null, cell,
    viewer: null, viewerHdu: null, wcs: null, sourceFrom: null, posOverride: null,
    composite: rgb?.composite ?? null, hiddenBy: null,
  };
  cell.append(el("div", "frame-label", frameName(frame)));
  if (rgb) {
    const carried: PixelRegion[] = [];
    for (const b of rgb.composite.bands) {
      b.frame.hiddenBy = frame;
      // Free the hidden band's WebGL context (WKWebView caps them; see #9),
      // keeping its settings + regions; rebuilt lazily (ensureViewer) if the
      // composite is expanded or closed.
      retireViewer(b.frame);
      // Paint the band's region layers onto the composite too: every band is
      // on the composite's pixel grid, so pixel regions carry over 1:1. The
      // composite gets copies ("F444W · sources.reg"); edits don't flow back.
      const regs = b.frame.pendingRegions ?? [];
      for (const l of b.frame.regionLayers) {
        const copy = newLayer(`${b.label} · ${l.name}`, null);
        copy.visible = l.visible;
        copy.warnings = l.warnings;
        frame.regionLayers.push(copy);
        for (const r of regs) if (r.layer === l.id) carried.push({ ...structuredClone(r), layer: copy.id });
      }
    }
    if (frame.regionLayers.length > 0) {
      frame.pendingRegions = carried;
      frame.activeLayer = frame.regionLayers[0].id;
    }
  }
  // Clicking a cell (tiled mode) makes it the active frame.
  cell.addEventListener(
    "pointerdown",
    () => {
      const idx = frames.indexOf(frame);
      if (idx >= 0 && idx !== active) void setActive(idx);
    },
    true,
  );
  frames.push(frame);
  must<HTMLElement>("empty-state").style.display = "none";
  must<HTMLElement>("content").style.display = "";
  await setActive(frames.length - 1);
}

/** Open a crossmatch result as a new frame: a synthetic single-HDU file
 *  whose table commands the backend serves under the derived path. */
async function openDerivedFrame(sum: XmatchSummary): Promise<void> {
  derivedNames.set(sum.path, sum.name);
  const hdu: HduInfo = {
    index: 0,
    kind: "bin_table",
    name: sum.name,
    bitpix: 8,
    shape: [],
    header_offset: 0,
    data_offset: 0,
    data_len: 0,
    ncards: 0,
    nrows: sum.nrows,
    ncols: sum.columns.length,
  };
  await addFrame({ path: sum.path, size: 0, hdus: [hdu], open_ms: 0 });
}

async function closeFrame(i: number): Promise<void> {
  const frame = frames[i];
  if (!frame) return;
  if (frame.hiddenBy) {
    // The composite reads through this band's open file.
    must<HTMLElement>("readout").textContent =
      "this band belongs to an RGB composite — close the composite first (or untick the band in its panel)";
    return;
  }
  frame.viewer?.destroy();
  frame.cell.remove();
  if (frame.composite) {
    // The composite shares its reference band's file: un-hide the bands, but
    // leave every file open.
    for (const f of frames) if (f.hiddenBy === frame) f.hiddenBy = null;
  } else {
    try {
      await closeFits(frame.file.path);
    } catch {
      // Best effort; the frame is gone from the UI regardless.
    }
  }
  frames.splice(i, 1);
  // Shared panels may have been showing this frame; force a reload on reactivate.
  tableLoadedFor = null;
  histLoadedFor = null;
  if (frames.length === 0) {
    active = -1;
    stopBlink();
    histPanel?.clear();
    must<HTMLElement>("content").style.display = "none";
    must<HTMLElement>("empty-state").style.display = "";
    renderFrameBar();
    return;
  }
  active = -1; // force setActive to run fully
  await setActive(Math.min(i, frames.length - 1));
}

async function openViaDialog(): Promise<void> {
  const path = await pickFitsFile();
  if (path) await openPath(path);
}

function makeSelect(
  id: string,
  options: readonly string[],
  onChange: (value: string) => void,
): HTMLSelectElement {
  const select = el("select", "control-select");
  select.id = id;
  for (const name of options) {
    const opt = el("option", "", name);
    opt.value = name;
    select.append(opt);
  }
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function buildUi(): void {
  const root = must<HTMLElement>("app");
  root.replaceChildren();

  // Sidebar top (#22): title + Open, then goto — the old top bar is gone so
  // the image runs to the top of the window.
  const sideTop = el("div", "side-top");
  const title = el("span", "app-title", "Voyager");
  const openBtn = el("button", "open-btn", "Open…");
  openBtn.title = "Open FITS files (⌘O)";
  openBtn.addEventListener("click", () => void openViaDialog());
  sideTop.append(title, openBtn);

  // Display section (single-band image frames).
  const colormapSel = makeSelect(
    "colormap-select",
    COLORMAPS.map((c) => c.name),
    (v) => {
      activeFrame()?.viewer?.setColormap(v);
      drawColorbar(v);
    },
  );
  const stretchSel = makeSelect("stretch-select", STRETCHES, (v) =>
    activeFrame()?.viewer?.setStretch(v as Stretch),
  );
  const scaleSel = makeSelect("scale-select", ["zscale", "minmax"], (v) => {
    void activeFrame()?.viewer?.applyScaleMode(v as ScaleMode);
  });
  const colorbar = el("canvas", "colorbar");
  colorbar.id = "colorbar";
  const limitInput = (id: string, tip: string): HTMLInputElement => {
    const inp = el("input", "limit-input");
    inp.id = id;
    inp.inputMode = "decimal";
    inp.title = tip;
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") inp.blur();
    });
    inp.addEventListener("change", () => {
      const v = activeFrame()?.viewer;
      if (!v) return;
      const lo = Number(must<HTMLInputElement>("limit-lo").value);
      const hi = Number(must<HTMLInputElement>("limit-hi").value);
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) v.setLimits(lo, hi);
      else showLimits(...v.getLimits());
    });
    return inp;
  };
  const limLo = limitInput("limit-lo", "Lower display limit (black). Enter to apply.");
  const limHi = limitInput("limit-hi", "Upper display limit (white). Enter to apply.");
  const cbLabel = el("span", "cb-label", "bias 0.50 · contrast 1.00");
  cbLabel.id = "cb-label";
  cbLabel.title = "Right-drag on the image: ← bias → / ↑ contrast ↓. Double-right-click resets.";
  const cbReset = el("button", "mini-btn", "reset");
  cbReset.id = "cb-reset";
  cbReset.style.visibility = "hidden";
  cbReset.addEventListener("click", () => activeFrame()?.viewer?.resetContrastBias());
  const gotoBox = el("input", "goto");
  gotoBox.id = "goto-box";
  gotoBox.placeholder = "goto α δ";
  gotoBox.title =
    'Center on a coordinate: "150.116 2.206", "10:00:27.9 +02:12:20", "10h00m28s 2d12m21s"';
  gotoBox.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const frame = activeFrame();
    if (!frame) return;
    const query = gotoBox.value.trim();
    if (!query) return;
    resolveCoord(frame.file.path, frame.viewerHdu ?? frame.selectedHdu, query)
      .then((r) => {
        gotoBox.classList.remove("goto-error");
        gotoBox.title = "";
        frame.viewer?.centerOn(r.x, r.y);
        frame.viewer?.setMarker(r.x, r.y);
      })
      .catch((err: unknown) => {
        gotoBox.classList.add("goto-error");
        gotoBox.title = String(err);
        must<HTMLElement>("readout").textContent = String(err);
      });
  });
  gotoBox.addEventListener("input", () => gotoBox.classList.remove("goto-error"));

  const display = el("div", "display-section");
  display.id = "display-section";
  display.style.display = "none";
  const dispHead = el("button", "sidebar-head section-toggle", "Display ▾");
  const dispBody = el("div", "display-body");
  dispHead.title = "Collapse/expand the display controls";
  dispHead.addEventListener("click", () => {
    const open = dispBody.style.display === "none";
    dispBody.style.display = open ? "" : "none";
    dispHead.textContent = open ? "Display ▾" : "Display ▸";
    if (open) ensureHistogram();
  });
  const row = (label: string, ...kids: HTMLElement[]): HTMLElement => {
    const r = el("div", "disp-row");
    r.append(el("span", "disp-label", label), ...kids);
    return r;
  };
  const histBox = el("div", "disp-hist");
  const limRow = row("Limits", limLo, el("span", "disp-dash", "–"), limHi);
  const cbRow = el("div", "disp-row");
  cbRow.append(cbLabel, cbReset);
  dispBody.append(
    row("Colormap", colormapSel),
    colorbar,
    row("Stretch", stretchSel),
    row("Scale", scaleSel),
    histBox,
    limRow,
    cbRow,
  );
  display.append(dispHead, dispBody);

  const filter = el("input", "filter");
  filter.id = "filter-box";
  filter.placeholder = "Filter header cards…";
  filter.addEventListener("input", () => {
    headerFilter = filter.value;
    renderCards();
  });

  // Table-tab controls: overlay this catalog's sources onto image frames.
  const tableControls = el("div", "pane-bar");
  tableControls.id = "table-controls";
  const overlayBtn = el("button", "", "Overlay ▸ image");
  overlayBtn.title =
    "Mark this catalog's sources on the image: its own linked image (Split view) and any other open WCS image frame. Click a marker to jump to its table row.";
  overlayBtn.addEventListener("click", () => void overlayCatalogSources());
  const clearOverlayBtn = el("button", "", "Clear overlay");
  clearOverlayBtn.id = "clear-overlay-btn";
  clearOverlayBtn.style.display = "none";
  clearOverlayBtn.addEventListener("click", () => clearSourceOverlays());
  // Manual position-column picker: overrides the RA/DEC/X/Y name heuristics
  // for row→image locate + overlay, for catalogs with non-standard names.
  const posKindSel = makeSelect("pos-kind-select", ["auto", "sky", "pixel"], (kind) => {
    if (kind !== "auto") {
      // Seed the column selects with the name-heuristic guess, if any, so
      // switching to a manual kind doesn't default to arbitrary columns.
      const aSel = must<HTMLSelectElement>("pos-col-a-select");
      const bSel = must<HTMLSelectElement>("pos-col-b-select");
      const guessA =
        kind === "sky" ? findColIndex(posPickerColumns, RA_NAMES) : findColIndex(posPickerColumns, X_NAMES);
      const guessB =
        kind === "sky" ? findColIndex(posPickerColumns, DEC_NAMES) : findColIndex(posPickerColumns, Y_NAMES);
      if (guessA !== null) aSel.value = String(guessA);
      if (guessB !== null) bSel.value = String(guessB);
    }
    applyPosOverrideFromPicker();
  });
  posKindSel.title =
    "Position source for row→image locate + overlay: Auto (guess by column name), Sky (pick RA/Dec columns), or Pixel (pick X/Y columns)";
  const posColASel = el("select", "control-select");
  posColASel.id = "pos-col-a-select";
  posColASel.style.display = "none";
  posColASel.title = "RA (sky) or X (pixel) column";
  posColASel.addEventListener("change", () => applyPosOverrideFromPicker());
  const posColBSel = el("select", "control-select");
  posColBSel.id = "pos-col-b-select";
  posColBSel.style.display = "none";
  posColBSel.title = "Dec (sky) or Y (pixel) column";
  posColBSel.addEventListener("change", () => applyPosOverrideFromPicker());
  // Crossmatch, export, and coordinate-probe controls (table tab).
  const matchBtn = el("button", "", "Match…");
  matchBtn.id = "match-btn";
  matchBtn.title = "Crossmatch this catalog against another open catalog by sky position (TOPCAT pair match)";
  matchBtn.addEventListener("click", () => void openMatchPanel());
  const exportBtn = el("button", "", "Export…");
  exportBtn.id = "export-table-btn";
  exportBtn.title = "Save this table (with the current sort/filter applied) as a FITS file";
  exportBtn.addEventListener("click", () => void exportActiveTable());
  const probeBox = el("input", "goto");
  probeBox.id = "probe-box";
  probeBox.placeholder = "Find coord…";
  probeBox.title =
    "Find catalog rows near a coordinate (sexagesimal or decimal degrees) — like goto, for tables. Enter to search.";
  probeBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void probeCoordinate(probeBox.value);
  });
  probeBox.addEventListener("input", () => probeBox.classList.remove("goto-error"));
  const probeRadius = el("input", "probe-radius");
  probeRadius.id = "probe-radius";
  probeRadius.value = "5";
  probeRadius.title = "Probe search radius (arcsec)";
  tableControls.append(
    overlayBtn,
    clearOverlayBtn,
    posKindSel,
    posColASel,
    posColBSel,
    matchBtn,
    exportBtn,
    probeBox,
    probeRadius,
  );

  // Crossmatch panel (floating; opened by the Match… button).
  const matchPanel = el("div", "match-panel");
  matchPanel.id = "match-panel";
  matchPanel.style.display = "none";
  const mpTitle = el("div", "match-title", "Crossmatch — best match within radius");
  const mpClose = el("button", "match-close", "×");
  mpClose.title = "Close";
  mpClose.addEventListener("click", () => {
    matchPanel.style.display = "none";
  });
  mpTitle.append(mpClose);
  const mpRowA = el("div", "match-row");
  const aLabel = el("span", "match-a-name");
  aLabel.id = "match-a-label";
  const aRa = el("select", "control-select");
  aRa.id = "match-a-ra";
  aRa.title = "Table A RA column (deg)";
  const aDec = el("select", "control-select");
  aDec.id = "match-a-dec";
  aDec.title = "Table A Dec column (deg)";
  mpRowA.append(el("span", "match-label", "A:"), aLabel, aRa, aDec);
  const mpRowB = el("div", "match-row");
  const bTableSel = el("select", "control-select");
  bTableSel.id = "match-b-select";
  bTableSel.title = "Table B: another open catalog (or this one, for a self-match)";
  bTableSel.addEventListener("change", () => void refreshMatchB());
  const bRa = el("select", "control-select");
  bRa.id = "match-b-ra";
  bRa.title = "Table B RA column (deg)";
  const bDec = el("select", "control-select");
  bDec.id = "match-b-dec";
  bDec.title = "Table B Dec column (deg)";
  mpRowB.append(el("span", "match-label", "B:"), bTableSel, bRa, bDec);
  const mpRowOpts = el("div", "match-row");
  const radiusIn = el("input", "match-radius-input");
  radiusIn.id = "match-radius";
  radiusIn.value = "1";
  radiusIn.title = "Match radius (arcsec)";
  const joinSel = el("select", "control-select");
  joinSel.id = "match-join";
  for (const [v, label] of [
    ["1and2", "matched pairs only"],
    ["all1", "all rows from A"],
  ] as const) {
    const opt = el("option", "", label);
    opt.value = v;
    joinSel.append(opt);
  }
  joinSel.title = "Join type: keep only matched pairs (1 and 2), or every A row (all from 1)";
  const mpRun = el("button", "", "Run match");
  mpRun.id = "match-run-btn";
  mpRun.addEventListener("click", () => void runMatch());
  mpRowOpts.append(el("span", "match-label", "r″:"), radiusIn, joinSel, mpRun);
  const mpStatus = el("div", "match-status");
  mpStatus.id = "match-status";
  matchPanel.append(mpTitle, mpRowA, mpRowB, mpRowOpts, mpStatus);
  document.body.append(matchPanel);

  // RGB composite dialog (floating; opened by RGB…).
  const rgbDialog = el("div", "match-panel");
  rgbDialog.id = "rgb-dialog";
  rgbDialog.style.display = "none";
  const rdTitle = el("div", "match-title", "RGB composite — bands on one pixel grid");
  const rdClose = el("button", "match-close", "×");
  rdClose.title = "Close";
  rdClose.addEventListener("click", () => {
    rgbDialog.style.display = "none";
  });
  rdTitle.append(rdClose);
  const rdList = el("div", "rgb-cand-list");
  rdList.id = "rgb-dialog-list";
  const rdRow = el("div", "match-row");
  const rdCreate = el("button", "", "Create composite");
  rdCreate.id = "rgb-create-btn";
  rdCreate.addEventListener("click", () => void createComposite());
  rdRow.append(rdCreate);
  const rdStatus = el("div", "match-status");
  rdStatus.id = "rgb-dialog-status";
  rgbDialog.append(rdTitle, rdList, rdRow, rdStatus);
  document.body.append(rgbDialog);

  const content = el("div", "content");
  content.id = "content";
  content.style.display = "none";

  const sidebar = el("aside", "sidebar");
  const sidebarHead = el("div", "sidebar-head", "HDUs");
  sidebarHead.id = "sidebar-head";
  const hduList = el("div", "hdu-list");
  hduList.id = "hdu-list";
  const sideGoto = el("div", "side-goto");
  sideGoto.append(gotoBox);
  // View switch (Image / Table / Header + Split) lives in the sidebar as a
  // segmented control rather than tabs over the image (#22).
  sidebar.append(sideTop, sideGoto, sidebarHead, hduList, display);

  const main = el("main", "main");

  const frameBar = el("div", "frame-bar");
  frameBar.id = "frame-bar";
  frameBar.style.display = "none";

  const tabs = el("div", "view-tabs");
  tabs.id = "view-tabs";
  tabs.style.display = "none";
  const tabLabels: Record<ViewTab, string> = { image: "Image", table: "Table", header: "Header" };
  for (const tab of ["image", "table", "header"] as const) {
    const btn = el("button", "tab", tabLabels[tab]);
    btn.id = `tab-${tab}`;
    btn.addEventListener("click", () => setTab(tab));
    tabs.append(btn);
  }
  // Split toggle (image + table side by side); only shown when the file has
  // both, right-aligned in the tab row.
  const splitBtn = el("button", "tab tab-split", "Split");
  splitBtn.id = "tab-split";
  splitBtn.title = "Show the image and table side by side";
  splitBtn.style.display = "none";
  splitBtn.addEventListener("click", () => void toggleSplit());
  tabs.append(splitBtn);
  sideGoto.after(tabs);

  const imagePane = el("div", "image-pane");
  imagePane.id = "image-pane";
  imagePane.style.display = "none";
  // Frame cells (one Viewer each) live in this grid; the histogram panel is a
  // floating overlay sibling.
  const framesGrid = el("div", "frames-grid");
  framesGrid.id = "frames-grid";
  imagePane.append(framesGrid);

  const tablePane = el("div", "table-pane");
  tablePane.id = "table-pane";
  tablePane.style.display = "none";
  tablePane.append(tableControls);

  const headerPane = el("div", "header-pane");
  headerPane.id = "header-pane";
  const table = el("table", "cards");
  const thead = el("thead");
  const headRow = el("tr");
  headRow.append(el("th", "", "Keyword"), el("th", "", "Value"), el("th", "", "Comment"));
  thead.append(headRow);
  const tbody = el("tbody");
  tbody.id = "card-body";
  table.append(thead, tbody);
  const headerBar = el("div", "pane-bar");
  headerBar.append(filter);
  const headerScroll = el("div", "header-scroll");
  headerScroll.append(table);
  headerPane.append(headerBar, headerScroll);

  // The three panes share a flex container: stacked (only one shown) in
  // single-view, side by side in split view (see #view-panes.split in CSS).
  const viewPanes = el("div", "view-panes");
  viewPanes.id = "view-panes";
  viewPanes.append(imagePane, tablePane, headerPane);
  main.append(frameBar, viewPanes);
  content.append(sidebar, main);

  const empty = el("div", "empty-state");
  empty.id = "empty-state";
  const emptyOpen = el("button", "open-btn", "Open…");
  emptyOpen.addEventListener("click", () => void openViaDialog());
  empty.append(
    el("div", "app-title empty-brand", "Voyager"),
    el("div", "empty-title", "No file open"),
    emptyOpen,
    el("div", "empty-hint", "or press ⌘O, or double-click a .fits file in Finder"),
  );

  const status = el("footer", "status");
  const statusFile = el("span", "status-file", "No file open");
  statusFile.id = "status-file";
  // Selected-region description: its own element so the live pixel readout
  // (updated on every pointermove) never overwrites it. Persists until the
  // region is deselected.
  const regionInfo = el("span", "region-info");
  regionInfo.id = "region-info";
  const readout = el("span", "readout");
  readout.id = "readout";
  status.append(statusFile, regionInfo, readout);

  root.append(empty, content, status);

  document.addEventListener("keydown", (e) => {
    const t = document.activeElement;
    // Color swatches, checkboxes and radios keep focus after a click but take
    // no text, so app shortcuts (⌘Z right after picking a color) still apply.
    const nonText = t instanceof HTMLInputElement && ["color", "checkbox", "radio", "range", "button"].includes(t.type);
    const typing =
      (t instanceof HTMLInputElement && !nonText) ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void openViaDialog();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
      e.preventDefault();
      if (active >= 0) void closeFrame(active);
      return;
    }
    if (e.key === "Escape") activeFrame()?.viewer?.escape();
    if ((e.key === "Delete" || e.key === "Backspace") && !typing) {
      e.preventDefault();
      activeFrame()?.viewer?.deleteSelected();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) {
      e.preventDefault();
      if (e.shiftKey) activeFrame()?.viewer?.redo();
      else activeFrame()?.viewer?.undo();
    }
    if (e.key === "Enter" && !typing) {
      activeFrame()?.viewer?.finishPolygonDraft();
    }
    if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "]") {
        e.preventDefault();
        cycleFrame(1);
      } else if (e.key === "[") {
        e.preventDefault();
        cycleFrame(-1);
      } else if (e.key === "b") {
        toggleBlink();
      } else if (e.key === "g") {
        toggleGrid();
      }
    }
  });

  tableView = new TableView(tablePane, (cells, columns) => void locateRow(cells, columns));

  histPanel = new HistogramPanel(histBox, (lo, hi) => activeFrame()?.viewer?.setLimits(lo, hi), true);

  const rp = buildRegionPanel(regionHost, () => showRegionPanel(false));
  imagePane.append(rp.root);
  regionTools = new RegionTools({
    fit: () => activeFrame()?.viewer?.fit(),
    grid: () => toggleGrid(),
    blink: () => toggleBlink(),
    lock: () => cycleLock(),
    rgb: () => void openRgbDialog(),
    load: () => void loadRegionsViaDialog(),
    toggleLayers: () => showRegionPanel(must<HTMLElement>("region-panel").style.display === "none"),
    setTool: (tool, shape) => {
      regionTool = tool;
      if (shape) createShape = shape;
      const v = activeFrame()?.viewer;
      v?.setCreateShape(createShape);
      v?.setTool(regionTool);
      syncRegionTools();
    },
    undo: () => activeFrame()?.viewer?.undo(),
    redo: () => activeFrame()?.viewer?.redo(),
    deleteSelected: () => activeFrame()?.viewer?.deleteSelected(),
  });
  imagePane.append(regionTools.root);
  syncRegionTools();
  regionPanelBody = rp.body;
  regionSaveFrame = rp.frameSelect;
  const propsBox = el("div", "rp-box");
  propsBox.append(el("div", "rp-section", "Selected region"));
  rp.root.append(propsBox);
  regionProps = new RegionProps(propsBox, {
    viewer: () => activeFrame()?.viewer ?? null,
    wcs: () => activeFrame()?.wcs ?? null,
    layerName: (id) => activeFrame()?.regionLayers.find((l) => l.id === id)?.name ?? "no layer",
    edited: () => renderRegionLayerList(),
  });
}

async function init(): Promise<void> {
  buildUi();
  // Live open requests (double-click while the app is already running).
  await onOpenRequest((path) => void openPath(path));
  // Files that arrived before this listener existed (launched by double-click),
  // else whatever the backend already has open (recovers vite hot-reloads).
  // Multi-frame: open them all as separate frames.
  const pending = await takePendingOpens();
  const paths = pending.length > 0 ? pending : await listOpenFiles();
  for (const path of paths) await openPath(path);
}

window.addEventListener("DOMContentLoaded", () => void init());
