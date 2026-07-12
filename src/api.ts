// Typed wrappers around the Tauri IPC surface. Keep all `invoke` calls here
// so the rest of the frontend deals only in typed functions.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

export type HduKind = "image" | "bin_table" | "ascii_table" | "unknown";

export interface HduInfo {
  index: number;
  kind: HduKind;
  name: string | null;
  bitpix: number;
  shape: number[];
  header_offset: number;
  data_offset: number;
  data_len: number;
  ncards: number;
  nrows: number | null;
  ncols: number | null;
}

export interface FileSummary {
  path: string;
  size: number;
  hdus: HduInfo[];
  open_ms: number;
}

export type CardValue =
  | { type: "Str"; value: string }
  | { type: "Logical"; value: boolean }
  | { type: "Int"; value: number }
  | { type: "Float"; value: number }
  | { type: "Undefined" }
  | { type: "Raw"; value: string };

export interface HeaderCard {
  key: string;
  value: CardValue | null;
  comment: string | null;
  raw: string;
}

export function openFits(path: string): Promise<FileSummary> {
  return invoke<FileSummary>("open_fits", { path });
}

export function getHeader(path: string, hdu: number): Promise<HeaderCard[]> {
  return invoke<HeaderCard[]>("get_header", { path, hdu });
}

export function closeFits(path: string): Promise<void> {
  return invoke<void>("close_fits", { path });
}

/** Tile edge length in level pixels; must match tiles::TILE in Rust. */
export const TILE = 256;

export interface TileData {
  w: number;
  h: number;
  /** w*h f32 pixels, row-major, row 0 = lowest FITS row. */
  data: Float32Array;
}

/**
 * Binary tile fetch. Level L samples every 2^L-th image pixel; tile (0,0)
 * starts at image pixel (0,0). Payload: [u32 w, u32 h] LE + f32 LE pixels.
 */
export async function getTile(
  path: string,
  hdu: number,
  level: number,
  tx: number,
  ty: number,
): Promise<TileData> {
  const buf = await invoke<ArrayBuffer>("get_tile", { path, hdu, level, tx, ty });
  const head = new DataView(buf, 0, 8);
  const w = head.getUint32(0, true);
  const h = head.getUint32(4, true);
  return { w, h, data: new Float32Array(buf, 8, w * h) };
}

export type ScaleMode = "zscale" | "minmax";

export interface ScaleLimits {
  lo: number;
  hi: number;
}

export function getScaleLimits(
  path: string,
  hdu: number,
  mode: ScaleMode,
): Promise<ScaleLimits> {
  return invoke<ScaleLimits>("get_scale_limits", { path, hdu, mode });
}

export interface Readout {
  /** Pixel value; null = NaN/BLANK. */
  value: number | null;
  /** Sky position in degrees when the HDU has a usable WCS. */
  ra: number | null;
  dec: number | null;
  /** Pre-formatted sexagesimal "hh:mm:ss.sss ±dd:mm:ss.ss". */
  sky: string | null;
}

/** Pixel + sky readout at FITS 0-based (x, y). */
export function getReadout(
  path: string,
  hdu: number,
  x: number,
  y: number,
): Promise<Readout> {
  return invoke<Readout>("get_readout", { path, hdu, x, y });
}

export interface GotoResult {
  /** FITS 0-based fractional pixel of the requested sky position. */
  x: number;
  y: number;
  ra: number;
  dec: number;
}

/** Parse a coordinate query and locate it on the image (throws a
 *  user-facing message string on failure). */
export function resolveCoord(
  path: string,
  hdu: number,
  query: string,
): Promise<GotoResult> {
  return invoke<GotoResult>("resolve_coord", { path, hdu, query });
}

/** TAN WCS parameters snapshot (mirrors Rust `wcs::WcsParams`). Consumed by
 *  the frontend `Wcs` class for synchronous pix↔world (WCS-lock, catalog
 *  overlay). null = the HDU has no supported WCS. */
export interface WcsParams {
  crpix: [number, number];
  lon0: number;
  lat0: number;
  cd: [[number, number], [number, number]];
  cd_inv: [[number, number], [number, number]];
  lonpole: number;
  swapped: boolean;
}

/** Fetch an HDU's WCS parameters, or null when it has no supported TAN WCS. */
export function getWcs(path: string, hdu: number): Promise<WcsParams | null> {
  return invoke<WcsParams | null>("get_wcs", { path, hdu });
}

export interface Histogram {
  lo: number;
  hi: number;
  counts: number[];
}

/** Pixel-distribution histogram over the scale-limit spatial sample. */
export function getHistogram(
  path: string,
  hdu: number,
  bins: number,
): Promise<Histogram> {
  return invoke<Histogram>("get_histogram", { path, hdu, bins });
}

/** A region resolved to image-pixel space by the backend (FITS 0-based
 *  pixel-center coordinates; angles in degrees CCW from +x; ellipse
 *  rx/ry are semi-axes, box w/h full side lengths). */
export type PixelRegion = {
  include: boolean;
  color: string | null;
  width: number | null;
  dash: boolean;
  text: string | null;
  /** Point marker style ("circle", "cross", "x", …). */
  point: string | null;
} & (
  | { shape: "circle"; x: number; y: number; r: number }
  | { shape: "annulus"; x: number; y: number; rin: number; rout: number }
  | { shape: "ellipse"; x: number; y: number; rx: number; ry: number; angle: number }
  | { shape: "box"; x: number; y: number; w: number; h: number; angle: number }
  | { shape: "polygon"; xs: number[]; ys: number[] }
  | { shape: "point"; x: number; y: number }
);

export interface RegionLoadResult {
  regions: PixelRegion[];
  warnings: string[];
}

/** Parse a DS9 .reg file and resolve it against one HDU's pixel grid. */
export function loadRegionFile(
  path: string,
  hdu: number,
  regionPath: string,
): Promise<RegionLoadResult> {
  return invoke<RegionLoadResult>("load_region_file", { path, hdu, regionPath });
}

export interface RegionSaveResult {
  count: number;
  warnings: string[];
}

/** Serialize the viewer's current (possibly edited) pixel regions to a .reg
 *  file. `frame` is "image" (pixels, exact) or "sky" (icrs; needs the HDU's
 *  WCS). Returns a count + warnings for shapes that couldn't be written. */
export function savePixelRegions(
  path: string,
  hdu: number,
  regions: PixelRegion[],
  frame: string,
  outPath: string,
): Promise<RegionSaveResult> {
  return invoke<RegionSaveResult>("save_pixel_regions", { path, hdu, regions, frame, outPath });
}

export async function pickRegionSavePath(defaultPath?: string): Promise<string | null> {
  const selected = await saveDialog({
    defaultPath,
    filters: [{ name: "DS9 regions", extensions: ["reg"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickRegionFile(): Promise<string | null> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [
      { name: "DS9 regions", extensions: ["reg"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

// ---- tables (M4) ----------------------------------------------------------

export type ColKind = "logical" | "int" | "float" | "str" | "other";

export interface TableColumn {
  index: number;
  name: string;
  unit: string | null;
  tform: string;
  kind: ColKind;
  /** Element count (string length for text columns). */
  repeat: number;
  /** Scalar numeric/logical/string columns can drive a sort. */
  sortable: boolean;
}

/** One cell: a bare number/string/bool, or null for blank/NaN. */
export type TableCell = number | string | boolean | null;

export interface TablePage {
  rows: TableCell[][];
}

export interface TableSort {
  col: number;
  desc: boolean;
}

export interface TableFilter {
  col: number;
  query: string;
}

export function tableColumns(path: string, hdu: number): Promise<TableColumn[]> {
  return invoke<TableColumn[]>("table_columns", { path, hdu });
}

/** Build the sort/filter view; returns the resulting row count. Must be
 *  called before tableRows whenever the sort/filter (or HDU) changes. */
export async function tableView(
  path: string,
  hdu: number,
  sort: TableSort | null,
  filter: TableFilter | null,
): Promise<number> {
  const r = await invoke<{ nrows: number }>("table_view", { path, hdu, sort, filter });
  return r.nrows;
}

/** A window of rows [start, start+count) in the current view order. */
export function tableRows(
  path: string,
  hdu: number,
  start: number,
  count: number,
): Promise<TablePage> {
  return invoke<TablePage>("table_rows", { path, hdu, start, count });
}

/** The current sort/filter view's position for a native row, or null if that
 *  row isn't present in the view (e.g. filtered out). Lets the image→row
 *  reverse link scroll to the right row without resetting sort/filter. */
export async function tableViewPos(
  path: string,
  hdu: number,
  nativeRow: number,
): Promise<number | null> {
  const r = await invoke<{ pos: number | null }>("table_view_pos", {
    path,
    hdu,
    nativeRow,
  });
  return r.pos;
}

/** Whole numeric columns as f64 arrays (native row order; NaN for blank /
 *  non-numeric). Used to bulk-project catalog RA/Dec onto an image frame. */
export function tableColumnsF64(
  path: string,
  hdu: number,
  cols: number[],
): Promise<number[][]> {
  return invoke<number[][]>("table_columns_f64", { path, hdu, cols });
}

export function takePendingOpens(): Promise<string[]> {
  return invoke<string[]>("take_pending_opens");
}

export function listOpenFiles(): Promise<string[]> {
  return invoke<string[]>("list_open_files");
}

export function onOpenRequest(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("voyager://open-request", (e) => handler(e.payload));
}

export async function pickFitsFile(): Promise<string | null> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [
      { name: "FITS", extensions: ["fits", "fit", "fts", "fits.gz", "fits.fz"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return typeof selected === "string" ? selected : null;
}
