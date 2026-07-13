# Crossmatch + large-table foundation — agreed design (2026-07-13)

Outcome of a design discussion with the user (no code yet). This is the
blueprint for the next milestone of work: TOPCAT-replacement catalog
crossmatching, gated on fixing large-table sort/filter performance first.
Decisions here were explicitly agreed by the user; implementation sessions
should follow this order and update STATE.md as pieces land.

## Motivating findings

- User stress test: a >1M-row, 11 GB catalog struggled to sort/filter.
  Root cause: `build_view` reads the key column via `cell()` per row →
  demand-faulted, strided mmap access. FITS bintables are row-major and the
  file is ~11 KB/row (> page size), so extracting one column effectively
  reads the whole file — at fault-at-a-time speed (~10–20× below disk
  bandwidth), re-paid on every sort/filter change.
- Everything in `AppState` is keyed by file path → `Arc<FitsFile>`; there is
  no concept of a table not backed by an on-disk FITS file, so a crossmatch
  result has nowhere to live today. There is also no FITS table writer.

## Decision 1: columnar key cache (NOT SQLite/DuckDB conversion)

Rejected: on-the-fly conversion to SQL. It would double I/O and disk before
first interaction (violates "never slurp at open"), and the schema mapping
(vector columns, TSCAL/TZERO, bit fields) is lossy. Everything SQL buys —
sort/filter/join — is only needed on a handful of columns at a time, which
fit trivially in RAM (1M rows × f64 = 8 MB/column).

Design: on first sort/filter/crossmatch touch of a column, extract it once
into a compact typed vector (`Vec<f64>`, interned strings for text), cached
per `(path, hdu, col)` in `AppState` with an LRU byte budget. Sort/filter
then operate on cached keys at memory speed (<100 ms/1M rows target).

**Cold-extraction physics (user flagged, agreed):** row-major layout means
column extraction ≈ full-file scan when rows span ≥ a page (the 11 GB case).
The floor is `file_size / disk_bandwidth` (~2 s on Apple NVMe); the work is
hitting that floor instead of missing it by 10–20×:

1. Chunked reads (pread into a 16–32 MB whole-row buffer, or mmap +
   `madvise(MADV_SEQUENTIAL)`), decode from the buffer — not per-cell faults.
2. Parallel disjoint row-range chunks via rayon (NVMe needs queue depth).
3. Multi-column single-pass API — `extract_columns(&[usize])` — since the
   scan reads whole rows anyway; RA+Dec+ID+sort-key in one sweep. Optionally
   background-prefetch heuristic columns right after a table HDU opens.
4. Specialized per-`Elem` decode loops for the warm path (generic `cell()`
   enum/bounds overhead caps throughput; a tight `from_be_bytes` stride loop
   decodes at GB/s).
5. (Backlog) persistent sidecar column cache keyed by (path, mtime, size).

**Benchmark before/alongside implementation, on the target Mac** (container
numbers are misleading — no page-cache purge, different disk): synthetic 1M-row
narrow (~100 B/row) + wide (~11 KB/row, vector columns) catalogs from the
astropy venv (scratchpad, not committed); cold (`sudo purge`) vs warm; compare
current per-cell loop / madvise / chunked pread ×1 / chunked pread + rayon;
report effective GB/s. Acceptance: warm sort <100 ms/1M rows; cold first-touch
within ~1.5× raw disk bandwidth, shown in the UI as a one-time
"indexing column…" progress state. `[voyager] table_view … ms` logs give
real-file before/after.

## Decision 2: crossmatch = kd-tree on unit vectors + derived tables

**Match core** (pure module, no Tauri types, astropy-fixture-tested):
- RA/Dec via the column cache → 3D unit vectors → kd-tree. Max angular
  distance maps to chord distance `2·sin(θ/2)`, so a Euclidean kd-tree is
  exact on the sphere (no pole/wrap cases) — same approach as astropy, which
  supplies ground truth: `SkyCoord.match_to_catalog_sky` /
  `search_around_sky` expected values via `scripts/gen_fixtures.py`.
- **v1 scope: "Best" match within radius, inner join** (user decision).
  Design the pair-list API so All-matches / 1and2 / 1or2 / 1not2 output
  modes are cheap follow-ups (they're just different consumers of the same
  `(row_a, row_b, sep)` pairs) — parked in BACKLOG.
- All-pairs with large radius can explode; cap + warn rather than OOM.

**Derived tables** (the architectural piece): a match result is tiny —
`(row_a, row_b, separation)` per matched row (~24 B). Generalize the table
source to an enum: `Fits { path, hdu }` | `Derived { left, right, pairs }`.
A derived table answers `cell()` by delegating to its parent FITS tables
through the existing mmap readers (zero data copied); columns from both
catalogs plus a `Separation` column appear seamlessly. Paging, `build_view`,
the frontend `TableView`, overlay/locate all work unchanged once `Table`
sits behind that abstraction — they already go through `cell()`/`page()`.

**Export**: new FITS bintable writer (`table/write.rs`) streams a derived
(or sorted/filtered) table out as a real file. Needed for the export
requirement regardless; bonus: "save filtered subset as FITS".

**Coordinate-column identification**: move detection into Rust as the single
shared source (frontend `RA_NAMES`/`DEC_NAMES` heuristics + `TUNIT`
deg/rad/hourangle + UCDs when present), returning a *guess* that the
crossmatch dialog pre-fills and the user can override (columns + units).
Unit conversion happens at extraction; the index is internally unit-vectors.

**Single-coordinate cone search** ("goto for tables"): one query against the
same index; reuse `resolve_coord` for parsing and `revealRow` to jump. Small
search box on the table tab.

## Build order (each step fixture-testable before any UI)

1. Column cache + fast sort/filter (the prerequisite; benchmark per above).
2. FITS bintable writer + round-trip fixtures.
3. Match core (kd-tree, cone + best-match) + astropy fixtures.
4. Derived-table abstraction + IPC so results load into the existing viewer.
5. UI: crossmatch dialog (two catalogs, detected/overridable coord columns +
   units, max distance) + single-coordinate search box.
