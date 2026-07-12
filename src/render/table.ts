// Virtualized table viewer (M4): renders a FITS table HDU with click-to-sort
// headers and a single-column filter. Only the visible row window is in the
// DOM — a tall spacer establishes the scroll height, rows are absolutely
// positioned and re-fetched from the backend on scroll (row chunks are cached
// so scrolling back is instant). Sort/filter run in Rust; the frontend only
// asks for the current view's row windows.

import {
  tableColumns,
  tableRows,
  tableView,
  tableViewPos,
  type TableCell,
  type TableColumn,
  type TableFilter,
  type TableSort,
} from "../api";

const ROW_H = 22; // px per row; must match .table-row height in CSS
const CHUNK = 200; // rows fetched per backend request
const OVERSCAN = 8; // extra rows rendered above/below the viewport

export class TableView {
  private readonly root: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly headerRow: HTMLElement;
  private readonly body: HTMLElement;
  private readonly sizer: HTMLElement;
  private readonly filterCol: HTMLSelectElement;
  private readonly filterInput: HTMLInputElement;

  private path = "";
  private hdu = 0;
  private columns: TableColumn[] = [];
  private colWidths: number[] = [];
  private nrows = 0;
  private sort: TableSort | null = null;
  private filter: TableFilter | null = null;
  /** View-position row to highlight (image→row reverse link), -1 = none.
   *  Set by revealRow, which maps a native row to its position in the
   *  current sort/filter view (backend `table_view_pos`) so the highlight
   *  survives an active sort/filter. */
  private highlightRow = -1;

  /** Loaded row chunks, keyed by chunk index (row/CHUNK). */
  private chunks = new Map<number, TableCell[][]>();
  private pending = new Set<number>();
  /** Bumped whenever the view changes; stale fetches are discarded. */
  private generation = 0;
  private scrollQueued = false;
  private filterTimer: ReturnType<typeof setTimeout> | undefined;
  /** Row-click callback (M5 linking): reports a row's cells + columns. */
  private readonly onRowActivate:
    | ((cells: TableCell[], columns: TableColumn[]) => void)
    | undefined;

  constructor(
    container: HTMLElement,
    onRowActivate?: (cells: TableCell[], columns: TableColumn[]) => void,
  ) {
    this.onRowActivate = onRowActivate;
    this.root = document.createElement("div");
    this.root.className = "table-view";

    // Filter controls.
    const bar = document.createElement("div");
    bar.className = "table-bar";
    this.filterCol = document.createElement("select");
    this.filterCol.className = "control-select";
    this.filterInput = document.createElement("input");
    this.filterInput.className = "filter";
    this.filterInput.placeholder = "filter (e.g. text, >5, 1..10)";
    this.filterInput.addEventListener("input", () => this.onFilterInput());
    this.filterCol.addEventListener("change", () => {
      if (this.filterInput.value.trim()) this.onFilterInput();
    });
    this.status = document.createElement("span");
    this.status.className = "table-status";
    bar.append(this.filterCol, this.filterInput, this.status);

    this.scroll = document.createElement("div");
    this.scroll.className = "table-scroll";
    this.inner = document.createElement("div");
    this.inner.className = "table-inner";
    this.headerRow = document.createElement("div");
    this.headerRow.className = "table-header";
    this.sizer = document.createElement("div");
    this.sizer.className = "table-sizer";
    this.body = document.createElement("div");
    this.body.className = "table-body";
    this.sizer.append(this.body);
    this.inner.append(this.headerRow, this.sizer);
    this.scroll.append(this.inner);
    this.scroll.addEventListener("scroll", () => this.queueRender());

    this.root.append(bar, this.scroll);
    container.append(this.root);
  }

  private status: HTMLSpanElement;

  /** Repaint the visible window — call after the pane becomes visible, since
   *  virtualization needs a real clientHeight to know what to render. */
  refresh(): void {
    if (this.columns.length > 0) this.render();
  }

  /** Scroll to and highlight a native table row (image→row reverse link).
   *  Looks up the row's position in the current sort/filter view via the
   *  backend, so an active sort/filter is preserved. Only falls back to
   *  resetting to identity order if the row is filtered out of the current
   *  view (there's no other way to make it visible). */
  async revealRow(nativeRow: number): Promise<void> {
    if (nativeRow < 0 || this.columns.length === 0) return;
    let pos = await tableViewPos(this.path, this.hdu, nativeRow);
    if (pos === null) {
      // Filtered out of the current view — clear sort/filter so the row is
      // guaranteed to show, at the cost of losing the user's view.
      this.sort = null;
      this.filter = null;
      this.filterInput.value = "";
      this.refreshSortIndicators();
      await this.rebuildView(); // rebuilds identity view (clears highlight)
      if (nativeRow >= this.nrows) return;
      pos = nativeRow;
    }
    this.highlightRow = pos;
    // Center the row in the viewport where possible.
    const target = pos * ROW_H - this.scroll.clientHeight / 2 + ROW_H / 2;
    this.scroll.scrollTop = Math.max(0, target);
    this.render();
  }

  /** Remove the reverse-link row highlight. */
  clearHighlight(): void {
    if (this.highlightRow === -1) return;
    this.highlightRow = -1;
    this.render();
  }

  /** Load a table HDU from scratch (columns + first window). */
  async load(path: string, hdu: number): Promise<void> {
    this.path = path;
    this.hdu = hdu;
    this.sort = null;
    this.filter = null;
    this.filterInput.value = "";
    this.columns = await tableColumns(path, hdu);
    this.colWidths = this.columns.map((c) => columnWidth(c));
    this.buildHeader();
    this.buildFilterOptions();
    await this.rebuildView();
  }

  /** (Re)build the backend view for the current sort/filter, then repaint. */
  private async rebuildView(): Promise<void> {
    this.generation++;
    const gen = this.generation;
    this.chunks.clear();
    this.pending.clear();
    this.highlightRow = -1; // view order changed → old highlight is meaningless
    let nrows: number;
    try {
      nrows = await tableView(this.path, this.hdu, this.sort, this.filter);
    } catch (err) {
      this.status.textContent = `table error: ${String(err)}`;
      return;
    }
    if (gen !== this.generation) return;
    this.nrows = nrows;
    this.sizer.style.height = `${nrows * ROW_H}px`;
    this.updateStatus();
    this.scroll.scrollTop = 0;
    this.render();
  }

  private updateStatus(): void {
    const total = this.nrows.toLocaleString();
    this.status.textContent = this.filter
      ? `${total} rows (filtered)`
      : `${total} rows`;
  }

  private buildFilterOptions(): void {
    this.filterCol.replaceChildren();
    for (const c of this.columns) {
      const opt = document.createElement("option");
      opt.value = String(c.index);
      opt.textContent = c.name;
      this.filterCol.append(opt);
    }
  }

  private onFilterInput(): void {
    clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      const query = this.filterInput.value.trim();
      this.filter = query ? { col: Number(this.filterCol.value), query } : null;
      void this.rebuildView();
    }, 250);
  }

  private buildHeader(): void {
    this.headerRow.replaceChildren();
    const totalW = this.colWidths.reduce((a, b) => a + b, 0);
    // Give the scroll container's direct child a definite width so it reports
    // horizontal overflow (scrollWidth === totalW). Relying on the header/sizer
    // widths + `min-width: max-content` alone left scrollWidth ≈ clientWidth in
    // WKWebView, so the horizontal scrollbar thumb spanned the whole track and
    // the rightmost columns were unreachable.
    this.inner.style.width = `${totalW}px`;
    this.headerRow.style.width = `${totalW}px`;
    this.sizer.style.width = `${totalW}px`;
    for (const c of this.columns) {
      const cell = document.createElement("div");
      cell.className = "th";
      cell.style.width = `${this.colWidths[c.index]}px`;
      if (c.kind === "int" || c.kind === "float") cell.classList.add("num");
      const label = document.createElement("span");
      label.className = "th-name";
      label.textContent = c.name;
      cell.append(label);
      if (c.unit) {
        const unit = document.createElement("span");
        unit.className = "th-unit";
        unit.textContent = c.unit;
        cell.append(unit);
      }
      const arrow = document.createElement("span");
      arrow.className = "th-sort";
      cell.append(arrow);
      if (c.sortable) {
        cell.classList.add("sortable");
        cell.addEventListener("click", () => this.onHeaderClick(c.index));
      }
      this.headerRow.append(cell);
    }
    this.refreshSortIndicators();
  }

  /** Cycle a column's sort: none → asc → desc → none. */
  private onHeaderClick(col: number): void {
    if (!this.sort || this.sort.col !== col) {
      this.sort = { col, desc: false };
    } else if (!this.sort.desc) {
      this.sort = { col, desc: true };
    } else {
      this.sort = null;
    }
    this.refreshSortIndicators();
    void this.rebuildView();
  }

  private refreshSortIndicators(): void {
    const cells = this.headerRow.querySelectorAll(".th");
    this.columns.forEach((c, i) => {
      const arrow = cells[i]?.querySelector(".th-sort");
      if (!arrow) return;
      arrow.textContent =
        this.sort && this.sort.col === c.index ? (this.sort.desc ? " ▼" : " ▲") : "";
    });
  }

  private queueRender(): void {
    if (this.scrollQueued) return;
    this.scrollQueued = true;
    requestAnimationFrame(() => {
      this.scrollQueued = false;
      this.render();
    });
  }

  /** Render the visible window from cached chunks, fetching any missing. */
  private render(): void {
    if (this.nrows === 0) {
      this.body.replaceChildren();
      return;
    }
    const top = this.scroll.scrollTop;
    const viewH = this.scroll.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(this.nrows - 1, Math.ceil((top + viewH) / ROW_H) + OVERSCAN);

    // Fetch any chunks covering the visible range that aren't loaded yet.
    for (let ci = Math.floor(first / CHUNK); ci <= Math.floor(last / CHUNK); ci++) {
      if (!this.chunks.has(ci) && !this.pending.has(ci)) void this.fetchChunk(ci);
    }

    const frag = document.createDocumentFragment();
    for (let r = first; r <= last; r++) {
      frag.append(this.rowEl(r));
    }
    this.body.replaceChildren(frag);
  }

  private async fetchChunk(ci: number): Promise<void> {
    this.pending.add(ci);
    const gen = this.generation;
    try {
      const page = await tableRows(this.path, this.hdu, ci * CHUNK, CHUNK);
      if (gen !== this.generation) return;
      this.chunks.set(ci, page.rows);
      this.pending.delete(ci);
      this.queueRender();
    } catch {
      this.pending.delete(ci);
    }
  }

  private rowEl(r: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "table-row";
    row.style.transform = `translateY(${r * ROW_H}px)`;
    if (r % 2 === 1) row.classList.add("odd");
    if (r === this.highlightRow) row.classList.add("highlight");
    const chunk = this.chunks.get(Math.floor(r / CHUNK));
    const cells = chunk?.[r % CHUNK];
    if (cells && this.onRowActivate) {
      row.classList.add("clickable");
      row.addEventListener("click", () => this.onRowActivate?.(cells, this.columns));
    }
    for (const c of this.columns) {
      const cell = document.createElement("div");
      cell.className = "td";
      cell.style.width = `${this.colWidths[c.index]}px`;
      if (c.kind === "int" || c.kind === "float") cell.classList.add("num");
      if (cells) {
        const v = cells[c.index];
        if (v === null) {
          cell.classList.add("null");
        } else {
          cell.textContent = formatCell(v);
        }
      } else {
        cell.classList.add("loading");
      }
      row.append(cell);
    }
    return row;
  }
}

function columnWidth(c: TableColumn): number {
  const base = c.name.length * 8 + 28;
  if (c.kind === "float") return Math.min(180, Math.max(110, base));
  if (c.kind === "int") return Math.min(140, Math.max(80, base));
  // Text/other: scale a bit with the declared repeat (string length).
  const byLen = c.repeat * 8 + 24;
  return Math.min(280, Math.max(90, Math.max(base, byLen)));
}

function formatCell(v: TableCell): string {
  if (typeof v === "boolean") return v ? "T" : "F";
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e6 || a < 1e-4)) return v.toExponential(5);
    // Trim trailing zeros from a fixed rendering.
    return v.toFixed(6).replace(/\.?0+$/, "");
  }
  return "";
}
