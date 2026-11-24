// RGB composite frames: state, the derivation of what the shader draws, and
// the control panel shown in the sidebar while a composite frame is active.
// Frame plumbing (hiding band frames, lock, frame bar) lives in main.ts; this
// module knows nothing about frames beyond an opaque handle per band.
//
// Layout/controls follow CAMPFIRE's map DisplayPanel + TrilogyWeights (MIT,
// H. Akins): a simple / trilogy mode switch, a per-band R/G/B weight matrix
// with include toggles and a "rainbow" reset, and the trilogy knobs.

import type { DetectedBand } from "./api";
import { STRETCHES, type Stretch } from "./render/gl";
import {
  DEFAULT_TRILOGY_PARAMS,
  MAX_BANDS,
  TRILOGY_STRETCH_ID,
  rainbowWeights,
  trilogyLevels,
  type BandWeight,
  type CompositeBand,
  type TrilogyParams,
  type TrilogyStats,
} from "./render/trilogy";
import type { CompositeDisplay, CompositeSource } from "./render/viewer";
import type { Wcs } from "./render/wcs";

export type RgbMode = "trilogy" | "simple";

export interface RgbBand<F> {
  /** The (hidden) frame this band comes from. */
  frame: F;
  path: string;
  hdu: number;
  /** Filter (e.g. F444W) or file name. */
  label: string;
  band: DetectedBand | null;
  stats: TrilogyStats | null;
  zscale: [number, number] | null;
  bunit: string | null;
  /** The band's own pixel grid (it may differ from the composite's
   *  reference grid; the viewer then reprojects it through the WCSs). */
  nx: number;
  ny: number;
  wcs: Wcs | null;
  /** Participates in the trilogy mix. */
  include: boolean;
  weight: BandWeight;
}

export interface RgbState<F> {
  /** Blue → red (by pivot wavelength; unrecognized filters last). */
  bands: RgbBand<F>[];
  mode: RgbMode;
  params: TrilogyParams;
  /** Composite color saturation (1 = identity). */
  saturation: number;
  /** Simple mode: band index per channel, one shared range + DS9 stretch. */
  simple: { r: number; g: number; b: number; lo: number; hi: number; stretch: Stretch };
  /** Frame bar shows the band frames nested under the composite chip. */
  expanded: boolean;
  /** The user hand-edited a weight since the last rainbow spread; a band
   *  reorder then keeps weights instead of re-spreading the rainbow. */
  customWeights: boolean;
  /** The reference pixel grid the composite is drawn on (finest band by
   *  default); its frame's file/HDU is the composite frame's. */
  nx: number;
  ny: number;
  wcs: Wcs | null;
}

/** Build the initial state for bands already sorted blue → red. */
export function initialRgbState<F>(
  bands: Omit<RgbBand<F>, "include" | "weight">[],
  nx: number,
  ny: number,
  wcs: Wcs | null,
): RgbState<F> {
  const usable = bands.filter((b) => b.stats !== null).length;
  const n = bands.length;
  const full: RgbBand<F>[] = bands.map((b) => ({ ...b, include: b.stats !== null, weight: [0, 0, 0] }));
  applyRainbow(full);
  // Simple: bluest → B, reddest → R, middle → G (2 bands: G shares the blue one).
  const b = 0;
  const r = n - 1;
  const g = n >= 3 ? Math.floor((n - 1) / 2) : 0;
  const state: RgbState<F> = {
    bands: full,
    mode: usable > 0 ? "trilogy" : "simple",
    params: { ...DEFAULT_TRILOGY_PARAMS },
    saturation: 1,
    simple: { r, g, b, lo: 0, hi: 1, stretch: "linear" },
    expanded: false,
    customWeights: false,
    nx,
    ny,
    wcs,
  };
  resetSimpleLimits(state);
  return state;
}

/** Rainbow weights over the included bands in their current order (blue →
 *  red by default); excluded bands get 0. */
export function applyRainbow<F>(bands: RgbBand<F>[]): void {
  const inc = bands.filter((b) => b.include);
  const w = rainbowWeights(inc.length);
  for (const b of bands) b.weight = [0, 0, 0];
  inc.forEach((b, i) => {
    b.weight = [...w[i]];
  });
}

/** Move band `from` to position `to` (drag-reordered chips). Simple-mode
 *  channel picks follow their bands; trilogy weights re-spread over the new
 *  order unless hand-edited. */
export function moveRgbBand<F>(s: RgbState<F>, from: number, to: number): void {
  if (from === to) return;
  const pick = { r: s.bands[s.simple.r], g: s.bands[s.simple.g], b: s.bands[s.simple.b] };
  const [band] = s.bands.splice(from, 1);
  s.bands.splice(Math.max(0, Math.min(s.bands.length, to)), 0, band);
  s.simple.r = s.bands.indexOf(pick.r);
  s.simple.g = s.bands.indexOf(pick.g);
  s.simple.b = s.bands.indexOf(pick.b);
  if (!s.customWeights) applyRainbow(s.bands);
}

/** Simple-mode shared range: the mean of the three channel bands' zscale
 *  limits (CAMPFIRE's simple RGB uses one shared range). */
export function resetSimpleLimits<F>(s: RgbState<F>): void {
  const zs = [s.simple.r, s.simple.g, s.simple.b]
    .map((i) => s.bands[i]?.zscale)
    .filter((z): z is [number, number] => z !== null && z !== undefined);
  if (zs.length === 0) return;
  s.simple.lo = zs.reduce((a, z) => a + z[0], 0) / zs.length;
  s.simple.hi = zs.reduce((a, z) => a + z[1], 0) / zs.length;
}

/** What the viewer draws now: the participating bands + shader uniforms.
 *  Simple mode merges a band used on several channels into one entry. */
export function compositeDraw<F>(s: RgbState<F>): { sources: CompositeSource[]; display: CompositeDisplay } {
  const sources: CompositeSource[] = [];
  const bands: CompositeBand[] = [];
  if (s.mode === "trilogy") {
    for (const b of s.bands) {
      if (!b.include || !b.stats) continue;
      const lv = trilogyLevels(b.stats, s.params);
      sources.push({ path: b.path, hdu: b.hdu, label: b.label, nx: b.nx, ny: b.ny, wcs: b.wcs });
      bands.push({ lo: lv.x0, hi: lv.x2, k: lv.k, weight: [...b.weight] });
    }
  } else {
    const roles: [number, BandWeight][] = [
      [s.simple.r, [1, 0, 0]],
      [s.simple.g, [0, 1, 0]],
      [s.simple.b, [0, 0, 1]],
    ];
    for (const [idx, w] of roles) {
      const b = s.bands[idx];
      if (!b) continue;
      const at = sources.findIndex((x) => x.path === b.path && x.hdu === b.hdu);
      if (at >= 0) {
        for (let c = 0; c < 3; c++) bands[at].weight[c] += w[c];
      } else {
        sources.push({ path: b.path, hdu: b.hdu, label: b.label, nx: b.nx, ny: b.ny, wcs: b.wcs });
        bands.push({ lo: s.simple.lo, hi: s.simple.hi, k: 0, weight: [...w] });
      }
    }
  }
  const stretch = s.mode === "trilogy" ? TRILOGY_STRETCH_ID : STRETCHES.indexOf(s.simple.stretch);
  return { sources, display: { bands, stretch, saturation: s.saturation } };
}

/** Distinct BUNITs across the bands (more than one → mixed-unit warning). */
export function distinctUnits<F>(s: RgbState<F>): string[] {
  return [...new Set(s.bands.map((b) => b.bunit ?? "(none)"))];
}

// ---- side panel -------------------------------------------------------------

const CH = ["#ef4444", "#22c55e", "#3b82f6"] as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function swatch(w: BandWeight): string {
  const c = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 255);
  return `rgb(${c(w[0])},${c(w[1])},${c(w[2])})`;
}

/** Labeled slider row. `toSlider`/`fromSlider` map a non-linear knob (the
 *  log-scaled saturate %) onto the range input. */
function sliderRow(
  label: string,
  title: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (v: number) => void,
  fmt: (v: number) => string = (v) => v.toFixed(2),
  toSlider: (v: number) => number = (v) => v,
  fromSlider: (v: number) => number = (v) => v,
): HTMLElement {
  const row = el("label", "rgb-slider");
  row.title = title;
  const name = el("span", "rgb-slider-name", label);
  const input = el("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(toSlider(value));
  const out = el("span", "rgb-slider-val", fmt(value));
  input.addEventListener("input", () => {
    const v = fromSlider(Number(input.value));
    out.textContent = fmt(v);
    onInput(v);
  });
  row.append(name, input, out);
  return row;
}

/** Callbacks from the panel. `structural` = the set of drawn bands may have
 *  changed (tiles/sources must update) vs. uniforms only. */
export interface RgbPanelHost {
  changed(structural: boolean): void;
  /** Rebuild the panel (after a change that alters its own layout). */
  rerender(): void;
}

/** Render the composite control panel into `root` (the sidebar). */
export function renderRgbPanel<F>(root: HTMLElement, s: RgbState<F>, host: RgbPanelHost): void {
  root.replaceChildren();
  const panel = el("div", "rgb-panel");

  // Mode switch.
  const modes = el("div", "rgb-modes");
  for (const m of ["trilogy", "simple"] as const) {
    const b = el("button", s.mode === m ? "active-btn" : "", m === "trilogy" ? "Trilogy" : "Simple");
    b.title =
      m === "trilogy"
        ? "Weighted N-band trilogy: each band log-stretched by its own noise/saturation levels, mixed by R/G/B weights"
        : "Classic 3-color: one band per channel, one shared range + stretch";
    b.addEventListener("click", () => {
      if (s.mode === m) return;
      s.mode = m;
      host.changed(true);
      host.rerender();
    });
    modes.append(b);
  }
  panel.append(modes);

  if (s.mode === "trilogy") renderTrilogy(panel, s, host);
  else renderSimple(panel, s, host);

  panel.append(
    sliderRow(
      "Color sat.",
      "Composite color saturation: 1 = as mixed, 0 = grayscale, >1 boosts color separation",
      s.saturation,
      0,
      2,
      0.05,
      (v) => {
        s.saturation = v;
        host.changed(false);
      },
    ),
  );

  const units = distinctUnits(s);
  if (units.length > 1) {
    panel.append(
      el("div", "rgb-warn", `⚠ bands have different units (${units.join(", ")}) — the mix may be misleading`),
    );
  }
  panel.append(
    el("div", "rgb-hint", "Right-drag on the image adjusts bias/contrast; the frame chip's ▸ shows the band frames."),
  );
  root.append(panel);
}

function renderTrilogy<F>(panel: HTMLElement, s: RgbState<F>, host: RgbPanelHost): void {
  const head = el("div", "rgb-section-head");
  head.append(el("span", "", "Weights"));
  const rainbow = el("button", "", "✦ rainbow");
  rainbow.title =
    "Spread the included bands across B → R in their current order (drag the band chips under ▸ to reorder)";
  rainbow.addEventListener("click", () => {
    applyRainbow(s.bands);
    s.customWeights = false;
    host.changed(false);
    host.rerender();
  });
  head.append(rainbow);
  panel.append(head);

  const grid = el("div", "rgb-weights");
  const hdr = el("div", "rgb-wrow rgb-whead");
  hdr.append(el("span"), el("span"));
  ["R", "G", "B"].forEach((c, i) => {
    const h = el("span", "rgb-wch", c);
    h.style.color = CH[i];
    hdr.append(h);
  });
  grid.append(hdr);

  const included = s.bands.filter((b) => b.include).length;
  for (const b of s.bands) {
    const row = el("div", "rgb-wrow");
    if (!b.include) row.classList.add("off");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = b.include;
    cb.disabled = !b.stats || (!b.include && included >= MAX_BANDS);
    cb.title = !b.stats
      ? "No usable pixels (empty or constant band)"
      : !b.include && included >= MAX_BANDS
        ? `A composite mixes at most ${MAX_BANDS} bands`
        : "Include this band";
    cb.addEventListener("change", () => {
      // A band re-included with all-zero weights would add nothing; start it
      // white (fitsgl's default) — "rainbow" re-spreads everything.
      if (cb.checked && b.weight.every((w) => w === 0)) b.weight = [1, 1, 1];
      b.include = cb.checked;
      if (!s.bands.some((x) => x.include)) {
        b.include = true; // keep at least one band
        cb.checked = true;
        return;
      }
      host.changed(true);
      host.rerender();
    });
    const name = el("span", "rgb-wname");
    const sw = el("span", "rgb-swatch");
    sw.style.background = swatch(b.weight);
    name.append(sw, el("span", "", b.label));
    name.title = `${b.path} [${b.hdu}]${b.band ? ` — ${b.band.pivot_um} µm` : ""}`;
    row.append(cb, name);
    for (let c = 0; c < 3; c++) {
      const inp = el("input", "rgb-wnum");
      inp.type = "number";
      inp.min = "0";
      inp.max = "1";
      inp.step = "0.05";
      inp.value = b.weight[c].toFixed(2);
      inp.style.borderBottomColor = CH[c];
      inp.disabled = !b.include;
      inp.addEventListener("input", () => {
        const v = Number(inp.value);
        if (!Number.isFinite(v)) return;
        b.weight[c] = Math.min(1, Math.max(0, v));
        s.customWeights = true;
        sw.style.background = swatch(b.weight);
        host.changed(false);
      });
      row.append(inp);
    }
    grid.append(row);
  }
  panel.append(grid);

  panel.append(el("div", "rgb-section-head", "Stretch"));
  const p = s.params;
  const push = (): void => host.changed(false);
  panel.append(
    sliderRow("Noise lum.", "Display level (0–1) the noise level maps to", p.noiselum, 0.01, 0.5, 0.01, (v) => {
      p.noiselum = v;
      push();
    }),
    sliderRow(
      "Saturate %",
      "Percent of pixels allowed to saturate (log scale, 0.001–1)",
      p.satpercent,
      -3,
      0,
      0.05,
      (v) => {
        p.satpercent = v;
        push();
      },
      (v) => (v >= 0.1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(4)),
      (v) => Math.log10(v),
      (v) => 10 ** v,
    ),
    sliderRow("Noise σ", "Noise level x1 = sky + noise σ × sigma", p.noisesig, 0, 5, 0.1, (v) => {
      p.noisesig = v;
      push();
    }, (v) => v.toFixed(1)),
    sliderRow("Black σ", "Black point x0 = sky − black σ × sigma", p.noisesig0, 0, 5, 0.1, (v) => {
      p.noisesig0 = v;
      push();
    }, (v) => v.toFixed(1)),
  );
}

function renderSimple<F>(panel: HTMLElement, s: RgbState<F>, host: RgbPanelHost): void {
  panel.append(el("div", "rgb-section-head", "Channels"));
  for (const [role, i] of [
    ["r", 0],
    ["g", 1],
    ["b", 2],
  ] as const) {
    const row = el("label", "rgb-slider");
    const tag = el("span", "rgb-slider-name", role.toUpperCase());
    tag.style.color = CH[i];
    const sel = el("select", "control-select");
    s.bands.forEach((b, bi) => {
      const o = el("option", "", b.label);
      o.value = String(bi);
      sel.append(o);
    });
    sel.value = String(s.simple[role]);
    sel.addEventListener("change", () => {
      s.simple[role] = Number(sel.value);
      host.changed(true);
    });
    row.append(tag, sel);
    panel.append(row);
  }

  panel.append(el("div", "rgb-section-head", "Range (shared)"));
  const lim = el("div", "rgb-limits");
  const lo = el("input", "rgb-limit");
  const hi = el("input", "rgb-limit");
  lo.value = s.simple.lo.toPrecision(5);
  hi.value = s.simple.hi.toPrecision(5);
  lo.title = "Black level (all channels)";
  hi.title = "White level (all channels)";
  const apply = (): void => {
    const a = Number(lo.value);
    const b = Number(hi.value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    s.simple.lo = a;
    s.simple.hi = b;
    host.changed(false);
  };
  lo.addEventListener("change", apply);
  hi.addEventListener("change", apply);
  const z = el("button", "", "zscale");
  z.title = "Reset to the mean zscale range of the three channel bands";
  z.addEventListener("click", () => {
    resetSimpleLimits(s);
    host.changed(false);
    host.rerender();
  });
  lim.append(lo, el("span", "", "–"), hi, z);
  panel.append(lim);

  const row = el("label", "rgb-slider");
  const sel = el("select", "control-select");
  for (const name of STRETCHES) {
    const o = el("option", "", name);
    o.value = name;
    sel.append(o);
  }
  sel.value = s.simple.stretch;
  sel.addEventListener("change", () => {
    s.simple.stretch = sel.value as Stretch;
    host.changed(false);
  });
  row.append(el("span", "rgb-slider-name", "Stretch"), sel);
  panel.append(row);
}
