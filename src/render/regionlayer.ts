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
}

const DEFAULT_COLOR = "#00ff00"; // DS9 default green; .reg names are CSS-valid

export function drawRegions(
  canvas: HTMLCanvasElement,
  regions: readonly PixelRegion[] | null,
  view: RegionView,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, view.width, view.height);
  if (!regions || regions.length === 0) return;

  // Image pixel center (0-based coord p) → device-pixel screen position.
  const sx = (px: number): number => view.width / 2 + (px + 0.5 - view.cx) * view.scale;
  const sy = (py: number): number => view.height / 2 - (py + 0.5 - view.cy) * view.scale;

  for (const reg of regions) {
    ctx.strokeStyle = ctx.fillStyle = reg.color ?? DEFAULT_COLOR;
    ctx.lineWidth = Math.max(1, (reg.width ?? 1) * view.dpr);
    ctx.setLineDash(reg.dash ? [6 * view.dpr, 4 * view.dpr] : []);

    // Screen-space bounding box, for the exclusion slash and text anchor.
    let bbox: [number, number, number, number] | null = null;

    switch (reg.shape) {
      case "circle": {
        const [x, y, r] = [sx(reg.x), sy(reg.y), reg.r * view.scale];
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.stroke();
        bbox = [x - r, y - r, x + r, y + r];
        break;
      }
      case "ellipse": {
        const [x, y] = [sx(reg.x), sy(reg.y)];
        ctx.beginPath();
        // Image-space angle is CCW with y up; canvas y grows down.
        ctx.ellipse(
          x,
          y,
          reg.rx * view.scale,
          reg.ry * view.scale,
          (-reg.angle * Math.PI) / 180,
          0,
          2 * Math.PI,
        );
        ctx.stroke();
        const e = Math.max(reg.rx, reg.ry) * view.scale;
        bbox = [x - e, y - e, x + e, y + e];
        break;
      }
      case "box": {
        const [x, y] = [sx(reg.x), sy(reg.y)];
        const [w, h] = [reg.w * view.scale, reg.h * view.scale];
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate((-reg.angle * Math.PI) / 180);
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
          const [x, y] = [sx(reg.xs[i]), sy(reg.ys[i])];
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
        const [x, y] = [sx(reg.x), sy(reg.y)];
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
  }
  ctx.setLineDash([]);
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
