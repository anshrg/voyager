// Image tool bar (issues #20, #22): a slim vertical palette floating on the
// left edge of the image. Top to bottom:
//   View     fit · grid · blink · lock · RGB…
//   Regions  load .reg · Layers panel · Draw (shapes fly out to the right)
//   Edit     pan · select · lasso · undo · redo · delete — only once the frame
//            has region layers or a draw/select tool is active
//
// Pure DOM; main.ts owns the state and passes intents through the host.

import type { CreatableShape } from "./render/regionlayer";
import type { RegionTool } from "./render/viewer";

export type LockMode = "none" | "wcs" | "pixel";

export interface RegionToolsHost {
  fit(): void;
  grid(): void;
  blink(): void;
  lock(): void;
  rgb(): void;
  load(): void;
  toggleLayers(): void;
  setTool(tool: RegionTool, shape: CreatableShape | null): void;
  undo(): void;
  redo(): void;
  deleteSelected(): void;
}

/** 18×18 stroke icons (currentColor). */
const ICONS: Record<string, string> = {
  fit: '<path d="M2.5 6.5v-4h4M11.5 2.5h4v4M15.5 11.5v4h-4M6.5 15.5h-4v-4"/><rect x="6" y="6" width="6" height="6" rx="1"/>',
  grid: '<rect x="2.5" y="2.5" width="5.5" height="5.5"/><rect x="10" y="2.5" width="5.5" height="5.5"/><rect x="2.5" y="10" width="5.5" height="5.5"/><rect x="10" y="10" width="5.5" height="5.5"/>',
  blink: '<path d="M1.5 9s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="9" cy="9" r="2.2"/>',
  lock: '<rect x="3.5" y="8" width="11" height="8" rx="1.5"/><path d="M6 8V5.5a3 3 0 0 1 6 0V8"/>',
  rgb: '<circle cx="9" cy="6.3" r="3.6"/><circle cx="6.4" cy="10.9" r="3.6"/><circle cx="11.6" cy="10.9" r="3.6"/>',
  load: '<path d="M2 5.5h5l1.5 1.5H16v8.5H2z"/><path d="M9 13V8.5M7 10.5l2-2 2 2"/>',
  layers: '<path d="M9 2.5 16 6l-7 3.5L2 6z"/><path d="M2 9.5 9 13l7-3.5"/><path d="M2 12.5 9 16l7-3.5"/>',
  pan:
    '<path d="M6.5 9V4.5a1.2 1.2 0 0 1 2.4 0V8.5"/><path d="M8.9 8.5V3.5a1.2 1.2 0 0 1 2.4 0v5"/>' +
    '<path d="M11.3 8.5V5a1.2 1.2 0 0 1 2.4 0v6c0 3-2 5-4.6 5S5 14.5 4.2 12.8L2.8 10a1.2 1.2 0 0 1 2-1.2L6.5 11"/>',
  select: '<path d="M4 2.5v12l3.2-3.1 2.2 4.6 2-1-2.2-4.5H14z" stroke-linejoin="round"/>',
  lasso:
    '<path d="M5 12.5C2.6 11.5 2 9.6 2.6 7.8 3.7 4.6 8.2 2.8 12 3.6s4.8 3.8 3 6.2c-1.6 2.1-5.2 3-8.2 2.7" stroke-dasharray="2.2 1.8"/>' +
    '<circle cx="5.6" cy="13.6" r="1.4"/><path d="M5.2 15c-.3 1-.9 1.6-1.8 1.8"/>',
  circle: '<circle cx="9" cy="9" r="6"/>',
  box: '<rect x="3" y="4.5" width="12" height="9"/>',
  ellipse: '<ellipse cx="9" cy="9" rx="7" ry="4" transform="rotate(-25 9 9)"/>',
  annulus: '<circle cx="9" cy="9" r="6.5"/><circle cx="9" cy="9" r="3"/>',
  point: '<path d="M5 5l8 8M13 5l-8 8"/>',
  polygon: '<path d="M9 2.5 15.5 7l-2.5 8h-8L2.5 7z" stroke-linejoin="round"/>',
  undo: '<path d="M6 4 2.5 7.5 6 11"/><path d="M2.5 7.5H11a4.5 4.5 0 0 1 0 9H8"/>',
  redo: '<path d="M12 4l3.5 3.5L12 11"/><path d="M15.5 7.5H7a4.5 4.5 0 0 0 0 9h3"/>',
  delete:
    '<path d="M3 5h12M7 5V3h4v2M4.5 5l.8 10.5h7.4L13.5 5"/><path d="M7.5 8v5M10.5 8v5"/>',
};

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.innerHTML = ICONS[name] ?? "";
  return svg;
}

const SHAPES: { shape: CreatableShape; tip: string }[] = [
  { shape: "circle", tip: "Draw circles: drag from the center outwards" },
  { shape: "box", tip: "Draw boxes: drag corner to corner" },
  { shape: "ellipse", tip: "Draw ellipses: drag out the bounding box" },
  { shape: "annulus", tip: "Draw annuli: drag from the center outwards" },
  { shape: "point", tip: "Draw points: click" },
  {
    shape: "polygon",
    tip: "Draw polygons: click to add vertices; close by clicking the first vertex, double-clicking, or Enter",
  },
];

/** Shared behavior of the editing tools, appended to their tooltips. */
const EDIT_TIP =
  "\n\nClick a region to select it; drag its body to move, its handles to resize/rotate. " +
  "Several selected: drag the box corners to scale, the knob to rotate. " +
  "Selected polygon: double-click an edge to add a vertex, a vertex to remove it. " +
  "Shift-drag: add to the selection · ⌥-drag or right-drag: pan · Delete removes · ⌘Z/⌘⇧Z undo/redo.";

export interface RegionToolsState {
  tool: RegionTool;
  shape: CreatableShape;
  layersOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  /** The frame has region layers (shows the edit section). */
  hasLayers: boolean;
}

export class RegionTools {
  readonly root: HTMLElement;
  private readonly toolBtns = new Map<string, HTMLButtonElement>();
  private readonly gridBtn: HTMLButtonElement;
  private readonly blinkBtn: HTMLButtonElement;
  private readonly lockBtn: HTMLButtonElement;
  private readonly lockBadge: HTMLElement;
  private readonly layersBtn: HTMLButtonElement;
  private readonly drawBtn: HTMLButtonElement;
  private readonly flyout: HTMLElement;
  private readonly editSection: HTMLElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly deleteBtn: HTMLButtonElement;
  private readonly host: RegionToolsHost;
  private state: RegionToolsState | null = null;

  constructor(host: RegionToolsHost) {
    this.host = host;
    this.root = document.createElement("div");
    this.root.className = "region-tools";
    const btn = (name: string, tip: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "rt-btn";
      b.title = tip;
      b.append(icon(name));
      b.addEventListener("click", onClick);
      // Keep keyboard focus on the image so shortcuts (⌘Z, Delete) stay live.
      b.addEventListener("mousedown", (e) => e.preventDefault());
      return b;
    };
    const sep = (): HTMLElement => {
      const d = document.createElement("div");
      d.className = "rt-sep";
      return d;
    };

    // View.
    this.gridBtn = btn("grid", "Grid: tile all image frames (g)", () => host.grid());
    this.blinkBtn = btn("blink", "Blink: cycle through the image frames (b)", () => host.blink());
    this.lockBtn = btn("lock", "Lock pan/zoom across frames (click cycles: off → WCS/sky → pixel)", () => host.lock());
    this.lockBadge = document.createElement("span");
    this.lockBadge.className = "rt-badge";
    this.lockBtn.append(this.lockBadge);
    this.root.append(
      btn("fit", "Fit the image to the window (double-click the image also fits)", () => host.fit()),
      this.gridBtn,
      this.blinkBtn,
      this.lockBtn,
      btn("rgb", "RGB composite (trilogy or 3-color) from open frames on the same pixel grid", () => host.rgb()),
      sep(),
    );

    // Regions: load, layers, draw (+ shape flyout).
    this.layersBtn = btn("layers", "Region layers panel: show/hide, recolor, save, close; selected-region properties", () =>
      host.toggleLayers(),
    );
    this.drawBtn = btn("circle", "", () => this.onDraw());
    this.drawBtn.classList.add("rt-has-flyout");
    this.flyout = document.createElement("div");
    this.flyout.className = "rt-flyout";
    this.flyout.style.display = "none";
    for (const { shape, tip } of SHAPES) {
      const b = btn(shape, tip, () => {
        this.closeFlyout();
        host.setTool("draw", shape);
      });
      this.toolBtns.set(shape, b);
      this.flyout.append(b);
    }
    const drawWrap = document.createElement("div");
    drawWrap.className = "rt-draw";
    drawWrap.append(this.drawBtn, this.flyout);
    document.addEventListener("pointerdown", (e) => {
      if (this.flyout.style.display !== "none" && !drawWrap.contains(e.target as Node)) this.closeFlyout();
    });
    this.root.append(
      btn("load", "Load DS9 region files (.reg) as new layers (several at once is fine)", () => host.load()),
      this.layersBtn,
      drawWrap,
    );

    // Edit (only with layers / an active editing tool).
    this.editSection = document.createElement("div");
    this.editSection.className = "rt-section";
    const tool = (key: string, tip: string, t: RegionTool): void => {
      const b = btn(key, tip, () => host.setTool(t, null));
      this.toolBtns.set(key, b);
      this.editSection.append(b);
    };
    this.editSection.append(sep());
    tool("pan", "Pan (default): drag pans, click selects a region. No editing.", "pan");
    tool("select", "Select: drag empty space to select every region it touches." + EDIT_TIP, "select");
    tool("lasso", "Lasso: draw a loop to select every region it touches." + EDIT_TIP, "lasso");
    this.undoBtn = btn("undo", "Undo region edit (⌘Z)", () => host.undo());
    this.redoBtn = btn("redo", "Redo region edit (⌘⇧Z)", () => host.redo());
    this.deleteBtn = btn("delete", "Delete the selected region(s) (Delete)", () => host.deleteSelected());
    this.editSection.append(sep(), this.undoBtn, this.redoBtn, this.deleteBtn);
    this.root.append(this.editSection);
  }

  /** Draw button: activate drawing with the last shape and open the shape
   *  flyout (a second click closes it). */
  private onDraw(): void {
    if (this.flyout.style.display !== "none") {
      this.closeFlyout();
      return;
    }
    const shape = this.state?.shape ?? "circle";
    if (this.state?.tool !== "draw") this.host.setTool("draw", shape);
    this.flyout.style.display = "";
  }

  private closeFlyout(): void {
    this.flyout.style.display = "none";
  }

  /** Reflect the multi-frame view toggles. */
  syncView(v: { grid: boolean; blink: boolean; lock: LockMode; multi: boolean }): void {
    this.gridBtn.classList.toggle("on", v.grid);
    this.blinkBtn.classList.toggle("on", v.blink);
    this.lockBtn.classList.toggle("on", v.lock !== "none");
    this.lockBadge.textContent = v.lock === "wcs" ? "sky" : v.lock === "pixel" ? "px" : "";
    for (const b of [this.gridBtn, this.blinkBtn, this.lockBtn]) b.disabled = !v.multi;
  }

  /** Reflect the current tool + panel/undo state. */
  sync(state: RegionToolsState): void {
    this.state = state;
    const key = state.tool === "draw" ? state.shape : state.tool;
    for (const [k, b] of this.toolBtns) b.classList.toggle("on", k === key);
    // The Draw button wears the current shape's icon.
    this.drawBtn.replaceChildren(icon(state.shape));
    this.drawBtn.classList.toggle("on", state.tool === "draw");
    this.drawBtn.title =
      `Draw ${state.shape}s (click to pick another shape).` + EDIT_TIP;
    this.layersBtn.classList.toggle("on", state.layersOpen);
    this.editSection.style.display = state.hasLayers || state.tool !== "pan" ? "" : "none";
    this.undoBtn.disabled = !state.canUndo;
    this.redoBtn.disabled = !state.canRedo;
    this.deleteBtn.disabled = !state.hasSelection;
  }
}
