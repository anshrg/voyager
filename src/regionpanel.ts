// Region layer manager (issue #18): several DS9 region files on one image.
// A floating panel over the image lists the active frame's layers — each a
// loaded .reg file or an "untitled" layer drawn from scratch — with
// visibility, active (draw-into) marker, color override, save and close.
//
// State lives on the frame (main.ts owns it); this module renders the panel
// and reports user intents through a host interface.

/** One region layer of a frame. Regions themselves live in the frame's
 *  Viewer, tagged with `layer = id`. */
export interface RegionLayer {
  id: number;
  /** File name, or "untitled N". */
  name: string;
  /** Source/last-saved .reg path; null = drawn in Voyager, never saved. */
  path: string | null;
  visible: boolean;
  /** Color override for every region in the layer (null = file's colors). */
  color: string | null;
  /** Parser warnings from the last load (unsupported shapes etc.). */
  warnings: string[];
}

let nextLayerId = 1;

export function newLayer(name: string, path: string | null): RegionLayer {
  return { id: nextLayerId++, name, path, visible: true, color: null, warnings: [] };
}

export interface RegionPanelHost {
  /** Region count per layer id (from the viewer). */
  counts(): Map<number, number>;
  toggleVisible(id: number): void;
  setActive(id: number): void;
  setColor(id: number, color: string | null): void;
  save(id: number): void;
  close(id: number): void;
  load(): void;
  newLayer(): void;
  showAll(visible: boolean): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Render the layer list into `root` (the panel's body). */
export function renderRegionLayers(
  root: HTMLElement,
  layers: readonly RegionLayer[],
  active: number | null,
  host: RegionPanelHost,
): void {
  root.replaceChildren();
  const counts = host.counts();
  if (layers.length === 0) {
    root.append(el("div", "rl-empty", "No region layers. Load a .reg file, or turn on Edit and draw."));
  }
  for (const l of layers) {
    const row = el("div", "rl-row");
    if (!l.visible) row.classList.add("off");
    if (l.id === active) row.classList.add("active");

    const vis = el("input");
    vis.type = "checkbox";
    vis.checked = l.visible;
    vis.title = l.visible ? "Hide this layer" : "Show this layer";
    vis.addEventListener("change", () => host.toggleVisible(l.id));

    const act = el("input");
    act.type = "radio";
    act.name = "rl-active";
    act.checked = l.id === active;
    act.title = "Active layer: new regions drawn in Edit mode go here";
    act.addEventListener("change", () => host.setActive(l.id));

    const name = el("span", "rl-name");
    name.append(el("span", "rl-name-text", l.name), el("span", "rl-count", ` ${counts.get(l.id) ?? 0}`));
    name.title =
      (l.path ?? "drawn in Voyager — not saved yet") +
      (l.warnings.length > 0 ? `\n\n${l.warnings.length} warning(s):\n${l.warnings.slice(0, 8).join("\n")}` : "");
    if (l.warnings.length > 0) name.append(el("span", "rl-warn", " ⚠"));

    const color = el("input", "rl-color");
    color.type = "color";
    color.value = l.color ?? "#00ff00";
    color.classList.toggle("unset", l.color === null);
    color.title = l.color ? "Layer color override (⌥-click to reset to the file's colors)" : "Override the layer's color";
    color.addEventListener("input", () => host.setColor(l.id, color.value));
    color.addEventListener("click", (e) => {
      if (e.altKey && l.color !== null) {
        e.preventDefault();
        host.setColor(l.id, null);
      }
    });

    const save = el("button", "rl-btn", "Save");
    save.title = "Save this layer as a .reg file (frame from the selector below)";
    save.addEventListener("click", () => host.save(l.id));
    const close = el("button", "rl-btn", "×");
    close.title = "Remove this layer (unsaved edits are lost)";
    close.addEventListener("click", () => host.close(l.id));

    row.append(vis, act, name, color, save, close);
    root.append(row);
  }
}

/** The static panel chrome (title, list body, footer); returns the body to
 *  render layers into plus the save-frame select. */
export function buildRegionPanel(host: RegionPanelHost, onClose: () => void): {
  root: HTMLElement;
  body: HTMLElement;
  frameSelect: HTMLSelectElement;
} {
  const root = el("div", "region-panel");
  root.id = "region-panel";
  root.style.display = "none";
  const title = el("div", "rl-title");
  title.append(el("span", "", "Region layers"));
  const x = el("button", "match-close", "×");
  x.title = "Close panel";
  x.addEventListener("click", onClose);
  title.append(x);
  const body = el("div", "rl-body");
  const foot = el("div", "rl-foot");
  const load = el("button", "", "Load…");
  load.title = "Add one or more .reg files as new layers";
  load.addEventListener("click", () => host.load());
  const add = el("button", "", "New");
  add.title = "New empty layer to draw into";
  add.addEventListener("click", () => host.newLayer());
  const all = el("button", "", "All");
  all.title = "Show all layers";
  all.addEventListener("click", () => host.showAll(true));
  const none = el("button", "", "None");
  none.title = "Hide all layers";
  none.addEventListener("click", () => host.showAll(false));
  const frameSelect = el("select", "control-select");
  for (const f of ["image", "sky"]) {
    const o = el("option", "", f);
    o.value = f;
    frameSelect.append(o);
  }
  frameSelect.title = "Coordinate frame for saved layers (sky = icrs via the image WCS, image = pixels)";
  foot.append(load, add, all, none, el("span", "rl-spacer"), el("span", "rl-dim", "save as"), frameSelect);
  root.append(title, body, foot);
  return { root, body, frameSelect };
}
