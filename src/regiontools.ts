// Region tool bar (issue #20): a slim vertical palette floating on the left
// edge of the image. Top to bottom: load .reg / Layers panel; pan / select /
// lasso; draw tools (one per shape); undo / redo / delete.
//
// Pure DOM; main.ts owns the state and passes intents through the host.

import type { CreatableShape } from "./render/regionlayer";
import type { RegionTool } from "./render/viewer";

export interface RegionToolsHost {
  load(): void;
  toggleLayers(): void;
  setTool(tool: RegionTool, shape: CreatableShape | null): void;
  undo(): void;
  redo(): void;
  deleteSelected(): void;
}

/** 18×18 stroke icons (currentColor). */
const ICONS: Record<string, string> = {
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

export class RegionTools {
  readonly root: HTMLElement;
  private readonly toolBtns = new Map<string, HTMLButtonElement>();
  private readonly layersBtn: HTMLButtonElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly deleteBtn: HTMLButtonElement;

  constructor(host: RegionToolsHost) {
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
    const tool = (key: string, name: string, tip: string, t: RegionTool, shape: CreatableShape | null): void => {
      const b = btn(name, tip, () => host.setTool(t, shape));
      this.toolBtns.set(key, b);
      this.root.append(b);
    };

    this.root.append(
      btn("load", "Load DS9 region files (.reg) as new layers (several at once is fine)", () => host.load()),
    );
    this.layersBtn = btn("layers", "Region layers panel: show/hide, recolor, save, close; selected-region properties", () =>
      host.toggleLayers(),
    );
    this.root.append(this.layersBtn, sep());
    tool("pan", "pan", "Pan (default): drag pans, click selects a region. No editing.", "pan", null);
    tool("select", "select", "Select: drag empty space to select every region it touches." + EDIT_TIP, "select", null);
    tool("lasso", "lasso", "Lasso: draw a loop to select every region it touches." + EDIT_TIP, "lasso", null);
    this.root.append(sep());
    for (const { shape, tip } of SHAPES) tool(shape, shape, tip + EDIT_TIP, "draw", shape);
    this.root.append(sep());
    this.undoBtn = btn("undo", "Undo region edit (⌘Z)", () => host.undo());
    this.redoBtn = btn("redo", "Redo region edit (⌘⇧Z)", () => host.redo());
    this.deleteBtn = btn("delete", "Delete the selected region(s) (Delete)", () => host.deleteSelected());
    this.root.append(this.undoBtn, this.redoBtn, this.deleteBtn);
  }

  /** Reflect the current tool + panel/undo state. */
  sync(state: {
    tool: RegionTool;
    shape: CreatableShape;
    layersOpen: boolean;
    canUndo: boolean;
    canRedo: boolean;
    hasSelection: boolean;
  }): void {
    const key = state.tool === "draw" ? state.shape : state.tool;
    for (const [k, b] of this.toolBtns) b.classList.toggle("on", k === key);
    this.layersBtn.classList.toggle("on", state.layersOpen);
    this.undoBtn.disabled = !state.canUndo;
    this.redoBtn.disabled = !state.canRedo;
    this.deleteBtn.disabled = !state.hasSelection;
  }
}
