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
  /** Parser warnings from the last load (unsupported shapes etc.). */
  warnings: string[];
}

let nextLayerId = 1;

export function newLayer(name: string, path: string | null): RegionLayer {
  return { id: nextLayerId++, name, path, visible: true, warnings: [] };
}

export interface RegionPanelHost {
  /** Region count per layer id (from the viewer). */
  counts(): Map<number, number>;
  /** Each layer's region color (shared, or the first one + `mixed`). */
  colors(): Map<number, { color: string; mixed: boolean }>;
  toggleVisible(id: number): void;
  setActive(id: number): void;
  /** Recolor every region of a layer (one undo step per picker session,
   *  identified by `session`). */
  setColor(id: number, color: string, session: number): void;
  save(id: number): void;
  /** Other open image frames a layer can be copied onto. */
  copyTargets(): { key: number; name: string }[];
  /** Copy a layer onto those frames (sky-matched when both have a WCS). */
  copyTo(id: number, targets: number[]): void;
  close(id: number): void;
  load(): void;
  newLayer(): void;
  showAll(visible: boolean): void;
}

/** Any CSS color (DS9 names like "green", "cyan") → #rrggbb for <input type=color>. */
export function toHex(color: string | null): string {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return "#00ff00";
  ctx.fillStyle = "#00ff00";
  ctx.fillStyle = color ?? "#00ff00";
  const v = ctx.fillStyle;
  return v.startsWith("#") ? v : "#00ff00";
}

let pickerSession = 0;
/** A new id each time a color picker is opened/committed, so one drag through
 *  the picker coalesces into one undo step. */
export function nextPickerSession(): number {
  return ++pickerSession;
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
  const colors = host.colors();
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
    const lc = colors.get(l.id);
    color.value = toHex(lc?.color ?? "#00ff00");
    color.classList.toggle("mixed", lc?.mixed ?? false);
    color.disabled = !lc;
    color.title = lc?.mixed
      ? "Regions have mixed colors — pick one to recolor the whole layer (⌘Z undoes)"
      : "Recolor every region in this layer (⌘Z undoes)";
    let session = nextPickerSession();
    color.addEventListener("click", () => {
      session = nextPickerSession();
    });
    color.addEventListener("input", () => {
      color.classList.remove("mixed");
      host.setColor(l.id, color.value, session);
    });
    color.addEventListener("change", () => {
      host.setColor(l.id, color.value, session);
      session = nextPickerSession();
    });

    const copy = el("button", "rl-btn", "⧉");
    copy.title = "Copy this layer onto other open images (matched on the sky when both have a WCS)";
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      openCopyMenu(copy, l.id, host);
    });

    const save = el("button", "rl-btn", "Save");
    save.title = "Save this layer as a .reg file (frame from the selector below)";
    save.addEventListener("click", () => host.save(l.id));
    const close = el("button", "rl-btn", "×");
    close.title = "Remove this layer (unsaved edits are lost)";
    close.addEventListener("click", () => host.close(l.id));

    row.append(vis, act, name, color, copy, save, close);
    root.append(row);
  }
}

/** Small popup under a layer's ⧉ button: one entry per other image frame,
 *  plus "All images". Closes on pick or outside click. */
function openCopyMenu(anchor: HTMLElement, id: number, host: RegionPanelHost): void {
  document.querySelector(".rl-copy-menu")?.remove();
  const targets = host.copyTargets();
  const menu = el("div", "rl-copy-menu");
  const head = el("div", "rl-copy-head", "Copy layer to");
  menu.append(head);
  if (targets.length === 0) {
    menu.append(el("div", "rl-dim", "no other image frames open"));
  } else {
    const item = (label: string, keys: number[]): void => {
      const b = el("button", "rl-copy-item", label);
      b.addEventListener("click", () => {
        menu.remove();
        host.copyTo(id, keys);
      });
      menu.append(b);
    };
    for (const t of targets) item(t.name, [t.key]);
    if (targets.length > 1) item(`All ${targets.length} images`, targets.map((t) => t.key));
  }
  const panel = anchor.closest(".region-panel") ?? document.body;
  panel.append(menu);
  const a = anchor.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  menu.style.top = `${a.bottom - p.top + 4}px`;
  menu.style.right = `${p.right - a.right}px`;
  const close = (e: PointerEvent): void => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true));
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
