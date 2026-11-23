// RGB composite math: trilogy levels, default (rainbow) weights, the CPU
// reference of the composite shader, and the co-gridded check.
//
// Ported from fitsgl-core (src/renderer/stretch.ts, src/wcs/grid-match.ts,
// src/react/explorer-state.ts), MIT, H. Akins — used with permission. The
// GLSL in gl.ts transcribes `compositePixel` exactly; both are gated on
// fixtures/rgb_expected.json (scripts/check_trilogy.mjs, from gen_rgb_fixtures.py).
//
// Pure: no DOM, no GL, no IPC — so the node check can import it directly.

import type { Wcs } from "./wcs";

/** Most bands one composite can mix. The shader declares fixed-size sampler
 *  arrays of this length, one texture unit each; WebGL2 guarantees ≥16 units. */
export const MAX_BANDS = 12;

/** A band's (R, G, B) contribution weight, each in [0, 1]. */
export type BandWeight = [number, number, number];

/** Per-band robust stats from the backend (`get_band_info`). */
export interface TrilogyStats {
  /** Median (robust sky level). */
  mean: number;
  /** 1.4826 · MAD. */
  sigma: number;
  p99: number;
  p99_9: number;
  p99_99: number;
  p99_999: number;
}

/** User knobs. Levels re-derive from these instantly (no rescan). */
export interface TrilogyParams {
  /** Display level the noise maps to (0..1). */
  noiselum: number;
  /** Percent of pixels allowed to saturate (0.001..1). */
  satpercent: number;
  /** Noise level x1 = mean + noisesig·σ. */
  noisesig: number;
  /** Black point x0 = mean − noisesig0·σ. */
  noisesig0: number;
}

export const DEFAULT_TRILOGY_PARAMS: TrilogyParams = {
  noiselum: 0.15,
  satpercent: 0.001,
  noisesig: 1,
  noisesig0: 2,
};

/** One band's derived levels: black x0, noise x1, white x2, softening k. */
export interface TrilogyLevels {
  x0: number;
  x1: number;
  x2: number;
  k: number;
}

/** Softening used when no level fit applies (= DS9/astropy log a = 1000). */
export const DEFAULT_TRILOGY_K = 1000;

/** Solve log(K·n1 + 1)/log(K + 1) = noiselum for K > 0 by bisection. g(K)
 *  rises from n1 (K→0) to 1 (K→∞): noiselum ≤ n1 degenerates to linear (0),
 *  noiselum ≥ 1 saturates. */
export function solveTrilogyK(norm1: number, noiselum: number, iterations = 64): number {
  if (!(norm1 > 0) || !(norm1 < 1)) return DEFAULT_TRILOGY_K;
  if (noiselum <= norm1) return 0;
  if (noiselum >= 1) return 1e30;
  const g = (k: number): number => Math.log(k * norm1 + 1) / Math.log(k + 1);
  let lo = 0;
  let hi = 1;
  while (g(hi) < noiselum) {
    hi *= 2;
    if (hi > 1e30) return hi;
  }
  for (let i = 0; i < iterations; i++) {
    const mid = 0.5 * (lo + hi);
    if (g(mid) < noiselum) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Saturation level x2 for `satpercent`, interpolated linearly in
 *  log10(satpercent) between the stored tail percentiles (1 → p99 …
 *  0.001 → p99.999), clamped to that range. */
export function saturationValue(s: TrilogyStats, satpercent: number): number {
  const anchors: [number, number][] = [
    [1, s.p99],
    [0.1, s.p99_9],
    [0.01, s.p99_99],
    [0.001, s.p99_999],
  ];
  const sp = Math.min(1, Math.max(0.001, satpercent));
  const x = Math.log10(sp);
  for (let i = 0; i < anchors.length - 1; i++) {
    const [pHi, vHi] = anchors[i];
    const [pLo, vLo] = anchors[i + 1];
    const xHi = Math.log10(pHi);
    const xLo = Math.log10(pLo);
    if (x <= xHi && x >= xLo) {
      const t = (x - xLo) / (xHi - xLo);
      return vLo + t * (vHi - vLo);
    }
  }
  return sp >= 1 ? s.p99 : s.p99_999;
}

/** A band's trilogy levels from its stats + the shared knobs. */
export function trilogyLevels(s: TrilogyStats, p: TrilogyParams): TrilogyLevels {
  const x0 = s.mean - p.noisesig0 * s.sigma;
  const x1 = s.mean + p.noisesig * s.sigma;
  let x2 = saturationValue(s, p.satpercent);
  if (!(x2 > x0)) x2 = x0 + Math.max(s.sigma, 1e-30);
  const norm1 = Math.min(0.999, Math.max(0, (x1 - x0) / (x2 - x0)));
  return { x0, x1, x2, k: solveTrilogyK(norm1, p.noiselum) };
}

/** HSV (h degrees, s/v in [0,1]) → RGB in [0,1]. */
export function hsvToRgb(h: number, s: number, v: number): BandWeight {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let rgb: [number, number, number];
  if (hh < 1) rgb = [c, x, 0];
  else if (hh < 2) rgb = [x, c, 0];
  else if (hh < 3) rgb = [0, c, x];
  else if (hh < 4) rgb = [0, x, c];
  else if (hh < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

/** Rainbow weights for n wavelength-ordered bands (bluest first): hue 240°
 *  (blue) → 0° (red). One band is white; three are pure B, G, R. */
export function rainbowWeights(n: number): BandWeight[] {
  if (n <= 0) return [];
  if (n === 1) return [[1, 1, 1]];
  const out: BandWeight[] = [];
  for (let i = 0; i < n; i++) out.push(hsvToRgb(240 * (1 - i / (n - 1)), 1, 1));
  return out;
}

/** Stretch modes the composite shader supports, as uniform ids. Ids 0–6 are
 *  the DS9 stretches of the single-band shader (STRETCHES order); 7 is the
 *  trilogy log curve with a per-band softening k. */
export const TRILOGY_STRETCH_ID = 7;

/** DS9 stretch transfer on t ∈ [0,1], mirroring gl.ts `stretchFn`. */
export function ds9Stretch(t: number, id: number): number {
  const a = 1000;
  switch (id) {
    case 1:
      return Math.log(a * t + 1) / Math.log(a + 1);
    case 2:
      return Math.sqrt(t);
    case 3:
      return t * t;
    case 4:
      return Math.asinh(10 * t) / Math.asinh(10);
    case 5:
      return Math.sinh(3 * t) / Math.sinh(3);
    case 6:
      return (Math.pow(a, t) - 1) / (a - 1);
    default:
      return t;
  }
}

/** Per-band display inputs for one composite draw. */
export interface CompositeBand {
  lo: number;
  hi: number;
  /** Trilogy softening (only used when stretch === TRILOGY_STRETCH_ID). */
  k: number;
  weight: BandWeight;
}

/** CPU reference of the composite fragment shader for one pixel (NaN = no
 *  data in that band). Each band is normalized over its own [lo, hi], clamped
 *  and stretched to s_i; channel c = Σ w_ic·s_i / Σ w_ic (a NaN band adds 0 to
 *  the numerator — fitsgl semantics, so coverage edges dim rather than shift
 *  color). Then saturation about the channel mean, then DS9 bias/contrast.
 *  Returns null when every band is NaN (background). */
export function compositePixel(
  values: number[],
  bands: CompositeBand[],
  stretch: number,
  saturation: number,
  bias = 0.5,
  contrast = 1,
): BandWeight | null {
  const num = [0, 0, 0];
  const den = [0, 0, 0];
  let nan = 0;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    for (let c = 0; c < 3; c++) den[c] += b.weight[c];
    const v = values[i];
    if (Number.isNaN(v)) {
      nan++;
      continue;
    }
    const span = b.hi - b.lo;
    const t = Math.min(1, Math.max(0, (v - b.lo) / (Math.abs(span) < 1e-30 ? 1e-30 : span)));
    let s: number;
    if (stretch === TRILOGY_STRETCH_ID) s = b.k > 0 ? Math.log(b.k * t + 1) / Math.log(b.k + 1) : t;
    else s = ds9Stretch(t, stretch);
    for (let c = 0; c < 3; c++) num[c] += b.weight[c] * s;
  }
  if (nan === bands.length) return null;
  let rgb = num.map((n, c) => (den[c] > 0 ? Math.min(1, Math.max(0, n / den[c])) : 0));
  if (saturation !== 1) {
    const lum = (rgb[0] + rgb[1] + rgb[2]) / 3;
    rgb = rgb.map((c) => Math.min(1, Math.max(0, lum + (c - lum) * saturation)));
  }
  rgb = rgb.map((c) => Math.min(1, Math.max(0, 0.5 + (c - bias) * contrast)));
  return [rgb[0], rgb[1], rgb[2]];
}

// ---- co-gridded check (port of fitsgl wcs/grid-match.ts) -------------------

/** Max sky disagreement at a sampled point, as a fraction of a pixel. A half-
 *  pixel misregistration (0.5) is 10× this, so it is always rejected. */
export const GRID_MATCH_SUBPIXEL_FRACTION = 0.05;

export interface GridSpec {
  nx: number;
  ny: number;
  wcs: Wcs | null;
}

function sepArcsec(a: [number, number], b: [number, number]): number {
  const d2r = Math.PI / 180;
  const [ra1, de1] = [a[0] * d2r, a[1] * d2r];
  const [ra2, de2] = [b[0] * d2r, b[1] * d2r];
  // Haversine: stable at the sub-mas separations this compares.
  const h =
    Math.sin((de2 - de1) / 2) ** 2 + Math.cos(de1) * Math.cos(de2) * Math.sin((ra2 - ra1) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h))) * 180 * 3600) / Math.PI;
}

/** Why two bands can't share a composite grid, or null if they can: exact
 *  shape match, and either both lack a WCS or both agree on the sky at the
 *  four corners + centre within 0.05 px (of the finer pixel scale). */
export function gridMismatch(a: GridSpec, b: GridSpec): string | null {
  if (a.nx !== b.nx || a.ny !== b.ny) return `size ${b.nx}×${b.ny} ≠ ${a.nx}×${a.ny}`;
  if (a.wcs === null && b.wcs === null) return null;
  if (a.wcs === null || b.wcs === null) return "only one has a WCS";
  const tol = Math.min(a.wcs.pixScale(), b.wcs.pixScale()) * 3600 * GRID_MATCH_SUBPIXEL_FRACTION;
  const pts: [number, number][] = [
    [0, 0],
    [a.nx - 1, 0],
    [0, a.ny - 1],
    [a.nx - 1, a.ny - 1],
    [(a.nx - 1) / 2, (a.ny - 1) / 2],
  ];
  for (const [x, y] of pts) {
    const sep = sepArcsec(a.wcs.pixToWorld(x, y), b.wcs.pixToWorld(x, y));
    if (sep > tol) return `WCS offset ${(sep / (tol / GRID_MATCH_SUBPIXEL_FRACTION)).toFixed(2)} px`;
  }
  return null;
}
