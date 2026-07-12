import {
  closeFits,
  getHeader,
  listOpenFiles,
  loadRegionFile,
  onOpenRequest,
  openFits,
  pickFitsFile,
  pickRegionFile,
  pickRegionSavePath,
  getWcs,
  resolveCoord,
  savePixelRegions,
  tableColumns,
  tableColumnsF64,
  takePendingOpens,
  type CardValue,
  type FileSummary,
  type HduInfo,
  type HeaderCard,
  type ScaleMode,
  type TableCell,
  type TableColumn,
} from "./api";
import type { CreatableShape } from "./render/regionlayer";
import { HistogramPanel } from "./render/histogram";
import { TableView } from "./render/table";
import { COLORMAPS, STRETCHES, Viewer, type Stretch } from "./render/viewer";
import { Wcs } from "./render/wcs";

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
  /** Loaded .reg path for this frame; regions re-resolve per HDU (sky→WCS). */
  regionPath: string | null;
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
/** Region edit mode + create shape are global toggles applied to the active
 *  frame's viewer (only the active frame is editable at a time). */
let editMode = false;
let createShape: CreatableShape = "circle";

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
  if (!frame) return;
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
  const plural = f.hdus.length === 1 ? "" : "s";
  status.textContent = `${f.path} — ${formatBytes(f.size)} — ${f.hdus.length} HDU${plural} — opened in ${f.open_ms.toFixed(1)} ms`;
}

/** The frame chips + multi-frame toggle button states. */
function renderFrameBar(): void {
  const bar = must<HTMLElement>("frame-bar");
  bar.replaceChildren();
  bar.style.display = frames.length > 0 ? "" : "none";
  frames.forEach((frame, i) => {
    const chip = el("div", "frame-chip");
    if (i === active) chip.classList.add("active");
    const name = el("span", "frame-chip-name", basename(frame.file.path));
    name.title = frame.file.path;
    name.addEventListener("click", () => void setActive(i));
    const close = el("button", "frame-chip-close", "×");
    close.title = "Close frame";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeFrame(i);
    });
    chip.append(name, close);
    bar.append(chip);
  });
  must<HTMLElement>("grid-btn").classList.toggle("active-btn", gridMode);
  must<HTMLElement>("blink-btn").classList.toggle("active-btn", blinkTimer !== undefined);
  const lockBtn = must<HTMLElement>("lock-btn");
  lockBtn.classList.toggle("active-btn", lockMode !== "none");
  lockBtn.textContent =
    lockMode === "wcs" ? "Lock·wcs" : lockMode === "pixel" ? "Lock·px" : "Lock";
}

/** Show/hide panes + toolbar controls to match the active frame's tab (or the
 *  split view, which shows the image and table panes side by side). */
function renderView(): void {
  const frame = activeFrame();
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
  must<HTMLElement>("image-controls").style.display = showImg ? "" : "none";
  must<HTMLElement>("table-controls").style.display = showTbl ? "" : "none";
  must<HTMLElement>("filter-box").style.display = showHdr ? "" : "none";
  if (showTbl) refreshOverlayButtons();

  must<HTMLElement>("view-tabs").style.display = isImg || isTbl || canSplit ? "" : "none";
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

/** (Re)load the picked .reg file for a frame and show warnings (active only). */
async function applyRegionsFor(frame: Frame): Promise<void> {
  if (!frame.viewer) return;
  const isActive = frame === activeFrame();
  const readout = must<HTMLElement>("readout");
  // Regions resolve against the image the viewer shows (its WCS/grid), which
  // in split mode differs from the sidebar-selected (table) HDU.
  const hdu = frame.viewerHdu ?? frame.selectedHdu;
  if (!frame.regionPath) {
    frame.viewer.setRegions(null);
  } else {
    try {
      const result = await loadRegionFile(frame.file.path, hdu, frame.regionPath);
      frame.viewer.setRegions(result.regions);
      if (isActive) {
        readout.textContent =
          result.warnings.length > 0
            ? `regions: ${result.warnings[0]}${
                result.warnings.length > 1 ? ` (+${result.warnings.length - 1} more)` : ""
              }`
            : `${result.regions.length} region${result.regions.length === 1 ? "" : "s"} loaded`;
      }
      if (result.warnings.length > 0) console.warn("region warnings:", result.warnings);
    } catch (err) {
      frame.regionPath = null;
      frame.viewer.setRegions(null);
      if (isActive) readout.textContent = `regions: ${String(err)}`;
    }
  }
  if (isActive) refreshRegionButtons();
}

/** Show the Save/clear region buttons whenever the active frame has regions. */
function refreshRegionButtons(): void {
  const show = activeFrame()?.viewer?.hasRegions() ? "" : "none";
  must<HTMLElement>("region-clear-btn").style.display = show;
  must<HTMLElement>("region-save-btn").style.display = show;
  must<HTMLElement>("region-frame-select").style.display = show;
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
      must<HTMLElement>("limits-label").textContent =
        `[${lo.toPrecision(5)}, ${hi.toPrecision(5)}]`;
      histPanel?.setLimits(lo, hi);
    },
    onContrastBias: (bias, contrast) => {
      if (frame !== activeFrame()) return;
      const isDefault = Math.abs(bias - 0.5) < 1e-3 && Math.abs(contrast - 1) < 1e-3;
      must<HTMLElement>("cb-label").textContent = isDefault
        ? ""
        : `b ${bias.toFixed(2)} c ${contrast.toFixed(2)}`;
    },
    onRegionPick: (desc) => {
      if (frame !== activeFrame()) return;
      must<HTMLElement>("region-info").textContent = desc ?? "";
    },
    onRegionsChanged: () => {
      if (frame === activeFrame()) refreshRegionButtons();
    },
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
    frame.viewer.setEditMode(frame === activeFrame() ? editMode : false);
    frame.viewer.setCreateShape(createShape);
    await frame.viewer.setImage(frame.file.path, imgHdu, hdu.shape[0], hdu.shape[1]);
    await loadFrameWcs(frame);
    await applyRegionsFor(frame);
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
  must<HTMLSelectElement>("stretch-select").value = v.getStretch();
  must<HTMLSelectElement>("scale-select").value = v.getScaleMode();
  const [lo, hi] = v.getLimits();
  must<HTMLElement>("limits-label").textContent = `[${lo.toPrecision(5)}, ${hi.toPrecision(5)}]`;
  histPanel?.setLimits(lo, hi);
  must<HTMLElement>("region-edit-btn").classList.toggle("active-btn", editMode);
  must<HTMLElement>("region-shape-select").style.display = editMode ? "" : "none";
  refreshRegionButtons();
  must<HTMLElement>("region-info").textContent = "";
}

/** Lay out the frame cells: single (only active visible) vs tiled grid. The
 *  grid is image-only — a catalog/header-only frame gets no tile (it has
 *  nothing to render), so the grid dims count image frames alone. */
function applyGridLayout(): void {
  const grid = must<HTMLElement>("frames-grid");
  grid.classList.toggle("grid", gridMode);
  if (gridMode) {
    let n = 0;
    frames.forEach((f, i) => {
      const show = isViewableImage(frameHdu(f));
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
  for (const f of frames) f.viewer?.setEditMode(f === frame ? editMode : false);
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
  if (frames.length === 0) return;
  const n = frames.length;
  void setActive((active + dir + n) % n);
}

function imageFrameIndices(): number[] {
  return frames
    .map((f, i): [Frame, number] => [f, i])
    .filter(([f]) => isViewableImage(frameHdu(f)))
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

/** First column (by index) whose lowercased name is in `names` and whose cell
 *  value is a finite number, or null. */
function findNumericCol(
  cells: TableCell[],
  columns: TableColumn[],
  names: Set<string>,
): number | null {
  for (const c of columns) {
    if (!names.has(c.name.toLowerCase())) continue;
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

/** Index of the first column whose (lowercased) name is in `names`, or null. */
function findColIndex(columns: TableColumn[], names: Set<string>): number | null {
  const c = columns.find((col) => names.has(col.name.toLowerCase()));
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

async function openPath(path: string): Promise<void> {
  const status = must<HTMLElement>("status-file");
  // Already open? Just activate its frame (backend dedupes by path anyway).
  const existing = frames.findIndex((f) => f.file.path === path);
  if (existing >= 0) {
    await setActive(existing);
    return;
  }
  try {
    status.textContent = `Opening ${path}…`;
    const file = await openFits(path);
    const cell = el("div", "frame-cell");
    cell.append(el("div", "frame-label", basename(path)));
    must<HTMLElement>("frames-grid").append(cell);
    // JWST-style files have an empty primary HDU; jump to the first image HDU
    // that actually has pixels (usually SCI).
    const firstImg = file.hdus.find(isViewableImage);
    const selectedHdu = firstImg ? firstImg.index : 0;
    const hdu = file.hdus[selectedHdu];
    const tab: ViewTab = isViewableImage(hdu) ? "image" : isTableHdu(hdu) ? "table" : "header";
    const frame: Frame = {
      file, selectedHdu, tab, cards: [], regionPath: null, cell,
      viewer: null, viewerHdu: null, wcs: null, sourceFrom: null, posOverride: null,
    };
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
  } catch (err) {
    status.textContent = `Failed to open ${path}: ${String(err)}`;
  }
}

async function closeFrame(i: number): Promise<void> {
  const frame = frames[i];
  if (!frame) return;
  frame.viewer?.destroy();
  frame.cell.remove();
  try {
    await closeFits(frame.file.path);
  } catch {
    // Best effort; the frame is gone from the UI regardless.
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

function makeToggle(id: string, label: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = el("button", "", label);
  btn.id = id;
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

function buildUi(): void {
  const root = must<HTMLElement>("app");
  root.replaceChildren();

  const toolbar = el("header", "toolbar");
  const title = el("span", "app-title", "Voyager");
  const openBtn = el("button", "open-btn", "Open…");
  openBtn.addEventListener("click", () => void openViaDialog());

  // Multi-frame controls (always available once ≥1 frame is open).
  const prevBtn = makeToggle("prev-frame-btn", "◀", "Previous frame ([)", () => cycleFrame(-1));
  const nextBtn = makeToggle("next-frame-btn", "▶", "Next frame (])", () => cycleFrame(1));
  const gridBtn = makeToggle("grid-btn", "Grid", "Tile all frames (g)", () => toggleGrid());
  const blinkBtn = makeToggle("blink-btn", "Blink", "Blink-cycle image frames (b)", () =>
    toggleBlink(),
  );
  const lockBtn = makeToggle(
    "lock-btn",
    "Lock",
    "Lock pan/zoom across frames (cycles: off → WCS/sky → pixel)",
    () => cycleLock(),
  );

  // Image controls (visible only on the image tab).
  const controls = el("div", "image-controls");
  controls.id = "image-controls";
  controls.style.display = "none";
  const colormapSel = makeSelect(
    "colormap-select",
    COLORMAPS.map((c) => c.name),
    (v) => activeFrame()?.viewer?.setColormap(v),
  );
  const stretchSel = makeSelect("stretch-select", STRETCHES, (v) =>
    activeFrame()?.viewer?.setStretch(v as Stretch),
  );
  const scaleSel = makeSelect("scale-select", ["zscale", "minmax"], (v) => {
    void activeFrame()?.viewer?.applyScaleMode(v as ScaleMode);
  });
  const limitsLabel = el("span", "limits-label", "");
  limitsLabel.id = "limits-label";
  const cbLabel = el("span", "limits-label", "");
  cbLabel.id = "cb-label";
  cbLabel.title = "Right-drag on the image: ← bias → / ↑ contrast ↓. Double-right-click resets.";
  const fitBtn = el("button", "", "Fit");
  fitBtn.addEventListener("click", () => activeFrame()?.viewer?.fit());
  const histBtn = el("button", "", "Hist");
  histBtn.id = "hist-btn";
  histBtn.addEventListener("click", () => {
    if (!histPanel) return;
    histBtn.classList.toggle("active-btn", histPanel.toggle());
    ensureHistogram();
  });
  const regBtn = el("button", "", "Reg…");
  regBtn.title = "Load a DS9 region file (.reg) onto the image";
  regBtn.addEventListener("click", () => {
    void (async () => {
      const frame = activeFrame();
      if (!frame) return;
      const picked = await pickRegionFile();
      if (!picked) return;
      frame.regionPath = picked;
      await applyRegionsFor(frame);
    })();
  });
  const regClearBtn = el("button", "", "×");
  regClearBtn.id = "region-clear-btn";
  regClearBtn.title = "Clear regions";
  regClearBtn.style.display = "none";
  regClearBtn.addEventListener("click", () => {
    const frame = activeFrame();
    if (!frame) return;
    frame.regionPath = null;
    void applyRegionsFor(frame);
  });
  // Region edit mode toggle + create-shape picker.
  const editBtn = el("button", "", "Edit");
  editBtn.id = "region-edit-btn";
  editBtn.title =
    "Region edit mode: drag empty space to draw the chosen shape; click a region to select, then drag its body to move or a handle to resize. ⌥-drag or right-drag pans. Delete removes the selected region. ⌘Z/⌘⇧Z undo/redo.";
  const shapeSel = makeSelect(
    "region-shape-select",
    ["circle", "box", "ellipse", "annulus", "point", "polygon"],
    (v) => {
      createShape = v as CreatableShape;
      activeFrame()?.viewer?.setCreateShape(createShape);
    },
  );
  shapeSel.style.display = "none";
  shapeSel.title =
    "Shape drawn on an empty-space drag. Polygon: click to add vertices, " +
    "close by clicking near the first vertex, double-clicking, or Enter.";
  editBtn.addEventListener("click", () => {
    editMode = !editBtn.classList.contains("active-btn");
    editBtn.classList.toggle("active-btn", editMode);
    shapeSel.style.display = editMode ? "" : "none";
    activeFrame()?.viewer?.setEditMode(editMode);
  });

  const regSaveBtn = el("button", "", "Save");
  regSaveBtn.id = "region-save-btn";
  regSaveBtn.title = "Save the current regions to a .reg file";
  regSaveBtn.style.display = "none";
  // Coordinate frame for saved regions (sky needs the HDU's WCS).
  const frameSel = makeSelect("region-frame-select", ["image", "sky"], () => {});
  frameSel.title = "Coordinate frame for saved regions (image = pixels, sky = icrs)";
  frameSel.style.display = "none";
  regSaveBtn.addEventListener("click", () => {
    void (async () => {
      const frame = activeFrame();
      if (!frame || !frame.viewer || !frame.viewer.hasRegions()) return;
      const outFrame = frameSel.value;
      const out = await pickRegionSavePath(frame.regionPath ?? undefined);
      if (!out) return;
      const readout = must<HTMLElement>("readout");
      try {
        const result = await savePixelRegions(
          frame.file.path,
          frame.viewerHdu ?? frame.selectedHdu,
          frame.viewer.getRegions(),
          outFrame,
          out,
        );
        readout.textContent =
          result.warnings.length > 0
            ? `saved ${result.count} regions (${result.warnings.length} warned — see console)`
            : `saved ${result.count} region${result.count === 1 ? "" : "s"} to ${out}`;
        if (result.warnings.length > 0) console.warn("region save warnings:", result.warnings);
      } catch (err) {
        readout.textContent = `region save failed: ${String(err)}`;
      }
    })();
  });
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
  controls.append(
    colormapSel,
    stretchSel,
    scaleSel,
    fitBtn,
    histBtn,
    regBtn,
    editBtn,
    shapeSel,
    regSaveBtn,
    frameSel,
    regClearBtn,
    gotoBox,
    limitsLabel,
    cbLabel,
  );

  const filter = el("input", "filter");
  filter.id = "filter-box";
  filter.placeholder = "Filter header cards…";
  filter.addEventListener("input", () => {
    headerFilter = filter.value;
    renderCards();
  });

  // Table-tab controls: overlay this catalog's sources onto image frames.
  const tableControls = el("div", "image-controls");
  tableControls.id = "table-controls";
  tableControls.style.display = "none";
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
  tableControls.append(overlayBtn, clearOverlayBtn, posKindSel, posColASel, posColBSel);

  toolbar.append(
    title,
    openBtn,
    prevBtn,
    nextBtn,
    gridBtn,
    blinkBtn,
    lockBtn,
    controls,
    tableControls,
    filter,
  );

  const content = el("div", "content");
  content.id = "content";
  content.style.display = "none";

  const sidebar = el("aside", "sidebar");
  const sidebarHead = el("div", "sidebar-head", "HDUs");
  const hduList = el("div", "hdu-list");
  hduList.id = "hdu-list";
  sidebar.append(sidebarHead, hduList);

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
  headerPane.append(table);

  // The three panes share a flex container: stacked (only one shown) in
  // single-view, side by side in split view (see #view-panes.split in CSS).
  const viewPanes = el("div", "view-panes");
  viewPanes.id = "view-panes";
  viewPanes.append(imagePane, tablePane, headerPane);
  main.append(frameBar, tabs, viewPanes);
  content.append(sidebar, main);

  const empty = el("div", "empty-state");
  empty.id = "empty-state";
  empty.append(
    el("div", "empty-title", "No file open"),
    el("div", "empty-hint", "Press ⌘O, click Open…, or double-click a .fits file in Finder"),
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

  root.append(toolbar, empty, content, status);

  document.addEventListener("keydown", (e) => {
    const t = document.activeElement;
    const typing =
      t instanceof HTMLInputElement ||
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

  histPanel = new HistogramPanel(imagePane, (lo, hi) => activeFrame()?.viewer?.setLimits(lo, hi));
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
