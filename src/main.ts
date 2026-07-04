import {
  getHeader,
  onOpenRequest,
  openFits,
  pickFitsFile,
  takePendingOpens,
  type CardValue,
  type FileSummary,
  type HduInfo,
  type HeaderCard,
} from "./api";

interface AppState {
  file: FileSummary | null;
  selectedHdu: number;
  cards: HeaderCard[];
  filter: string;
}

const state: AppState = { file: null, selectedHdu: 0, cards: [], filter: "" };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function kindLabel(hdu: HduInfo): string {
  switch (hdu.kind) {
    case "image":
      return hdu.shape.length === 0 ? "empty" : "image";
    case "bin_table":
      return "table";
    case "ascii_table":
      return "ascii table";
    default:
      return "unknown";
  }
}

function hduDetail(hdu: HduInfo): string {
  if (hdu.kind === "bin_table" || hdu.kind === "ascii_table") {
    const rows = hdu.nrows ?? 0;
    const cols = hdu.ncols ?? 0;
    return `${rows.toLocaleString()} rows × ${cols} cols`;
  }
  if (hdu.shape.length === 0) return "no data";
  return `${hdu.shape.join(" × ")}  (BITPIX ${hdu.bitpix})`;
}

function valueText(v: CardValue | null): string {
  if (v === null) return "";
  switch (v.type) {
    case "Str":
      return v.value;
    case "Logical":
      return v.value ? "T" : "F";
    case "Int":
      return String(v.value);
    case "Float":
      return String(v.value);
    case "Undefined":
      return "";
    case "Raw":
      return v.value;
  }
}

function renderHduList(): void {
  const list = must<HTMLElement>("hdu-list");
  list.replaceChildren();
  if (!state.file) return;
  for (const hdu of state.file.hdus) {
    const item = el("button", "hdu-item");
    if (hdu.index === state.selectedHdu) item.classList.add("selected");
    const title = hdu.name
      ? `${hdu.index}: ${hdu.name}`
      : `${hdu.index}: ${hdu.index === 0 ? "PRIMARY" : "(unnamed)"}`;
    item.append(
      el("div", "hdu-title", title),
      el("div", "hdu-kind", kindLabel(hdu)),
      el("div", "hdu-detail", hduDetail(hdu)),
    );
    item.addEventListener("click", () => void selectHdu(hdu.index));
    list.append(item);
  }
}

function renderCards(): void {
  const tbody = must<HTMLTableSectionElement>("card-body");
  tbody.replaceChildren();
  const needle = state.filter.toLowerCase();
  for (const card of state.cards) {
    if (
      needle &&
      !card.key.toLowerCase().includes(needle) &&
      !valueText(card.value).toLowerCase().includes(needle) &&
      !(card.comment ?? "").toLowerCase().includes(needle)
    ) {
      continue;
    }
    const tr = el("tr");
    tr.append(
      el("td", "card-key", card.key),
      el("td", "card-value", valueText(card.value)),
      el("td", "card-comment", card.comment ?? ""),
    );
    tbody.append(tr);
  }
}

function renderStatus(): void {
  const status = must<HTMLElement>("status");
  if (!state.file) {
    status.textContent = "No file open";
    return;
  }
  const f = state.file;
  const plural = f.hdus.length === 1 ? "" : "s";
  status.textContent = `${f.path} — ${formatBytes(f.size)} — ${f.hdus.length} HDU${plural} — opened in ${f.open_ms.toFixed(1)} ms`;
}

async function selectHdu(index: number): Promise<void> {
  if (!state.file) return;
  state.selectedHdu = index;
  state.cards = await getHeader(state.file.path, index);
  renderHduList();
  renderCards();
}

async function openPath(path: string): Promise<void> {
  const status = must<HTMLElement>("status");
  try {
    status.textContent = `Opening ${path}…`;
    state.file = await openFits(path);
    state.selectedHdu = 0;
    must<HTMLElement>("empty-state").style.display = "none";
    must<HTMLElement>("content").style.display = "";
    renderStatus();
    await selectHdu(0);
  } catch (err) {
    state.file = null;
    status.textContent = `Failed to open ${path}: ${String(err)}`;
  }
}

async function openViaDialog(): Promise<void> {
  const path = await pickFitsFile();
  if (path) await openPath(path);
}

function buildUi(): void {
  const root = must<HTMLElement>("app");
  root.replaceChildren();

  const toolbar = el("header", "toolbar");
  const title = el("span", "app-title", "DS10");
  const openBtn = el("button", "open-btn", "Open…");
  openBtn.addEventListener("click", () => void openViaDialog());
  const filter = el("input", "filter");
  filter.placeholder = "Filter header cards…";
  filter.addEventListener("input", () => {
    state.filter = filter.value;
    renderCards();
  });
  toolbar.append(title, openBtn, filter);

  const content = el("div", "content");
  content.id = "content";
  content.style.display = "none";

  const sidebar = el("aside", "sidebar");
  const sidebarHead = el("div", "sidebar-head", "HDUs");
  const hduList = el("div", "hdu-list");
  hduList.id = "hdu-list";
  sidebar.append(sidebarHead, hduList);

  const main = el("main", "main");
  const table = el("table", "cards");
  const thead = el("thead");
  const headRow = el("tr");
  headRow.append(el("th", "", "Keyword"), el("th", "", "Value"), el("th", "", "Comment"));
  thead.append(headRow);
  const tbody = el("tbody");
  tbody.id = "card-body";
  table.append(thead, tbody);
  main.append(table);
  content.append(sidebar, main);

  const empty = el("div", "empty-state");
  empty.id = "empty-state";
  empty.append(
    el("div", "empty-title", "No file open"),
    el("div", "empty-hint", "Press ⌘O, click Open…, or double-click a .fits file in Finder"),
  );

  const status = el("footer", "status");
  status.id = "status";
  status.textContent = "No file open";

  root.append(toolbar, empty, content, status);

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void openViaDialog();
    }
  });
}

async function init(): Promise<void> {
  buildUi();
  // Live open requests (double-click while the app is already running).
  await onOpenRequest((path) => void openPath(path));
  // Files that arrived before this listener existed (launched by double-click).
  const pending = await takePendingOpens();
  const last = pending.at(-1);
  if (last) await openPath(last);
}

window.addEventListener("DOMContentLoaded", () => void init());
