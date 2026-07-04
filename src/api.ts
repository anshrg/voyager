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

export function takePendingOpens(): Promise<string[]> {
  return invoke<string[]>("take_pending_opens");
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
