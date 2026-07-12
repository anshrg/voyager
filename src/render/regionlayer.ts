// DS9-region overlay: draws backend-resolved PixelRegions onto a 2D canvas
// stacked above the WebGL image canvas. Redrawn every viewer frame — a few
// hundred stroked paths are far below one frame of budget.

import type { PixelRegion } from "../api";

/** Camera snapshot from the viewer (canvas device pixels). */
export interface RegionView {
  cx: number;
  cy: number;
  scale: number;
  width: number;
  height: number;
  dpr: number;
  /** View rotation (radians, CCW in image y-up space); 0 = north-of-image up.
   *  Non-zero only under WCS-align lock. Kept in lockstep with the shader. */
  rot: number;
}

const DEFAULT_COLOR = "#00ff00"; // DS9 default green; .reg names are CSS-valid

/** Which regions to draw emphasized (indices into the region array, -1 =
 *  none). `selected` is the primary region — white glow + corner handles;
 *  every index in `selection` (a multi-select set) gets a white glow without
 *  handles; hover gets a fainter color glow. In edit mode the primary region
 *  shows shape-aware, draggable handles. */
export interface RegionHighlight {
  hover: number;
  selected: number;
  /** All highlighted regions (multi-select). Always includes `selected`. */
  selection?: ReadonlySet<number>;
  edit: boolean;
}

/** Image pixel center (0-based coord p) → device-pixel screen position.
 *  Applies the view rotation about the camera center (identity at rot=0), so
 *  overlays stay pinned to the raster the shader draws. Rotation couples x/y,
 *  so this returns a single projector rather than separable sx/sy. */
function screenMap(view: RegionView): (px: number, py: number) => [number, number] {
  const cos = Math.cos(view.rot);
  const sin = Math.sin(view.rot);
  return (px: number, py: number) => {
    const dx = px + 0.5 - view.cx;
    const dy = py + 0.5 - view.cy;
    const rx = cos * dx - sin * dy;
    const ry = sin * dx + cos * dy;
    return [view.width / 2 + rx * view.scale, view.height / 2 - ry * view.scale];
  };
}

export function drawRegions(
  canvas: HTMLCanvasElement,
  regions: readonly PixelRegion[] | null,
  view: RegionView,
  hl?: RegionHighlight,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, view.width, view.height);
  if (!regions || regions.length === 0) return;

  const project = screenMap(view);

  for (let i = 0; i < regions.length; i++) {
    const reg = regions[i];
    // 2 = primary (white glow + handles), 3 = also-selected (white glow, no
    // handles), 1 = hover (color glow), 0 = plain.
    const emph =
      hl && i === hl.selected ? 2 : hl?.selection?.has(i) ? 3 : hl && i === hl.hover ? 1 : 0;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = reg.color ?? DEFAULT_COLOR;
    ctx.lineWidth = Math.max(1, (reg.width ?? 1) * view.dpr) + (emph ? 1.5 * view.dpr : 0);
    ctx.setLineDash(reg.dash ? [6 * view.dpr, 4 * view.dpr] : []);
    if (emph) {
      ctx.shadowColor = emph === 1 ? reg.color ?? DEFAULT_COLOR : "#ffffff";
      ctx.shadowBlur = (emph === 1 ? 5 : 8) * view.dpr;
    }

    // Screen-space bounding box, for the exclusion slash and text anchor.
    let bbox: [number, number, number, number] | null = null;

    switch (reg.shape) {
      case "circle": {
        const [x, y] = project(reg.x, reg.y);
        const r = reg.r * view.scale;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.stroke();
        bbox = [x - r, y - r, x + r, y + r];
        break;
      }
      case "annulus": {
        const [x, y] = project(reg.x, reg.y);
        const [ri, ro] = [reg.rin * view.scale, reg.rout * view.scale];
        ctx.beginPath();
        ctx.arc(x, y, ri, 0, 2 * Math.PI);
        ctx.moveTo(x + ro, y);
        ctx.arc(x, y, ro, 0, 2 * Math.PI);
        ctx.stroke();
        bbox = [x - ro, y - ro, x + ro, y + ro];
        break;
      }
      case "ellipse": {
        const [x, y] = project(reg.x, reg.y);
        ctx.beginPath();
        // Image-space angle is CCW with y up; canvas y grows down. The view
        // rotation adds on top (same sign as the box path below).
        ctx.ellipse(
          x,
          y,
          reg.rx * view.scale,
          reg.ry * view.scale,
          (-reg.angle * Math.PI) / 180 - view.rot,
          0,
          2 * Math.PI,
        );
        ctx.stroke();
        const e = Math.max(reg.rx, reg.ry) * view.scale;
        bbox = [x - e, y - e, x + e, y + e];
        break;
      }
      case "box": {
        const [x, y] = project(reg.x, reg.y);
        const [w, h] = [reg.w * view.scale, reg.h * view.scale];
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate((-reg.angle * Math.PI) / 180 - view.rot);
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.restore();
        const e = Math.hypot(w, h) / 2;
        bbox = [x - e, y - e, x + e, y + e];
        break;
      }
      case "polygon": {
        if (reg.xs.length < 2) break;
        ctx.beginPath();
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < reg.xs.length; i++) {
          const [x, y] = project(reg.xs[i], reg.ys[i]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
        ctx.closePath();
        ctx.stroke();
        bbox = [x0, y0, x1, y1];
        break;
      }
      case "point": {
        const [x, y] = project(reg.x, reg.y);
        const r = 5 * view.dpr; // fixed screen size, like DS9 markers
        drawMarker(ctx, reg.point ?? "boxcircle", x, y, r);
        bbox = [x - r, y - r, x + r, y + r];
        break;
      }
    }

    if (bbox && !reg.include) {
      // DS9 marks excluded regions with a diagonal slash.
      ctx.beginPath();
      ctx.moveTo(bbox[0], bbox[3]);
      ctx.lineTo(bbox[2], bbox[1]);
      ctx.stroke();
    }
    if (bbox && reg.text) {
      ctx.font = `${11 * view.dpr}px -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(reg.text, (bbox[0] + bbox[2]) / 2, bbox[1] - 3 * view.dpr);
    }
    ctx.restore();
    // Selection handles are drawn without the glow (after restore) so they
    // stay crisp against the image. Edit mode shows shape-aware, draggable
    // handles; plain selection shows the bbox corners as a marker.
    if (emph === 2 && hl?.edit) drawEditHandles(ctx, reg, view);
    else if (emph === 2 && bbox) drawHandles(ctx, bbox, view.dpr);
  }
}

/** Nearest catalog source marker to the screen point (mx, my) within `tol`
 *  device px (+ the marker radius), returning its row index (from `rows`, one
 *  entry per xy pair) or -1. Used for the image→row reverse link. */
export function hitTestSourceMarkers(
  pts: Float64Array,
  rows: Int32Array,
  view: RegionView,
  mx: number,
  my: number,
  tol = 6,
): number {
  const project = screenMap(view);
  let best = -1;
  let bestD = (tol + 4) * view.dpr; // 4 = marker radius
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const [x, y] = project(pts[i], pts[i + 1]);
    const d = Math.hypot(mx - x, my - y);
    if (d <= bestD) {
      bestD = d;
      best = rows[i / 2];
    }
  }
  return best;
}

/** Draw a locator crosshair at image pixel (px, py) on the overlay, without
 *  clearing it (call after drawRegions). Pinned to the image via the same
 *  camera transform, so it tracks pan/zoom; `alpha` drives the Esc fade. */
export function drawCrosshair(
  canvas: HTMLCanvasElement,
  view: RegionView,
  px: number,
  py: number,
  alpha: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx || alpha <= 0) return;
  const [x, y] = screenMap(view)(px, py);
  const arm = 16 * view.dpr; // arm length beyond the center gap
  const gap = 5 * view.dpr;
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.strokeStyle = "#ffbe5a";
  ctx.lineWidth = 1.5 * view.dpr;
  ctx.beginPath();
  ctx.moveTo(x, y - gap - arm);
  ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap);
  ctx.lineTo(x, y + gap + arm);
  ctx.moveTo(x - gap - arm, y);
  ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y);
  ctx.lineTo(x + gap + arm, y);
  ctx.stroke();
  ctx.restore();
}

/** Draw catalog source markers (small circles) at flat image-pixel pairs
 *  [x0,y0,x1,y1,…], without clearing (call after drawRegions). Off-screen
 *  points are culled so a large catalog stays cheap; pinned to the image via
 *  the same camera transform. Used by the cross-file catalog→image overlay. */
export function drawSourceMarkers(
  canvas: HTMLCanvasElement,
  pts: Float64Array | null,
  view: RegionView,
  color: string,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx || !pts || pts.length === 0) return;
  const project = screenMap(view);
  const r = 4 * view.dpr;
  const margin = r + 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * view.dpr;
  ctx.beginPath();
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const [x, y] = project(pts[i], pts[i + 1]);
    if (x < -margin || y < -margin || x > view.width + margin || y > view.height + margin) {
      continue;
    }
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();
}

/** Center pixel (0-based) of a region; polygon uses its vertex centroid. */
function regionCenterPx(reg: PixelRegion): [number, number] {
  if (reg.shape === "polygon") {
    const n = reg.xs.length || 1;
    return [reg.xs.reduce((a, b) => a + b, 0) / n, reg.ys.reduce((a, b) => a + b, 0) / n];
  }
  return [reg.x, reg.y];
}

/** Indices of regions whose center falls inside the device-px screen rect
 *  (rubber-band select). Corners may be given in any order. */
export function regionsInRect(
  regions: readonly PixelRegion[],
  view: RegionView,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number[] {
  const project = screenMap(view);
  const lox = Math.min(x0, x1);
  const hix = Math.max(x0, x1);
  const loy = Math.min(y0, y1);
  const hiy = Math.max(y0, y1);
  const out: number[] = [];
  for (let i = 0; i < regions.length; i++) {
    const [cx, cy] = regionCenterPx(regions[i]);
    const [sx, sy] = project(cx, cy);
    if (sx >= lox && sx <= hix && sy >= loy && sy <= hiy) out.push(i);
  }
  return out;
}

/** Draw the rubber-band selection rectangle (device px), without clearing —
 *  call after drawRegions. */
export function drawRubberBand(
  canvas: HTMLCanvasElement,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dpr: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  ctx.save();
  ctx.strokeStyle = "#5aa7ff";
  ctx.fillStyle = "rgba(90, 167, 255, 0.12)";
  ctx.lineWidth = dpr;
  ctx.setLineDash([4 * dpr, 3 * dpr]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

/** Live preview of an in-progress polygon draft (click-to-add vertices):
 *  small dots at placed vertices, solid lines connecting them, and a dashed
 *  segment from the last vertex to the current cursor position (image px,
 *  or null before the first move). */
export function drawPolygonDraft(
  canvas: HTMLCanvasElement,
  view: RegionView,
  xs: readonly number[],
  ys: readonly number[],
  cursor: [number, number] | null,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx || xs.length === 0) return;
  const project = screenMap(view);
  const pts = xs.map((x, i): [number, number] => project(x, ys[i]));
  ctx.save();
  ctx.strokeStyle = "#00ff00";
  ctx.fillStyle = "#00ff00";
  ctx.lineWidth = 1.5 * view.dpr;
  if (pts.length > 1) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }
  if (cursor) {
    const [cx, cy] = project(cursor[0], cursor[1]);
    ctx.setLineDash([4 * view.dpr, 3 * view.dpr]);
    ctx.beginPath();
    ctx.moveTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.lineTo(cx, cy);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const r = 3 * view.dpr;
  for (const [x, y] of pts) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Small filled squares at the bbox corners marking the selected region. */
function drawHandles(
  ctx: CanvasRenderingContext2D,
  bbox: [number, number, number, number],
  dpr: number,
): void {
  const s = 3 * dpr;
  const corners: [number, number][] = [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[0], bbox[3]],
    [bbox[2], bbox[3]],
  ];
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = dpr;
  for (const [hx, hy] of corners) {
    ctx.fillRect(hx - s, hy - s, 2 * s, 2 * s);
    ctx.strokeRect(hx - s, hy - s, 2 * s, 2 * s);
  }
  ctx.restore();
}

/** Topmost region whose outline/interior is within `tol` device px of the
 *  screen point (mx, my), or -1. Iterates back-to-front (last drawn wins). */
export function hitTestRegion(
  regions: readonly PixelRegion[] | null,
  view: RegionView,
  mx: number,
  my: number,
  tol = 6,
): number {
  if (!regions) return -1;
  const project = screenMap(view);
  const slack = tol * view.dpr;
  for (let i = regions.length - 1; i >= 0; i--) {
    if (regionHit(regions[i], view, project, mx, my, slack)) return i;
  }
  return -1;
}

function regionHit(
  reg: PixelRegion,
  view: RegionView,
  project: (px: number, py: number) => [number, number],
  mx: number,
  my: number,
  slack: number,
): boolean {
  const s = view.scale;
  // The view rotation adds to each shape's own angle in screen space (matching
  // the draw path), so undo both when testing axis-aligned shapes.
  const rotDeg = (view.rot * 180) / Math.PI;
  switch (reg.shape) {
    case "circle": {
      const [cx, cy] = project(reg.x, reg.y);
      return Math.hypot(mx - cx, my - cy) <= reg.r * s + slack;
    }
    case "annulus": {
      const [cx, cy] = project(reg.x, reg.y);
      return Math.hypot(mx - cx, my - cy) <= reg.rout * s + slack;
    }
    case "point": {
      const [cx, cy] = project(reg.x, reg.y);
      const r = 5 * view.dpr + slack; // matches the fixed marker size
      return Math.hypot(mx - cx, my - cy) <= r;
    }
    case "ellipse": {
      // Rotate the point into the ellipse's axis-aligned frame (screen
      // rotation is −(angle + view rotation)) and inflate the axes.
      const [cx, cy] = project(reg.x, reg.y);
      const [lx, ly] = toLocal(mx - cx, my - cy, -reg.angle - rotDeg);
      const a = reg.rx * s + slack;
      const b = reg.ry * s + slack;
      return (lx / a) ** 2 + (ly / b) ** 2 <= 1;
    }
    case "box": {
      const [cx, cy] = project(reg.x, reg.y);
      const [lx, ly] = toLocal(mx - cx, my - cy, -reg.angle - rotDeg);
      return Math.abs(lx) <= (reg.w * s) / 2 + slack && Math.abs(ly) <= (reg.h * s) / 2 + slack;
    }
    case "polygon": {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < reg.xs.length; i++) {
        const [x, y] = project(reg.xs[i], reg.ys[i]);
        xs.push(x);
        ys.push(y);
      }
      return pointInPoly(mx, my, xs, ys) || nearPolyEdge(mx, my, xs, ys, slack);
    }
  }
}

/** Rotate a screen-space offset by −deg into a shape's local frame. */
function toLocal(dx: number, dy: number, deg: number): [number, number] {
  const t = (-deg * Math.PI) / 180;
  const c = Math.cos(t);
  const sn = Math.sin(t);
  return [dx * c + dy * sn, -dx * sn + dy * c];
}

function pointInPoly(px: number, py: number, xs: number[], ys: number[]): boolean {
  let inside = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const intersect =
      ys[i] > py !== ys[j] > py &&
      px < ((xs[j] - xs[i]) * (py - ys[i])) / (ys[j] - ys[i]) + xs[i];
    if (intersect) inside = !inside;
  }
  return inside;
}

function nearPolyEdge(px: number, py: number, xs: number[], ys: number[], slack: number): boolean {
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    if (distToSegment(px, py, xs[j], ys[j], xs[i], ys[i]) <= slack) return true;
  }
  return false;
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function drawMarker(
  ctx: CanvasRenderingContext2D,
  kind: string,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  switch (kind) {
    case "circle":
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      break;
    case "box":
      ctx.rect(x - r, y - r, 2 * r, 2 * r);
      break;
    case "diamond":
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    case "cross":
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r);
      ctx.lineTo(x, y + r);
      break;
    case "x":
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x - r, y + r);
      ctx.lineTo(x + r, y - r);
      break;
    default: // "boxcircle" (DS9 default) and anything unrecognized
      ctx.rect(x - r, y - r, 2 * r, 2 * r);
      ctx.arc(x, y, r * 0.6, 0, 2 * Math.PI);
      break;
  }
  ctx.stroke();
}

// ---- region editing (move / resize / create) ----------------------------

/** A draggable handle on the selected region: `role` says what it edits,
 *  `sx`/`sy` are its screen (device px) position, `index` a vertex # for
 *  polygon nodes (−1 otherwise). */
export type HandleRole = "r" | "rin" | "rout" | "rx" | "ry" | "w" | "h" | "rot" | "node";

export interface Handle {
  sx: number;
  sy: number;
  role: HandleRole;
  index: number;
}

/** Image-space unit vectors along a shape's major (ux) and minor (uy) axes
 *  for `angleDeg` (CCW from +x, image y up). */
function axisVectors(angleDeg: number): [[number, number], [number, number]] {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [c, s],
    [-s, c],
  ];
}

function normDeg(a: number): number {
  return ((a % 360) + 360) % 360;
}

/** Handle points (screen space) for the selected region's edit affordances. */
export function handlesFor(reg: PixelRegion, view: RegionView): Handle[] {
  const project = screenMap(view);
  const out: Handle[] = [];
  const add = (ix: number, iy: number, role: HandleRole, index = -1): void => {
    const [x, y] = project(ix, iy);
    out.push({ sx: x, sy: y, role, index });
  };
  // Rotation handle sits ~20 device px beyond the +major-axis end.
  const rotGap = (20 * view.dpr) / view.scale;
  switch (reg.shape) {
    case "circle":
      add(reg.x + reg.r, reg.y, "r");
      break;
    case "annulus":
      add(reg.x + reg.rin, reg.y, "rin");
      add(reg.x + reg.rout, reg.y, "rout");
      break;
    case "ellipse": {
      const [ux, uy] = axisVectors(reg.angle);
      add(reg.x + ux[0] * reg.rx, reg.y + ux[1] * reg.rx, "rx");
      add(reg.x - ux[0] * reg.rx, reg.y - ux[1] * reg.rx, "rx");
      add(reg.x + uy[0] * reg.ry, reg.y + uy[1] * reg.ry, "ry");
      add(reg.x - uy[0] * reg.ry, reg.y - uy[1] * reg.ry, "ry");
      const rr = reg.rx + rotGap;
      add(reg.x + ux[0] * rr, reg.y + ux[1] * rr, "rot");
      break;
    }
    case "box": {
      const [ux, uy] = axisVectors(reg.angle);
      const hw = reg.w / 2;
      const hh = reg.h / 2;
      add(reg.x + ux[0] * hw, reg.y + ux[1] * hw, "w");
      add(reg.x - ux[0] * hw, reg.y - ux[1] * hw, "w");
      add(reg.x + uy[0] * hh, reg.y + uy[1] * hh, "h");
      add(reg.x - uy[0] * hh, reg.y - uy[1] * hh, "h");
      const rr = hw + rotGap;
      add(reg.x + ux[0] * rr, reg.y + ux[1] * rr, "rot");
      break;
    }
    case "polygon":
      for (let i = 0; i < reg.xs.length; i++) add(reg.xs[i], reg.ys[i], "node", i);
      break;
    case "point":
      break;
  }
  return out;
}

/** Nearest handle within `tol` screen px of (mx, my), or null. */
export function hitTestHandle(
  reg: PixelRegion,
  view: RegionView,
  mx: number,
  my: number,
  tol = 7,
): Handle | null {
  let best: Handle | null = null;
  let bestD = tol * view.dpr;
  for (const hd of handlesFor(reg, view)) {
    const d = Math.hypot(mx - hd.sx, my - hd.sy);
    if (d <= bestD) {
      bestD = d;
      best = hd;
    }
  }
  return best;
}

function drawEditHandles(
  ctx: CanvasRenderingContext2D,
  reg: PixelRegion,
  view: RegionView,
): void {
  const s = 3 * view.dpr;
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = view.dpr;
  for (const hd of handlesFor(reg, view)) {
    if (hd.role === "rot") {
      ctx.beginPath();
      ctx.arc(hd.sx, hd.sy, s + 0.5 * view.dpr, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(hd.sx - s, hd.sy - s, 2 * s, 2 * s);
      ctx.strokeRect(hd.sx - s, hd.sy - s, 2 * s, 2 * s);
    }
  }
  ctx.restore();
}

/** Move a region by (dx, dy) image pixels, in place. */
export function translateRegion(reg: PixelRegion, dx: number, dy: number): void {
  if (reg.shape === "polygon") {
    for (let i = 0; i < reg.xs.length; i++) {
      reg.xs[i] += dx;
      reg.ys[i] += dy;
    }
  } else {
    reg.x += dx;
    reg.y += dy;
  }
}

/** Apply a handle drag: recompute the region dimension the handle controls
 *  from the current mouse image position (ix, iy). Mutates in place. */
export function resizeRegion(
  reg: PixelRegion,
  role: HandleRole,
  nodeIndex: number,
  ix: number,
  iy: number,
): void {
  switch (reg.shape) {
    case "circle":
      reg.r = Math.max(0.5, Math.hypot(ix - reg.x, iy - reg.y));
      break;
    case "annulus": {
      const d = Math.max(0.5, Math.hypot(ix - reg.x, iy - reg.y));
      if (role === "rin") reg.rin = Math.min(d, reg.rout - 0.5);
      else reg.rout = Math.max(d, reg.rin + 0.5);
      break;
    }
    case "ellipse": {
      const [ux, uy] = axisVectors(reg.angle);
      const dx = ix - reg.x;
      const dy = iy - reg.y;
      if (role === "rx") reg.rx = Math.max(0.5, Math.abs(dx * ux[0] + dy * ux[1]));
      else if (role === "ry") reg.ry = Math.max(0.5, Math.abs(dx * uy[0] + dy * uy[1]));
      else if (role === "rot") reg.angle = normDeg((Math.atan2(dy, dx) * 180) / Math.PI);
      break;
    }
    case "box": {
      const [ux, uy] = axisVectors(reg.angle);
      const dx = ix - reg.x;
      const dy = iy - reg.y;
      if (role === "w") reg.w = Math.max(1, 2 * Math.abs(dx * ux[0] + dy * ux[1]));
      else if (role === "h") reg.h = Math.max(1, 2 * Math.abs(dx * uy[0] + dy * uy[1]));
      else if (role === "rot") reg.angle = normDeg((Math.atan2(dy, dx) * 180) / Math.PI);
      break;
    }
    case "polygon":
      if (role === "node" && nodeIndex >= 0 && nodeIndex < reg.xs.length) {
        reg.xs[nodeIndex] = ix;
        reg.ys[nodeIndex] = iy;
      }
      break;
    case "point":
      break;
  }
}

/** Shapes the create tool can draw. Polygon is click-to-add-vertices
 *  (multi-click draft, see Viewer.polygonDraft) rather than a single drag,
 *  so it's excluded from makeRegion's single-drag construction below. */
export type CreatableShape = "circle" | "annulus" | "ellipse" | "box" | "point" | "polygon";

/** Build a new region from a create-drag: (x0, y0) is the press point,
 *  (x1, y1) the current cursor (both 0-based image px). */
export function makeRegion(
  shape: CreatableShape,
  color: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): PixelRegion {
  const base = { include: true, color, width: null, dash: false, text: null, point: null };
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  switch (shape) {
    case "circle":
      return { ...base, shape: "circle", x: x0, y: y0, r: Math.max(0.5, Math.hypot(x1 - x0, y1 - y0)) };
    case "annulus": {
      const r = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
      return { ...base, shape: "annulus", x: x0, y: y0, rin: r / 2, rout: r };
    }
    case "ellipse":
      return { ...base, shape: "ellipse", x: cx, y: cy, rx: Math.max(0.5, dx / 2), ry: Math.max(0.5, dy / 2), angle: 0 };
    case "box":
      return { ...base, shape: "box", x: cx, y: cy, w: Math.max(1, dx), h: Math.max(1, dy), angle: 0 };
    case "point":
      return { ...base, shape: "point", x: x1, y: y1 };
    case "polygon":
      throw new Error("polygon regions are built via click-to-add vertices, not makeRegion");
  }
}
