// Selected-region properties (issue #7): numeric entry of center / size /
// angle in pixel or sky units, plus color, label, width, dash and exclude.
// Lives in the Region layers panel. With several regions selected it offers
// the style fields (color / width / dash), applied to all of them.
//
// Every commit goes through Viewer.editRegions (one undo step). Fields are
// rebuilt only when the selection, shape, or units change; otherwise values
// update in place, skipping the focused input, so typing never loses focus.

import type { PixelRegion } from "./api";
import type { Viewer } from "./render/viewer";
import type { Wcs } from "./render/wcs";
import { nextPickerSession, toHex } from "./regionpanel";

export interface RegionPropsHost {
  viewer(): Viewer | null;
  wcs(): Wcs | null;
  layerName(id: number | undefined): string;
  /** A property edit landed (refresh the layer list's counts/swatches). */
  edited(): void;
}

type Units = "pixel" | "sky";

interface Field {
  key: string;
  label: string;
  title?: string;
  get(r: PixelRegion): number;
  set(r: PixelRegion, v: number): void;
  digits: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function center(r: PixelRegion): [number, number] {
  if (r.shape === "polygon") {
    const n = r.xs.length || 1;
    return [r.xs.reduce((a, b) => a + b, 0) / n, r.ys.reduce((a, b) => a + b, 0) / n];
  }
  return [r.x, r.y];
}

function moveTo(r: PixelRegion, x: number, y: number): void {
  const [cx, cy] = center(r);
  const dx = x - cx;
  const dy = y - cy;
  if (r.shape === "polygon") {
    for (let i = 0; i < r.xs.length; i++) {
      r.xs[i] += dx;
      r.ys[i] += dy;
    }
  } else {
    r.x = x;
    r.y = y;
  }
}

/** Size fields for a shape, in px or arcsec (`k` = arcsec per px, 1 for px). */
function sizeFields(shape: PixelRegion["shape"], k: number, unit: string): Field[] {
  const f = (key: string, label: string, get: (r: PixelRegion) => number, set: (r: PixelRegion, v: number) => void): Field => ({
    key,
    label: `${label} (${unit})`,
    get: (r) => get(r) * k,
    set: (r, v) => set(r, Math.max(0.01, v / k)),
    digits: unit === "px" ? 2 : 3,
  });
  switch (shape) {
    case "circle":
      return [f("r", "Radius", (r) => (r.shape === "circle" ? r.r : 0), (r, v) => { if (r.shape === "circle") r.r = v; })];
    case "annulus":
      return [
        f("rin", "Inner r", (r) => (r.shape === "annulus" ? r.rin : 0), (r, v) => { if (r.shape === "annulus") r.rin = Math.min(v, r.rout); }),
        f("rout", "Outer r", (r) => (r.shape === "annulus" ? r.rout : 0), (r, v) => { if (r.shape === "annulus") r.rout = Math.max(v, r.rin); }),
      ];
    case "ellipse":
      return [
        f("rx", "Semi-major", (r) => (r.shape === "ellipse" ? r.rx : 0), (r, v) => { if (r.shape === "ellipse") r.rx = v; }),
        f("ry", "Semi-minor", (r) => (r.shape === "ellipse" ? r.ry : 0), (r, v) => { if (r.shape === "ellipse") r.ry = v; }),
      ];
    case "box":
      return [
        f("w", "Width", (r) => (r.shape === "box" ? r.w : 0), (r, v) => { if (r.shape === "box") r.w = v; }),
        f("h", "Height", (r) => (r.shape === "box" ? r.h : 0), (r, v) => { if (r.shape === "box") r.h = v; }),
      ];
    default:
      return [];
  }
}

export class RegionProps {
  private readonly root: HTMLElement;
  private readonly host: RegionPropsHost;
  private units: Units = "sky";
  /** Selection/shape/units the current DOM was built for. */
  private builtKey = "";
  /** Value refreshers for the built inputs. */
  private refreshers: (() => void)[] = [];

  constructor(container: HTMLElement, host: RegionPropsHost) {
    this.host = host;
    this.root = el("div", "rp");
    container.append(this.root);
  }

  /** Re-sync with the viewer's current selection (cheap; call freely). */
  sync(): void {
    const v = this.host.viewer();
    const idx = v ? v.selectedIndices() : [];
    const regs = idx.map((i) => v?.regionAt(i)).filter((r): r is PixelRegion => !!r);
    const wcs = this.host.wcs();
    const units: Units = this.units === "sky" && wcs ? "sky" : "pixel";
    const key = regs.length === 0 ? "" : `${idx.join(",")}|${regs.map((r) => r.shape).join(",")}|${units}`;
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.build(v, idx, regs, units, wcs);
    } else {
      for (const f of this.refreshers) f();
    }
  }

  private build(v: Viewer | null, idx: number[], regs: PixelRegion[], units: Units, wcs: Wcs | null): void {
    this.root.replaceChildren();
    this.refreshers = [];
    if (!v || regs.length === 0) {
      this.root.append(el("div", "rp-hint", "Click a region to edit its position, size, color and label."));
      return;
    }
    const head = el("div", "rp-head");
    const first = regs[0];
    head.append(
      el("span", "", regs.length === 1 ? `${first.shape} · ${this.host.layerName(first.layer)}` : `${regs.length} regions selected`),
    );
    if (regs.length === 1) {
      const u = el("select", "control-select");
      for (const name of ["sky", "pixel"] as const) {
        const o = el("option", "", name);
        o.value = name;
        o.disabled = name === "sky" && !wcs;
        u.append(o);
      }
      u.value = units;
      u.title = wcs ? "Units: sky (RA/Dec °, arcsec) or pixel (FITS 1-based, px)" : "No WCS on this image: pixel units only";
      u.addEventListener("change", () => {
        this.units = u.value === "sky" ? "sky" : "pixel";
        this.sync();
      });
      head.append(u);
    }
    this.root.append(head);
    const grid = el("div", "rp-grid");
    this.root.append(grid);

    const commit = (fn: (r: PixelRegion) => void, coalesce: string | null = null): void => {
      v.editRegions(idx, fn, coalesce);
      this.sync();
      this.host.edited();
    };
    const numRow = (fd: Field): void => {
      const inp = el("input", "rp-num");
      inp.type = "text";
      inp.inputMode = "decimal";
      if (fd.title) inp.title = fd.title;
      const refresh = (): void => {
        const r = v.regionAt(idx[0]);
        if (r && document.activeElement !== inp) inp.value = fd.get(r).toFixed(fd.digits);
      };
      refresh();
      inp.addEventListener("change", () => {
        const n = Number(inp.value);
        if (!Number.isFinite(n)) {
          refresh();
          return;
        }
        commit((r) => fd.set(r, n));
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") inp.blur();
        e.stopPropagation(); // keep Delete/Backspace/[ ] etc. away from the app shortcuts
      });
      this.refreshers.push(refresh);
      grid.append(el("label", "rp-label", fd.label), inp);
    };

    if (regs.length === 1) {
      const fields: Field[] = [];
      if (units === "sky" && wcs) {
        // Center in RA/Dec; sizes in arcsec via the mean plate scale.
        const sky = (r: PixelRegion): [number, number] => {
          const [x, y] = center(r);
          return wcs.pixToWorld(x, y);
        };
        const setSky = (r: PixelRegion, ra: number, dec: number): void => {
          const p = wcs.worldToPix(ra, dec);
          if (p) moveTo(r, p[0], p[1]);
        };
        fields.push(
          { key: "ra", label: "RA (°)", digits: 7, get: (r) => sky(r)[0], set: (r, n) => setSky(r, n, sky(r)[1]) },
          { key: "dec", label: "Dec (°)", digits: 7, get: (r) => sky(r)[1], set: (r, n) => setSky(r, sky(r)[0], n) },
          ...sizeFields(first.shape, wcs.pixScale() * 3600, "″"),
        );
      } else {
        fields.push(
          { key: "x", label: "X (px)", title: "FITS 1-based", digits: 2, get: (r) => center(r)[0] + 1, set: (r, n) => moveTo(r, n - 1, center(r)[1]) },
          { key: "y", label: "Y (px)", title: "FITS 1-based", digits: 2, get: (r) => center(r)[1] + 1, set: (r, n) => moveTo(r, center(r)[0], n - 1) },
          ...sizeFields(first.shape, 1, "px"),
        );
      }
      if (first.shape === "ellipse" || first.shape === "box") {
        fields.push({
          key: "angle",
          label: "Angle (°)",
          title: "Counter-clockwise from the image +x axis (as in an image-frame .reg)",
          digits: 2,
          get: (r) => (r.shape === "ellipse" || r.shape === "box" ? r.angle : 0),
          set: (r, n) => {
            if (r.shape === "ellipse" || r.shape === "box") r.angle = ((n % 360) + 360) % 360;
          },
        });
      }
      if (first.shape === "polygon") {
        grid.append(el("span", "rp-label", "Center"), el("span", "rp-dim", "vertex centroid — moves the whole polygon"));
      }
      for (const fd of fields) numRow(fd);

      // Label (DS9 text={…}).
      const text = el("input", "rp-text");
      text.placeholder = "label";
      const refreshText = (): void => {
        const r = v.regionAt(idx[0]);
        if (r && document.activeElement !== text) text.value = r.text ?? "";
      };
      refreshText();
      text.addEventListener("change", () => {
        const t = text.value.trim();
        commit((r) => {
          r.text = t === "" ? null : t;
        });
      });
      text.addEventListener("keydown", (e) => {
        if (e.key === "Enter") text.blur();
        e.stopPropagation();
      });
      this.refreshers.push(refreshText);
      grid.append(el("label", "rp-label", "Label"), text);
    }

    // Style (applies to every selected region).
    const style = el("div", "rp-style");
    const color = el("input", "rl-color");
    color.type = "color";
    const width = el("input", "rp-width");
    width.type = "number";
    width.min = "1";
    width.max = "10";
    width.step = "1";
    width.title = "Line width (px)";
    const dash = el("input");
    dash.type = "checkbox";
    const exclude = el("input");
    exclude.type = "checkbox";
    const refreshStyle = (): void => {
      const r = v.regionAt(idx[0]);
      if (!r) return;
      if (document.activeElement !== color) color.value = toHex(r.color);
      if (document.activeElement !== width) width.value = String(r.width ?? 1);
      dash.checked = r.dash;
      exclude.checked = !r.include;
    };
    refreshStyle();
    color.title = "Region color";
    // Live while the picker is open ("change" alone doesn't fire reliably in
    // WKWebView); one picker session = one undo step.
    let session = nextPickerSession();
    color.addEventListener("click", () => {
      session = nextPickerSession();
    });
    const setColor = (): void => commit((r) => { r.color = color.value; }, `rp-color-${session}`);
    color.addEventListener("input", setColor);
    color.addEventListener("change", () => {
      setColor();
      session = nextPickerSession();
    });
    width.addEventListener("change", () => {
      const w = Math.round(Number(width.value));
      if (Number.isFinite(w) && w >= 1) commit((r) => { r.width = Math.min(10, w); });
    });
    width.addEventListener("keydown", (e) => e.stopPropagation());
    dash.addEventListener("change", () => commit((r) => { r.dash = dash.checked; }));
    exclude.title = "DS9 exclude region (drawn with a slash, saved with a leading −)";
    exclude.addEventListener("change", () => commit((r) => { r.include = !exclude.checked; }));
    const lab = (t: string, input: HTMLElement): HTMLElement => {
      const l = el("label", "rp-inline");
      l.append(input, el("span", "", t));
      return l;
    };
    style.append(color, width, lab("dash", dash), lab("exclude", exclude));
    this.refreshers.push(refreshStyle);
    this.root.append(style);
  }
}
