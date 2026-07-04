// Typed wrappers around the Tauri IPC surface. Keep all `invoke` calls here
// so the rest of the frontend deals only in typed functions.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

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

/** Pixel readout at FITS 0-based (x, y); null = NaN/BLANK. */
export function getPixel(
  path: string,
  hdu: number,
  x: number,
  y: number,
): Promise<number | null> {
  return invoke<number | null>("get_pixel", { path, hdu, x, y });
}

export function takePendingOpens(): Promise<string[]> {
  return invoke<string[]>("take_pending_opens");
}

export function listOpenFiles(): Promise<string[]> {
  return invoke<string[]>("list_open_files");
}

export function onOpenRequest(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("ds10://open-request", (e) => handler(e.payload));
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
