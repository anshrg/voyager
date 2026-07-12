// Frontend TAN (gnomonic) WCS: a faithful mirror of the Rust `wcs` module's
// `pix_to_world` / `world_to_pix` (src-tauri/src/wcs/mod.rs). It exists so the
// UI can transform pixel↔sky *synchronously*, without an IPC round-trip:
//   - WCS-lock broadcasts the active frame's camera on every pan frame, and
//   - catalog overlay projects thousands of catalog rows at once,
// both of which would stutter if each point crossed the IPC boundary.
//
// The Rust side stays the source of truth for *parsing* the header into
// `WcsParams`; this only re-implements the (fixed, TAN-only) transform math.
// Keep the two in lockstep — the Rust version is fixture-gated against astropy.

import type { WcsParams } from "../api";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export class Wcs {
  constructor(private readonly p: WcsParams) {}

  /** FITS 0-based pixel (integer coord = pixel center) → [lon, lat] degrees,
   *  lon in [0, 360). Mirrors Rust `Wcs::pix_to_world`. */
  pixToWorld(x: number, y: number): [number, number] {
    const { crpix, cd, lon0, lat0, lonpole, swapped } = this.p;
    const dp0 = x + 1 - crpix[0];
    const dp1 = y + 1 - crpix[1];
    const u = cd[0][0] * dp0 + cd[0][1] * dp1;
    const v = cd[1][0] * dp0 + cd[1][1] * dp1;
    const px = swapped ? v : u;
    const py = swapped ? u : v;

    const r = Math.hypot(px, py);
    const phi = r === 0 ? 0 : Math.atan2(px, -py);
    const theta = r === 0 ? Math.PI / 2 : Math.atan(R2D / r);

    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    const sinDp = Math.sin(lat0 * D2R);
    const cosDp = Math.cos(lat0 * D2R);
    const dphi = phi - lonpole * D2R;
    const sinDphi = Math.sin(dphi);
    const cosDphi = Math.cos(dphi);

    const lat = Math.asin(clamp(sinT * sinDp + cosT * cosDp * cosDphi, -1, 1));
    const lon =
      lon0 * D2R + Math.atan2(-cosT * sinDphi, sinT * cosDp - cosT * sinDp * cosDphi);
    return [mod360(lon * R2D), lat * R2D];
  }

  /** [lon, lat] degrees → FITS 0-based pixel, or null when the point is on or
   *  behind the tangent-plane horizon (≥90° from field center). Mirrors Rust
   *  `Wcs::world_to_pix`. */
  worldToPix(lon: number, lat: number): [number, number] | null {
    const { crpix, cd_inv, lon0, lat0, lonpole, swapped } = this.p;
    const sinD = Math.sin(lat * D2R);
    const cosD = Math.cos(lat * D2R);
    const sinDp = Math.sin(lat0 * D2R);
    const cosDp = Math.cos(lat0 * D2R);
    const da = (lon - lon0) * D2R;
    const sinDa = Math.sin(da);
    const cosDa = Math.cos(da);

    const a = -cosD * sinDa;
    const b = sinD * cosDp - cosD * sinDp * cosDa;
    const n = sinD * sinDp + cosD * cosDp * cosDa;
    if (n <= 0) return null;

    const sinPp = Math.sin(lonpole * D2R);
    const cosPp = Math.cos(lonpole * D2R);
    const px = (R2D * (a * cosPp + b * sinPp)) / n;
    const py = (-R2D * (b * cosPp - a * sinPp)) / n;
    const u = swapped ? py : px;
    const v = swapped ? px : py;

    const dp0 = cd_inv[0][0] * u + cd_inv[0][1] * v;
    const dp1 = cd_inv[1][0] * u + cd_inv[1][1] * v;
    return [dp0 + crpix[0] - 1, dp1 + crpix[1] - 1];
  }

  /** Geometric-mean plate scale, degrees per pixel (√|det CD|). Used to match
   *  angular zoom across frames under WCS-lock. */
  pixScale(): number {
    const cd = this.p.cd;
    return Math.sqrt(Math.abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0]));
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Positive remainder mod 360 (Rust `rem_euclid(360.0)`). */
function mod360(v: number): number {
  return ((v % 360) + 360) % 360;
}
