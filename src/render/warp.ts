// Reprojection geometry for RGB composites whose bands sit on different
// pixel grids (e.g. NIRCam 30 mas + MIRI 60 mas, rotated or offset).
//
// Nothing here resamples pixels. Each band keeps its own native tiles; a band
// tile is drawn as a small mesh whose vertices are placed exactly through the
// WCS chain band pixel → sky → reference pixel, and the GPU interpolates
// linearly in between. Between two TAN grids over a few arcminutes that map is
// affine to far below 0.01 px per mesh cell (checked by check_trilogy.mjs
// against astropy), so the mesh is effectively exact.
//
// Coordinates: FITS 0-based pixels (integer = pixel center) for the maps;
// "draw" coordinates (pixel i spans [i, i+1), = FITS + 0.5) for meshes and
// tile rects, matching the viewer's vertex shader.

import { gridMismatch, type GridSpec } from "./trilogy";
import type { Wcs } from "./wcs";

/** Maps FITS 0-based pixels between a reference grid and one band's grid. */
export interface GridMap {
  /** Same grid as the reference (no warp; the single-pass shader applies). */
  readonly identity: boolean;
  /** Band pixels per reference pixel, linear (MIRI 60 mas on 30 mas = 0.5). */
  readonly bandPerRef: number;
  refToBand(x: number, y: number): [number, number] | null;
  bandToRef(x: number, y: number): [number, number] | null;
}

export const IDENTITY_MAP: GridMap = {
  identity: true,
  bandPerRef: 1,
  refToBand: (x, y) => [x, y],
  bandToRef: (x, y) => [x, y],
};

/** Reference ↔ band through the sky (both TAN WCSs). */
export class WcsWarp implements GridMap {
  readonly identity = false;
  readonly bandPerRef: number;

  constructor(
    private readonly ref: Wcs,
    private readonly band: Wcs,
  ) {
    this.bandPerRef = ref.pixScale() / band.pixScale();
  }

  refToBand(x: number, y: number): [number, number] | null {
    const [lon, lat] = this.ref.pixToWorld(x, y);
    return this.band.worldToPix(lon, lat);
  }

  bandToRef(x: number, y: number): [number, number] | null {
    const [lon, lat] = this.band.pixToWorld(x, y);
    return this.ref.worldToPix(lon, lat);
  }
}

/** How `band` joins a composite drawn on `ref`'s grid: the identity map
 *  (co-gridded), a WCS warp, or the reason it can't (a string). */
export function gridMapFor(ref: GridSpec, band: GridSpec): GridMap | string {
  if (gridMismatch(ref, band) === null) return IDENTITY_MAP;
  if (!ref.wcs || !band.wcs) {
    return ref.wcs || band.wcs ? "only one has a WCS" : `size ${band.nx}×${band.ny} ≠ ${ref.nx}×${ref.ny}, no WCS`;
  }
  if (ref.wcs.sipIgnored() || band.wcs.sipIgnored()) return "SIP distortion — can't reproject";
  const warp = new WcsWarp(ref.wcs, band.wcs);
  return footprintsOverlap(warp, ref, band) ? warp : "no sky overlap";
}

/** Do the two images' pixel footprints overlap on the sky? Samples a grid
 *  over each image and asks whether any sample lands inside the other one
 *  (both directions, so a small image inside a big one is caught). */
export function footprintsOverlap(map: GridMap, ref: { nx: number; ny: number }, band: { nx: number; ny: number }): boolean {
  const n = 16;
  const inside = (p: [number, number] | null, g: { nx: number; ny: number }): boolean =>
    p !== null && p[0] >= -0.5 && p[1] >= -0.5 && p[0] <= g.nx - 0.5 && p[1] <= g.ny - 0.5;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const fx = i / n;
      const fy = j / n;
      if (inside(map.bandToRef(fx * band.nx - 0.5, fy * band.ny - 0.5), ref)) return true;
      if (inside(map.refToBand(fx * ref.nx - 0.5, fy * ref.ny - 0.5), band)) return true;
    }
  }
  return false;
}

/** Mesh cells per tile side (TILE = 256 → 32-band-px cells at level 0). */
export const MESH_CELLS = 8;

/** Vertices of one band tile's mesh, interleaved [refX, refY, u, v] per
 *  vertex: reference draw coordinates + the tile texture coordinate. The tile
 *  covers band draw rect (x0, y0, w, h). null when a vertex falls behind the
 *  reference tangent plane (≥ 90° away — never for real composites). */
export function tileMesh(map: GridMap, x0: number, y0: number, w: number, h: number): Float32Array | null {
  const n = MESH_CELLS;
  const out = new Float32Array((n + 1) * (n + 1) * 4);
  let o = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const v = j / n;
      const p = map.bandToRef(x0 + u * w - 0.5, y0 + v * h - 0.5);
      if (!p) return null;
      out[o++] = p[0] + 0.5;
      out[o++] = p[1] + 0.5;
      out[o++] = u;
      out[o++] = v;
    }
  }
  return out;
}

/** Triangle indices for a tileMesh (shared by every tile). */
export function meshIndices(): Uint16Array {
  const n = MESH_CELLS;
  const idx: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return Uint16Array.from(idx);
}

/** Band draw-coordinate bounding box [x0, y0, x1, y1] of a polygon given in
 *  reference draw coordinates (the visible screen). Samples the edges, since
 *  the map is only near-affine. null when any sample has no band position. */
export function bandBounds(map: GridMap, pts: [number, number][]): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const steps = 4;
  for (let k = 0; k < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[(k + 1) % pts.length];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const p = map.refToBand(ax + (bx - ax) * t - 0.5, ay + (by - ay) * t - 0.5);
      if (!p) return null;
      x0 = Math.min(x0, p[0] + 0.5);
      y0 = Math.min(y0, p[1] + 0.5);
      x1 = Math.max(x1, p[0] + 0.5);
      y1 = Math.max(y1, p[1] + 0.5);
    }
  }
  return [x0, y0, x1, y1];
}
