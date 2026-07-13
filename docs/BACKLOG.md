# Voyager Backlog

Parked features and ideas — captured so scope stays disciplined without losing
anything. Promote items into a milestone deliberately, not casually.

## From the original plan (deferred)

- SAMP interop (broadcast/receive tables + sky positions with TOPCAT/Aladin/DS9)
- XPA-style scripting interface
- Plotting beyond a basic histogram (sky plots, column-vs-column scatter)
- Data cubes / 3-D (slice scrubbing, spectra)
- HiPS survey layers
- Windows/Linux packaging
- Object-name resolution via Sesame/SIMBAD in the goto box (needs network)
- Compressed FITS: `.fits.fz` (tile-compressed RICE), `.fits.gz`
- Manual bilinear filtering option in the shader (R32F is NEAREST-only in WebGL2)

## From M1 implementation (parked, not blocking)

- ~~Cancel/debounce tile requests during fast zoom bursts + keep the previous
  level drawn~~ **DONE 2026-07-05**: `viewer.ts draw()` paints all cached
  levels coarse→fine and only requests the backdrop + settled target
  (`ZOOM_SETTLE_MS`). Remaining nicety if ever needed: actually *cancel*
  in-flight stale requests (currently they just complete and get evicted).
- Block-AVERAGE downsampling option (current levels block-sample like DS9's
  default; averaging shows depth better when zoomed out — DS9 has it as an
  option too).
- zscale gather speedup: sampled rows currently fault in every page they
  cross; reading contiguous row chunks (or madvise) could cut the ~750 ms
  cold-start on 5 GiB mosaics further.
- Manual scale limits entry + percentile modes (99%, 99.5%…) next to
  zscale/minmax; histogram-driven limits UI is the M2 item.
- Colormap inversion (contrast/bias dragging was promoted into M2 by user
  request 2026-07-04 — right-drag: horizontal = bias, vertical = contrast).
- Keyboard shortcuts for zoom (+/-/0), stretch cycling, colormap cycling.
- NaN rendering color: currently fixed near-black; consider making it
  configurable (DS9 lets you pick the blank color).
- Full SIP distortion terms in WCS (M2 ignores `-SIP` suffixes; fine for
  drizzled mosaics, wrong by up to ~arcsec on distorted cal frames).
- Readout coordinate display options: decimal degrees toggle, galactic,
  epoch display (currently sexagesimal fk5-style only).
- Goto box: accept pixel coordinates (e.g. "px 512 400") in addition to sky.
- Histogram niceties: axis tick labels, linear/log y toggle, zoom into a
  sub-range, editable numeric limit fields.
- Contrast/bias: match DS9's exact bias/contrast→LUT mapping if the current
  one feels off side-by-side. (2026-07-04 user feedback applied: contrast
  now 5^(1−2y) i.e. ⅕…5×, bias extended to −0.5…1.5 so the drag edges fully
  saturate at contrast 1.)

## From M3 implementation (parked, not blocking)

- More shapes: line, vector, text regions, panda/epanda (parser currently
  warns + skips them). Annulus + region save landed 2026-07-05.
- Region save currently normalizes (decimal degrees, arcsec, icrs, globals
  baked into each line); preserving the source file's exact units/sexagesimal
  style would need the parser to keep the original tokens.
- Elliptical/box annuli (DS9 writes them as ellipse/box with 2n radii pairs)
  — parser currently treats extra ellipse/box args as an arg-count error.
- Exact fk5 ↔ icrs frame rotation (~23 mas; currently treated as equal —
  fine for JWST pixel scales, visible on sub-arcsec HST work).
- Galactic-frame regions (needs coordinate transform).
- Region interaction: ~~hover highlight, click-to-inspect~~,
  ~~drag-to-move/resize, create-new-region UI, save from in-memory regions~~,
  ~~multi-region select (cmd/shift+click, rubber-band)~~
  **all DONE 2026-07-05** (Edit-mode toggle; save serializes the live
  `PixelRegion[]` in image/sky frame; multi-select moves/deletes the group).
  ~~**New-polygon creation**~~ **DONE 2026-07-12, verified live** (click-to-add
  vertices; close via first-vertex click / Enter / dblclick; Escape discards).
  Still open: handle-hover cursor shapes (nesw/nwse); numeric entry of region
  params; per-region color/label editing UI; multi-select resize (only the
  primary resizes today).
- ~~**Region undo/redo (user request 2026-07-05)**~~ **DONE 2026-07-12,
  verified live**: ⌘Z/⌘⇧Z, bounded 50-state stack in `viewer.ts`, snapshots
  around every edit-mode mutation incl. polygon-draft commit.
- **Edit polygon topology (user request 2026-07-05)**: add or remove vertices on
  existing polygons (today only existing vertices can be dragged; new-polygon
  creation is separately parked above). E.g. double-click an edge to insert a
  node, double-click / modifier-click a node to delete it.
- Region text label size option (fixed 11px now).

## From M4 implementation (parked, not blocking)

- Vector / complex / bit (X) / variable-length (P/Q) columns render as a text
  placeholder (`[a, b, …]`, `<binary>`) and can't be sorted. Expanding vector
  columns into sub-columns or a cell-detail popover is a follow-up.
- Per-column filters (TOPCAT-style header filter row) instead of the single
  column-dropdown + query. Backend `build_view` takes one filter today.
- Column show/hide, reorder, resize (drag borders); currently fixed widths
  derived from name/kind/length.
- Sort speed on very large tables: `build_view` reads the sort column via
  strided mmap access (faults a page per row on a cold multi-GB table). The
  <100 ms / 1M-row target may need contiguous column reads or a key cache.
- Cell/row selection, copy-to-clipboard, CSV/VOTable export.
- ASCII-table `repeat` is reported as the field byte width (not element
  count) — harmless for display but note if it ever matters semantically.
- Table sort is stable-ish (ties broken by row index); multi-column sort not
  supported.

## From M5 implementation (parked, not blocking)

- **M5 depth landed 2026-07-05** (implemented, not yet verified live):
  ~~overlay-all onto the linked image~~, ~~image→row reverse link~~,
  ~~side-by-side split view~~ all DONE (see STATE.md). Remaining follow-ups:
  - ~~**Cross-file marker → row**~~ **DONE 2026-07-11 (not yet verified live)**:
    a `Frame.sourceFrom` provenance record + passing native row ids to every
    overlay target lets a click on a marker on a pure *image* frame activate the
    catalog frame and reveal its row (`locateSourceRow` in `main.ts`).
  - ~~**Reverse link without resetting sort/filter**~~ **DONE 2026-07-12 (not
    yet verified live)**: `table_view_pos` backend lookup maps native row →
    view position; `revealRow` keeps the user's sort/filter, resetting only
    when the row is filtered out of the current view.
  - **Overlay perf on huge catalogs**: markers are a linear scan on click and a
    per-frame cull on draw. A grid/quadtree spatial index would help at 100k+.
  - ~~Manual position-column picker~~ **DONE 2026-07-12 (not yet verified
    live)**: auto/sky/pixel kind select + two column selects on the table tab,
    per-frame override for locate + overlay. Still open: UCD-based detection,
    more name heuristics.
  - **Split view polish**: both image + table toolbar control groups show at
    once (toolbar now wraps); a draggable split divider / vertical stack option;
    split currently pairs a frame's *own* image + table only (not cross-frame).
  - Sky-frame save of ellipse/box is exact only for conformal WCS (like
    astropy's SVD approximation); a sheared WCS drifts — revisit if it bites.
  - ~~**Cross-file catalog→image overlay (user request 2026-07-05)**~~ **DONE
    & verified live 2026-07-05**: an "Overlay ▸ image" button on the table tab
    projects the catalog's RA/Dec onto every other open WCS image frame (marker
    per row). Remaining: overlay a *single* selected catalog row onto another
    frame (per-source, not all); a target-frame picker (today it hits *all*
    other WCS image frames); manual RA/Dec column picker.

## From the crossmatch design discussion (2026-07-13, see docs/CROSSMATCH_PLAN.md)

- **Match output modes beyond "Best"**: All-matches-within-radius, 1and2,
  1or2, 1not2, symmetric-best — all cheap follow-ups once the pair-list core
  exists (different consumers of the same `(row_a, row_b, sep)` pairs). v1
  ships Best + inner join only (user decision).
- **Persistent sidecar column cache**: extracted sort/coord columns (~8 MB
  each) written to a cache dir keyed by (path, mtime, size) so re-opening a
  multi-GB catalog across sessions skips the cold full-file scan.
- **Expression filters / derived columns** (TOPCAT-style `mag_a - mag_b <
  0.5`): a small expression evaluator over cached columns — the natural
  extension of the column cache, still no SQL engine.

## User ideas (add here as they come up)

- ~~**Multi-frame (2026-07-04)**~~ **first cut DONE 2026-07-05**: multiple
  files open, frame bar + chip switching, per-frame view state, tiled grid
  layout, pixel camera-lock, and blink all landed & verified live (see
  STATE.md). One `Viewer` per frame (own WebGL context). Remaining follow-ups:
  - ~~**WCS-locked pan/zoom**~~ **DONE & verified live 2026-07-05**: the Lock
    button cycles none→WCS→pixel; WCS mode aligns by sky (pix→world→pix per
    frame + plate-scale-ratio zoom), pixel fallback for no-WCS frames.
    ~~**WCS-lock direction alignment**~~ **DONE & verified live 2026-07-05**:
    `Lock·wcs` now also *rotates* each frame north-up (view rotation) so pan/
    zoom directions match. Remaining: **opposite-parity WCS-align** — north-up
    alignment rotates but does not *flip*, so two frames of opposite parity
    (one sky-flipped) would be north-up but east on opposite sides → horizontal
    pan still mirrored. Needs a parity flip in the shader/overlay (a sign on the
    x axis) keyed off sign(det CD). Same-parity pairs (the common JWST case)
    are fully aligned.
  - **Zoom center-vs-cursor setting (user request 2026-07-05)**: wheel zoom now
    always zooms to the view center (was zoom-to-cursor). Make it a user
    preference (persisted) — the cursor-anchor math is in git history
    (`viewer.ts` wheel handler before this change) if reinstated as an option.
  - **Many-frame scaling** — WKWebView caps ~16 simultaneous WebGL contexts;
    one Viewer/context per frame (lazy-created, `WEBGL_lose_context` on close)
    is fine for a handful. If a user opens many, pool/destroy off-screen
    contexts or switch to a single-context multi-viewport renderer
    (`gl.viewport`+`gl.scissor` per cell) — a bigger Viewer rewrite.
  - Per-frame **blink subset / rate** control, drag-reorder frames, frame
    thumbnails, per-frame independent HDU in a grid cell.
  - Grid + non-image frames: a table/header-only frame shows blank in grid
    (grid is image-focused); fine, but a mixed layout is a possible polish.
- (the user has "many various improvements" to explicate — collect them here)
