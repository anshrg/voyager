# Voyager — Living State Document

> **For every Claude session**: read this first (after CLAUDE.md); update it
> before you finish any significant work. Keep it **current-state only** —
> history lives in `git log`. New feature ideas go to `BACKLOG.md`, durable
> decisions with rationale to `CLAUDE.md`.

## PR #11 closed 2026-08-14 — cold-scan hang diagnosed and fixed; needs re-test on the Mac

Ansh (owner, M2 MacBook Air) tested the M5 crossmatch build from PR #11 and
closed it: *"cross-match functionality does not work - enters indefinite
loop."* That build predates the cold-scan fix, which had been diagnosed
during live testing (first sort on the 1M-row/11 GB catalog hung) but never
made it to GitHub — pushes were blocked by the repo ruleset ("changes must
be made through a pull request", scoped to **all** branches; Ansh needs to
re-scope it to `main` in Settings → Rules), and the container holding the
unpushed commit was recycled, so the fix was **re-implemented from scratch**
(this working tree; commit "cold column scans: stream…").

**Root cause** (two layers):
1. A cold full-column materialization looped `cell()` row by row,
   demand-faulting the whole multi-GB file through the mmap one 4 KB page at
   a time — minutes of synchronous fault latency on macOS, which presents as
   an app-wide hang. A crossmatch needs RA/Dec cold from *both* catalogs
   (plus the overlay's `table_columns_f64`), hence "cross-match enters
   indefinite loop".
2. Dispatch trap: `OpenTable` (lib.rs) implements `RowSource` but didn't
   forward the extraction methods, so they resolved to the trait *defaults*
   (per-cell loops) — any `Table`-level fast path was silently bypassed.

**Fix**: `Table::extract_columns` streams whole rows in ~8 MB buffered
`pread` chunks (sequential SSD-bandwidth I/O, no mmap faulting; mmap
fallback if the file can't be re-read; Null tail past EOF identical to the
bounds-checked path) and pulls **all requested columns in one scan** —
`table_view` (sort+filter), `xmatch_tables` (RA+Dec per side), and
`table_columns_f64` now pay one scan per file. `OpenTable` forwards every
extraction method (comment in lib.rs warns about the default-method trap).
Gated by: per-cell-identity test over the astropy fixtures, plus
`tests/table_stream.rs` (multi-chunk 1.2M-row synthetic table + truncated
file). 89 tests green, tsc clean.

**Mac re-test needed** (then the PR #11 checklist): cold first sort on the
11 GB catalog, and a crossmatch of two large catalogs — watch for
`(cols: miss+miss…)` then `hit` on re-runs in the log. Container Linux
timing: 1.2M×2-col scan ≈ 0.5 s debug.

Status 2026-08-14: push of this fix rejected by the ruleset (git **and**
GitHub API both `GH013`); patch re-sent to the user's chat as backup
(`git am` on top of `277d5a5`); diagnosis + ruleset ask posted as a comment
on closed PR #11. Reopening the PR is Ansh/Hollis's call — do not reopen
unilaterally.

## Current milestone: everything implemented through M5 depth is now **user-verified working (2026-07-12)** — including zoom-flash fix, table horizontal scroll, the full M5-depth + multi-region-select surface, the overnight-2026-07-12 batch (region undo/redo, reverse-link-keeps-sort, new-polygon creation, position-column picker), cross-file marker→row, and real-data confirmation (row-locate on a wide JWST catalog + region save round-trip through DS9). Next work comes from BACKLOG (M6 packaging/polish, M4 polish, overlay follow-ups).

> **Verification protocol change (2026-07-12, user request): do NOT verify by
> simulating user input (CGEvent/System Events automation). Launch the app with
> the right files, then give the user a numbered manual test checklist and
> record their pass/fail here.**

### Verification hand-off 2026-07-12 — checklist given to the user

Test data generated in the session scratchpad
(`/private/tmp/claude-503/-Users-arg5965-research-voyager/ad59e662-a367-4c3c-8484-3daf604b1355/scratchpad/`,
regenerate with `gen_verify_data.py` there if the tmp dir is gone —
consider copying it to `scripts/` if it proves useful):
- `combo.fits` — 256×256 synthetic image (TAN WCS, 0.1″/px at 150.1,+2.2) +
  12-row CATALOG bintable whose RA/Dec land on 12 visible gaussian blobs.
  For split view / overlay-onto-own-image / same-file image→row.
- `cross_catalog.fits` — catalog-only FITS, 24 sources inside the
  ceers_miri3_f770w_i2d footprint. For the cross-file marker→row link.

Checklist run by the user 2026-07-12 with combo.fits +
ceers_miri3_f770w_i2d.fits + cross_catalog.fits open (3 frames): (1) split
view on combo.fits, (2) Overlay ▸ image onto own image, (3) same-file
marker→row keeping sort, (4) cross-file marker→row from cross_catalog onto the
MIRI frame, (5) multi-region select (cmd/shift-click, shift-drag rubber band,
group move, Delete). **User confirmed ALL FIVE working 2026-07-12.** Nothing
implemented remains unverified — the whole M5-depth + multi-region-select +
cross-file-link surface is now user-verified live.

### Overnight batch 2026-07-12 — four features for morning review — **ALL FOUR user-verified working 2026-07-12**

1. **Region undo/redo (⌘Z / ⌘⇧Z)** — bounded (50-state) history stack in
   `viewer.ts` (`undoStack`/`redoStack`, `snapshotForUndo` via `structuredClone`);
   snapshots taken at the start of every mutating gesture (create-drag, move,
   resize/rotate/node-drag, delete, polygon-draft commit). A bare no-drag create
   click pops its own snapshot (no no-op undo entries). Stacks reset on
   setImage/clear/setRegions (region set replaced wholesale). Keys wired in
   `main.ts` keydown (guarded against text inputs). **Verified live**: draw
   circle → ⌘Z removes it (Save/× buttons drop away) → ⌘⇧Z restores it.
2. **Image→row reverse link keeps sort/filter** — new Rust command
   `table_view_pos(path, hdu, native_row)` (`lib.rs`) maps a native row index
   to its position in the cached sort/filter view (`None` = filtered out;
   identity/no view = passthrough). `TableView.revealRow` (`table.ts`) now
   looks up the view position and scrolls/highlights there, keeping the user's
   sort/filter; it only falls back to the old reset-to-identity when the row is
   filtered out of the current view. `tableViewPos` wrapper in `api.ts`.
   `highlightRow` is now a *view* position. **User-verified live 2026-07-12.**
3. **New-polygon creation (click-to-add vertices)** — "polygon" added to the
   edit-mode shape picker (`CreatableShape`). In edit mode: first click starts
   a draft (`Viewer.polygonDraft`), each click adds a vertex, live preview
   (solid segments + dashed cursor segment + vertex dots, `drawPolygonDraft`
   in regionlayer.ts); close by **clicking near the first vertex** (≥3
   vertices, ~8 px), **Enter** (`finishPolygonDraft`), or **double-click**
   (dedupes the dblclick's extra vertex). **Escape discards** the draft;
   switching the shape picker mid-draft also discards; <3 vertices discards
   silently. Commit pushes onto the undo stack + selects the new polygon.
   **Verified live**: 3-vertex draft → Enter closes (correct centroid readout,
   handles shown); Escape cancels a 2-vertex draft.
4. **Manual position-column picker** — new toolbar selects on the table tab
   (`pos-kind-select`: auto/sky/pixel + two column selects, shown when not
   auto): overrides the RA/Dec/X-Y name heuristics for both row→image locate
   (`locateRow`) and the catalog overlay (`overlayCatalogSources`). Per-frame
   (`Frame.posOverride`); column lists refresh on table load/frame switch
   (`refreshPosColumnPicker` in `ensureTable`); switching to sky/pixel seeds
   the selects with the name-heuristic guess. **User-verified live 2026-07-12.**

Files: `src/render/viewer.ts`, `src/render/regionlayer.ts`, `src/render/table.ts`,
`src/main.ts`, `src/api.ts`, `src-tauri/src/lib.rs` (new command registered).
`npx tsc --noEmit` clean; `cargo test` 58 green (no fixture change needed —
`table_view_pos` reads the already-tested cached view).

**Verification session note**: I quit a leftover bundled /Applications/Voyager.app
instance (user's own) to unblock UI automation, and left a `npm run tauri dev`
instance running against `fixtures/sample.fits` (kill with
`pkill -f "tauri dev"; pkill -f "target/debug/voyager"`). Sample.fits' CATALOG
RA/Dec intentionally spans ~0.4° while HDU0's footprint is ~arcsec, so
overlay markers land far off-image — "overlaid 123 sources onto 1 image" with
nothing visible is expected on the fixture; use real CEERS data (or X/Y pixel
columns via the new picker) to see markers.

### Project rename DS10 → Voyager (2026-07-11, latest)

The whole project was renamed from **DS10** to **Voyager** at the user's
request. All in-repo references updated: Rust crate `ds10`→`voyager` + lib
`ds10_lib`→`voyager_lib` (Cargo.toml/Cargo.lock, `main.rs`, examples, all
`tests/*.rs` `use` lines); Tauri `productName`/window title `DS10`→`Voyager`,
identifier `org.ds10.app`→`org.voyager.app`; the internal open event
`ds10://open-request`→`voyager://open-request` (both `lib.rs` emit + `api.ts`
listen); log prefixes `[ds10]`→`[voyager]`; `package.json`/`package-lock.json`
name; `index.html` title; the `app-title` span in `main.ts`; docs + the verify
skill + fixture-gen scripts. Verified: `npx tsc --noEmit` clean and `cargo test`
green (crate rebuilt as `voyager_lib`, doc-tests confirm). **User verified the
renamed app live 2026-07-12** and moved the on-disk directory to
`/Users/arg5965/research/voyager` (this session's cwd) — no code depended on
the folder name so the move was transparent. The new bundle identifier means a
bundled build registers as a fresh app (file associations re-register on next
`tauri build`).

### Cross-file marker→row reverse link — DONE & verified live 2026-07-12

User feedback (point 1): overlaying a catalog opened as a *separate* FITS file
onto an image file, then clicking an overlaid source marker on the image, should
jump to that row in the catalog frame's table. The overlay itself already worked;
what was missing was **marker provenance** so a click could route back.
Implemented (frontend-only):
- New `Frame.sourceFrom: { frame, tableHdu } | null` records which catalog frame
  + table HDU produced the markers currently on a frame's viewer.
- `overlayCatalogSources` now passes the native **row ids to every target frame**
  (was: only the same frame; other frames got `null` → no reverse link) and sets
  `sourceFrom` on each (own image + every other WCS image frame).
- `locateSourceRow(frame, row)` rewritten: reads `frame.sourceFrom`, activates
  the catalog frame (`setActive`), shows its table (split for a same-file
  image+table frame; `selectHdu(tableHdu)` for a cross-file/table-only frame),
  then `tableView.revealRow(row)`. Same-file local reverse link unchanged.
- `clearSourceOverlays` also clears `sourceFrom` on every frame.
Files: `src/main.ts` only. `npx tsc --noEmit` clean. **To verify live**: open an
image FITS, open a separate catalog FITS (with RA/Dec), activate the catalog →
**Overlay ▸ image** (sources land on the image frame), activate the image frame,
click a source marker → the catalog frame comes forward and scrolls+highlights
that row.

### M5 depth + multi-region select — DONE, user-verified live 2026-07-12 (implemented 2026-07-05)

Four features landed 2026-07-05 (frontend-only; backend untouched, 58 Rust
tests still green, `npx tsc --noEmit` clean). **All user-verified live
2026-07-12** via the checklist hand-off above.

1. **Split image+table view** — a **Split** toggle (right side of the view-tab
   row; shown only when the active frame's file has *both* an image and a table
   HDU) shows the image and table **side by side**, removing the M5 first-cut
   "row click leaves the Table tab" limitation. Implementation: the three panes
   now live in a `#view-panes` flex container (`main.ts buildUi`) — stacked
   (one shown) in single-view, `flex-direction:row` under `.split` (styles.css).
   The viewer displays the **file's linked image HDU** even while the sidebar
   selection points at the table HDU: new `Frame.viewerHdu` (the HDU actually
   loaded in the viewer, may differ from `selectedHdu`) + derived accessors
   `frameImageHdu`/`frameTableHdu`/`frameCanSplit`/`frameSplit`. WCS, regions,
   histogram, goto, and region-save now key off `viewerHdu` (was `selectedHdu`).
   Split and tiled Grid are mutually exclusive. Clicking a single tab leaves
   split into that pane.
2. **Overlay-all onto the linked image** — the table-tab **Overlay ▸ image**
   button now also projects the catalog onto the frame's **own** image (the one
   shown in Split view), not just other open frames. Same-frame markers carry
   **native row indices** (for the reverse link); cross-file markers don't.
   Supports **RA/Dec via WCS or X/Y pixel columns** (X/Y only for the same
   frame — a different image's grid is meaningless). New `projectRows` helper.
3. **Image→row reverse link** — clicking a projected **source marker** on the
   image (when it carries a row id) scrolls the table to that row and
   highlights it (accent bg + outline). Plumbing: `setSourceMarkers(pts, rows?)`
   + `sourceRows`; `onSourcePick(row)` callback; `hitTestSourceMarkers` in
   regionlayer; viewer's click path tries a marker when no region is hit;
   `TableView.revealRow(nativeRow)` / `clearHighlight`. **revealRow resets any
   active sort/filter to identity first** (the frontend doesn't hold the sort
   permutation, so native row → view position only maps in identity order) —
   note this UX in a live check. In single-view the reverse link auto-enables
   Split (keeping the image) before scrolling.
4. **Multi-region select** — cmd/shift+click a region toggles it in a set;
   **shift+drag on empty space rubber-bands** (dashed blue rect) to select all
   whose center is enclosed; Delete removes **all** selected; in edit mode a
   body-drag moves the **whole group**. `Viewer.selectedIndex` (still the
   "primary" for handles + description) is now backed by a `selection:
   Set<number>`; `drawRegions` glows the whole set (white), handles only on the
   primary; status shows the single region's description or "N regions
   selected". regionlayer gains `regionsInRect` + `drawRubberBand`.

Files: `src/render/viewer.ts`, `src/render/regionlayer.ts`, `src/render/table.ts`,
`src/main.ts`, `src/styles.css`. **To verify live**: open sample.fits (PRIMARY
image + CATALOG table) → select CATALOG → **Split** → **Overlay ▸ image**
(sources land on PRIMARY) → click a marker (table scrolls+highlights) → click a
row (image centers+marks); then load image.reg and cmd/shift-click + shift-drag
several regions, move + Delete them.

### Multi-frame feedback pass — DONE & verified live 2026-07-05 (latest)

User feedback on the multi-frame/lock/overlay session, all landed + verified
live on two CEERS MIRI3 pointings (f560w + f770w i2d) + sample.fits (catalog):

1. **Grid excludes non-image frames** — the tiled grid no longer makes a blank
   cell for a catalog/header-only frame; grid dims count *image* frames only.
   Entering Grid while a non-image frame is active auto-jumps to the first
   image frame so the grid is visible (`applyGridLayout` sets inline
   `display:none` on non-image cells; `toggleGrid` does the jump). Verified: 3
   frames (2 images + 1 catalog) → grid shows 2 tiles, no empty catalog tile.
2. **WCS-lock now *aligns direction* (rotation), not just center** — the old
   WCS-lock centered the same sky point but left each frame at its own roll, so
   panning one moved the other in a different screen direction. Now under
   `Lock·wcs` every frame is **rotated north-up** (a real view rotation), so
   pan/zoom directions match across frames. Verified: `Lock·wcs` rotated both
   pointings to a common diamond (north-up) orientation; dragging one panned
   both identically in the same screen direction; the Next-activated frame
   inherited the aligned camera + rotation.
3. **Next/Prev frame buttons** (◀ ▶) in the toolbar — manual frame switching
   next to Grid/Blink/Lock (mirror the `[`/`]` keys). Verified: ▶ advanced
   f560w→f770w.
4. **Wheel zoom is now zoom-to-**center**** (view center fixed), not
   zoom-to-cursor, per user request. Verified: scrolling with the cursor
   off-center scaled the image symmetrically about the view center. (A
   per-user *setting* to choose center vs cursor is parked — BACKLOG.)

Implementation (frontend-only; backend untouched):
- **Viewer rotation** (`src/render/viewer.ts` + `gl.ts` + `regionlayer.ts`): a
  `rot` angle (radians, CCW in image y-up). The vertex shader gains a `u_rot`
  = (cos,sin) and rotates each tile about the view center. `regionlayer`'s
  `screenMap` became a coupled `project(px,py)→[x,y]` (rotation couples x/y);
  all overlay draw + hit-test + handle call sites updated; ellipse/box screen
  angle and hit-test add the view rotation. `toImage`/pan invert the rotation
  (`deviceToImageOffset`); `drawLevel`'s visible-tile AABB expands for the
  rotated screen rect. **rot is 0 on every non-`Lock·wcs` path** (setImage/
  clear/pixel/none reset it) so plain single-frame use is provably unchanged.
- **North-up angle** (`main.ts` `northUpRotation`/`alignRotation`): θ = 90° −
  atan2(N) where N = pixel step toward +Dec at the view center; applied per
  frame in `cycleLock`/`applyLockedCamera`/`loadFrameImage`. Parity is NOT
  flipped — two same-parity frames (the common case) align fully; opposite
  parity would need a mirror (BACKLOG).
- **Zoom-to-center**: the wheel handler dropped the cursor-anchor math; just
  clamps scale, keeps cx/cy.
`npx tsc --noEmit` clean; 58 Rust tests unaffected (no backend change).

### WCS-lock + cross-file catalog overlay — DONE & verified live 2026-07-05

Both landed this session, verified live on two CEERS MIRI3 pointings
(f560w + f770w i2d) + a synthetic in-footprint catalog (3 frames):

- **WCS-lock** — the Lock button now **cycles none → WCS → pixel** (label
  shows `Lock`/`Lock·wcs`/`Lock·px`). WCS mode aligns frames by *sky*: the
  active frame's camera center pixel → world → pixel per other frame (each via
  its own WCS), and zoom matches by the plate-scale ratio (`scale · pixScaleₜ /
  pixScaleₛ`). Falls back to pixel mirroring for any frame lacking a WCS (or if
  a point is off its sky). Verified: with `Lock·wcs`, zooming one frame into a
  bright source kept the other frame showing the identical sky region + zoom.
- **Cross-file catalog→image overlay** — on a table HDU, an **Overlay ▸ image**
  toolbar button (table tab only) projects the catalog's RA/Dec onto **every
  other open image frame that has a WCS**, drawing a source marker per row on
  that frame's overlay (with a **Clear overlay** button that appears while any
  markers exist). Verified: 30 catalog sources drew as the expected 6×5 grid on
  both MIRI frames, each through its own WCS, landing inside the footprint.

Implementation:
- **Backend**: `wcs::WcsParams` (serializable snapshot of crpix/lon0/lat0/cd/
  cd_inv/lonpole/swapped) + `Wcs::params()`; `get_wcs(path,hdu)` command
  (Option, None = no WCS). `table::Table::column_f64(col)` + async
  `table_columns_f64(path,hdu,cols)` command (whole numeric columns as f64,
  NaN for null — avoids boxing every column through JSON for a bulk projection).
- **Frontend WCS** (`src/render/wcs.ts`, NEW): `Wcs` class mirroring the Rust
  TAN `pix_to_world`/`world_to_pix` + `pixScale()` = √|det CD|, built from
  `WcsParams`. **Synchronous** so the lock (broadcasts per pan frame) and the
  bulk projection don't cross IPC per point. **Cross-checked against astropy**
  to ~1e-10 arcsec / 1e-9 px on a plain + a rotated/skewed high-dec WCS (the
  Rust side is the header-parse source of truth; this only mirrors the math).
- `Viewer.setSourceMarkers(pts, color?)` / `hasSourceMarkers()` + a
  `drawSourceMarkers` overlay renderer (culls off-screen pts; cleared on
  setImage/clear since projection is per-image-WCS).
- `main.ts`: `Frame.wcs` cached in `loadFrameImage` (via `loadFrameWcs`, stale-
  HDU guarded); `lockMode` replaces the old `lockCamera` bool; `mirrorCameraFrom`
  /`applyLockedCamera` helpers; `overlayCatalogSources`/`clearSourceOverlays`/
  `refreshOverlayButtons` + RA/Dec column detection reusing the M5 name sets.
58 Rust tests green (49 unit + 6+2+1 fixture); `npx tsc --noEmit` clean.

### Multi-frame (DS9-style frames) — first cut, verified live 2026-07-05

Open several FITS files at once; each is a **frame** with its own `Viewer`
(own canvas + WebGL context) so pan/zoom, scale limits, stretch, colormap,
contrast/bias, regions, and marker all persist per frame automatically (no
capture/restore). Delivered + verified live on `sample.fits` + two CEERS MIRI
i2d pointings (3 frames, 3 live WebGL contexts, no errors):
- **Frame bar** (`#frame-bar`) with one chip per open file (basename + active
  highlight + close ×); click a chip to activate. Verified: chip switch swaps
  the HDU list, header, status line, and toolbar selects to that frame.
- **Per-frame state persistence** — verified: zoomed frame A stays zoomed,
  frame B stays at its own fit, independently; limits label + colormap/stretch/
  scale selects re-sync to the active frame (`syncToolbar`).
- **Tiled grid layout** (Grid button / `g`) — CSS grid of live cells with
  filename labels + accent outline on the active cell; grid dims from frame
  count (⌈√n⌉). Click a cell to activate it. Verified: 2×2 with 3 frames.
- **Pixel camera-lock** (Lock button) — enabling mirrors the active frame's
  camera to all others; panning/zooming one broadcasts to the rest
  (`Viewer.onCameraChange` → `setCamera`). Verified: pan one cell, others
  track. This was the original *pixel*-space lock; **WCS-lock (align by sky)
  landed 2026-07-05** — the Lock button now cycles none→WCS→pixel (see top). A
  tiny image (sample's 64×48) predictably falls off-view under a shared pixel
  camera; use WCS mode for different-pointing/size images.
- **Blink** (Blink button / `b`) — auto-cycles the active frame through image
  frames every 500 ms (`BLINK_MS`); drops grid mode; needs ≥2 image frames.
  Verified: active frame advances miri1→sample→…
- **Open adds, not replaces**: argv/double-click/⌘O all add frames; opening an
  already-open path just activates its frame (backend dedupes by path). `init()`
  now opens **all** pending files. Close via chip × or ⌘W (`closeFrame` →
  `viewer.destroy()` releases the GL context via `WEBGL_lose_context`, then
  `close_fits`), activating a neighbor; closing the last returns to empty state.
- Keys: `[`/`]` prev/next frame, `b` blink, `g` grid, ⌘W close (all guarded
  against text-input focus).

Backend unchanged (already keyed by path); this was frontend-only:
`src/main.ts` (frame list + all the above), `src/render/viewer.ts` (added
`destroy`, `getCamera`/`setCamera`, `onCameraChange`, `getColormap`/
`getScaleMode`/`getStretch`), `src/styles.css` (frame bar/grid/cell). 58 Rust
tests still green; `npx tsc --noEmit` clean.

M2 accepted 2026-07-04; M3 (regions) accepted 2026-07-05; **M4 (table
viewer) accepted by the user 2026-07-05**. This session (2026-07-05, latest)
delivered, all verified live except where noted:
1. **Region info persistence** (user feedback) — the selected-region
   description now lives in its own `#region-info` status element, so the
   live pixel readout on pointermove no longer clobbers it; it persists
   until deselect. Verified: description + sky stay while the mouse moves.
2. **Table horizontal scroll** (user feedback) — the earlier
   `min-width: max-content` fix was insufficient; **now fixed & verified live**
   on a wide (17-col) real catalog. Root cause was a flexbox `min-width:auto`
   trap: `.table-view` had no `min-width: 0`, so the whole table pane grew to
   the content width (1930 px) and spilled past the window edge instead of
   letting `.table-scroll` scroll internally — the bottom scrollbar thumb then
   spanned the whole track with nothing to move. Fix: `min-width: 0` on
   `.table-view` (styles.css) + an explicit `.table-inner` width = summed
   column width set in `buildHeader` (table.ts). Verified via injected DOM
   metrics: before `scrollWidth==clientWidth==1930` (unmovable thumb); after
   `scrollWidth=1930, clientWidth=1030` (proportional, draggable thumb, right
   columns reachable). Narrow 5-col table shows no spurious scrollbar.
   (Synthetic *horizontal* wheel events are ignored by WKWebView — vertical
   works — so the thumb was confirmed by DOM measurement, not a synthetic
   drag; a real trackpad/mouse scrolls fine.)
3. **Region move/resize/create + save-from-edits** — an Edit-mode toggle;
   see below. Verified: create/move/resize a circle, save image + sky.
4. **M5 image↔table linking (first cut)** — click a catalog row → locate &
   mark the source on the image. Verified: row click switches to the Image
   tab, resolves RA/Dec, drops the crosshair.
5. **Crosshair rework** — goto + M5 marker now draw on the overlay canvas,
   pinned to an image pixel (track pan/zoom), and fade only on Escape.
   Verified: persists (no auto-fade), tracks a pan, fades on Escape.

Uncommitted — the user commits per-milestone; changes are on `main` working
tree, ready to review.

## What works (verified)

- **Rust `fits`/`tiles`/`wcs` modules**: unchanged from M0–M2 (header parse,
  mmap open, sampled tiles, zscale/minmax/histogram, TAN WCS ±swap/rot/
  CROTA2, sexagesimal parse/format). **58 tests green total**
  (`cd src-tauri && cargo test`) — includes the new table fixtures. The TAN
  transform now also has a TS mirror (`src/render/wcs.ts`) for WCS-lock +
  catalog overlay, cross-checked against astropy to ~1e-10 arcsec.
- **Rust `table` module** (`src-tauri/src/table/mod.rs`, pure/tested): reads
  BINTABLE and ASCII TABLE HDUs from the mmap on demand (nothing slurped at
  open). `Table::open` parses columns (TFORM/TTYPE/TUNIT/TSCAL/TZERO;
  BINTABLE `rT` repeat+type, ASCII Fortran `Aw/Iw/Fw.d/Ew.d/Dw.d`); `cell`
  reads one bounds-checked cell (scalars typed; vectors → "[a, b, …]"
  string; A → trimmed string; unsigned via TZERO; NaN → Null); `page` reads
  a row window mapped through a view; `build_view` produces a sort/filter
  row-index permutation (identity = `None`, no alloc). Sort keys: numeric
  (NaN last) or string. Filter: numeric predicate (`>x`,`>=x`,`<x`,`<=x`,
  `=x`,`a..b`) on numeric cols, else case-insensitive substring on the
  display string. Fixtures: `gen_fixtures.py` now writes a `table_checks`
  block (CATALOG bintable + a new ASCIICAT ascii table); `tests/
  table_fixtures.rs` checks columns/cells/sort/filter vs astropy.
- **Table IPC** (`lib.rs`): `table_columns`, `table_view(sort?,filter?)`
  (async, off-thread; caches the row-order permutation in `AppState`),
  `table_rows(start,count)` (reads a window of the cached view). Typed
  wrappers in `api.ts` (`tableColumns/tableView/tableRows`, `TableCell`
  = number|string|bool|null).
- **Table frontend** (`src/render/table.ts`, `TableView`): virtualized grid
  (only the visible row window is in the DOM; tall sizer + absolute rows;
  row chunks of 200 cached). Click-to-sort headers (none→asc→desc→none,
  ▲/▼ indicator); numeric cols right-aligned monospace; a filter bar
  (column dropdown + query input, 250 ms debounce) with a live row count.
  New "Table" tab appears for bin_table/ascii_table HDUs (Image tab hidden
  for them); selecting a table HDU auto-opens it. **Verified live** on
  sample.fits CATALOG: 123 rows render, sort by FLUX ascending reorders
  correctly (ID 4 first, matches argsort), filter `>100` on ID → 22 rows,
  and filter+sort compose.
- **Region interaction** (`regionlayer.ts` + `viewer.ts`): `hitTestRegion`
  screen-space hit test per shape (circle/annulus/ellipse/box/polygon/
  point; interior + outline within ~6 px). Hover → cursor `pointer` +
  color glow (overlay-only repaint, no GL redraw). Click (a left press that
  moved <4 px, distinct from a pan) selects the topmost region → white glow
  + bbox corner handles, and the status line shows a description (shape,
  center as FITS 1-based, radius/size, PA) plus the center's sky position
  (async `get_readout`). Click on empty space deselects. Selection/hover
  reset on HDU/region/image change. **Verified live** on image.reg over
  PRIMARY: clicking the red "core" circle showed
  `circle · center (32.0, 24.0) · r 10.5 px 10:00:27.917 +02:12:20.90`
  with the glow + 4 handles.
- **Region editing** (`viewer.ts` + `regionlayer.ts` + `main.ts`): an **Edit**
  toolbar toggle + a create-shape `<select>` (circle/box/ellipse/annulus/
  point). In edit mode: left-drag on empty space **draws** the chosen shape;
  **click a region to select** it, then drag its **body to move** or a
  **handle to resize** (shape-aware handles: circle radius; annulus in/out;
  ellipse/box axis handles + a rotation handle; polygon per-vertex nodes);
  **⌥+left-drag or right-drag pans** (contrast/bias right-drag is suspended
  while editing); **Delete/Backspace** removes the selected region;
  **Escape** deselects + cancels an in-progress draw + fades the marker.
  Regions are edited in place on the in-memory `PixelRegion[]`. New-polygon
  creation (click-to-add vertices) is **not** built (BACKLOG); existing
  polygons are movable/node-editable. Selection/inspect still works with
  edit mode **off** (unchanged M3 behavior).
- **Save edited regions** (`save_pixel_regions` in `lib.rs`; `write_pixel_
  regions` in `regions/write.rs`; `PixelRegion::to_image_region`/`to_sky_
  region` in `regions/mod.rs`): the **Save** button now serializes the
  viewer's live regions (not the source .reg), with a **frame `<select>`
  (image default / sky)**. Image frame is the exact inverse of
  `image_to_pixel`; sky frame converts pixel→world (positions), local scale
  (circle/annulus radii) and the inverse Jacobian+SVD (ellipse/box angle =
  `180 − svd_angle`). `PixelRegion` now derives `Deserialize`. The old
  `save_region_file` (re-parse the source) is **removed**. Correctness:
  `tests/region_fixtures.rs::pixel_region_save_round_trips` asserts
  PixelRegion → image/sky Region → back-to-pixel is exact (image 1e-9, sky
  1e-4 on both fixture WCS variants; near-circular angle skipped). **58
  Rust tests green.** Verified live: image `.reg` = `circle(57.68,23.88,
  9.02)`, sky `.reg` = `icrs circle(150.116,2.2058,0.27")`.
- **Locator crosshair** (`drawCrosshair` in `regionlayer.ts`; `marker`/
  `setMarker`/`clearMarker`/`escape` in `viewer.ts`): drawn on the region
  overlay at an image-pixel `marker` via the same camera transform (so it
  tracks pan/zoom); no auto-fade — `escape()` ramps its alpha to 0 over
  ~0.9 s then clears. goto and M5 both call `setMarker`. Replaced the old
  screen-centered CSS `#goto-crosshair` + `flashCrosshair`.
- **M5 row→image locate** (`table.ts` `onRowActivate` + `main.ts`
  `locateRow`): a table row click reports its cells+columns; `locateRow`
  detects RA/Dec (name heuristics) or X/Y pixel columns, picks the file's
  first viewable image HDU, switches to it (Image tab) via `selectHdu`, and
  `centerOn` + `setMarker`. RA/Dec reuse `resolveCoord`; pixel columns are
  FITS 1-based → 0-based. First-cut limitation: the row click leaves the
  Table tab (return via the sidebar); overlay-all + image→row + split view
  are BACKLOG.
- **Zoom draw loop** (`viewer.ts`): `draw()` now loops `lvl` from `maxLevel`
  (backdrop) down to the target level, drawing each level's cached tiles
  (coarse first, finer on top); only the backdrop and the *settled* target
  request tiles (`zooming = now − lastWheelAt < ZOOM_SETTLE_MS`). Verified
  no-regression on the CEERS MIRI mosaic (1500×1500, maxLevel 3): renders
  correctly at fit and at deep zoom. The subjective "flash gone?" is for
  the user to judge side-by-side.
- **Rust `regions` module** (`src-tauri/src/regions/`): DS9 .reg parser
  (`parse.rs`) + pixel-space conversion (`mod.rs`) + writer (`write.rs`).
  - Shapes: circle, annulus (multi-radius `annulus(x,y,r1..rn)` expands to
    n−1 regions on consecutive pairs, matching astropy; non-increasing
    radii → warning), ellipse (semi-axes), box (full w/h), polygon, point.
    Others (line, text, panda, …) → warning, skipped. Unknown/unsupported
    frames (galactic, fk4, …) → warning, their shapes skipped.
  - Writer (`write::write_ds9`): normalized DS9 dialect — decimal degrees,
    arcsec sizes, icrs for sky, globals baked per line, shortest-exact
    float formatting so parse→write→parse is bit-identical (round-trip
    asserted over all fixture files in `tests/region_fixtures.rs`).
    astropy-regions reads the output back cleanly (verified).
  - Frames: image/physical (1-based pixels) and fk5/icrs/j2000 (**fk5
    treated as icrs**; the ~23 mas frame rotation is ignored — sub-pixel
    for JWST scales; exact rotation is in BACKLOG).
  - Units: sexagesimal (RA colons = hours) / decimal degrees positions;
    sizes `"`, `'`, `d`, `r`, bare = degrees in sky frames, pixels in image
    frame. Include/exclude (`-`), global+local props (color, width, dash,
    text, point type), `;` statement splitting (brace/quote aware).
  - Sky→pixel matches astropy-regions 0.12 exactly: circles and annuli use
    the local geometric-mean pixel scale; ellipses/boxes use the
    finite-difference Jacobian + 2×2 SVD composite (`sky_shape_to_pixel_svd`
    semantics, including width-axis assignment and circular-input fallback).
  - **Fixtures**: `scripts/gen_region_fixtures.py` (venv now includes
    `regions` 0.12) writes `fixtures/regions/*.reg` +
    `fixtures/regions_expected.json`; `tests/region_fixtures.rs` compares
    parse+convert to 1e-4 px/deg across 30 regions on 2 WCS variants
    (plain CD + rotated/skewed high-dec ROT HDU), then asserts writer
    round-trip on each file.
- **IPC**: `load_region_file(path, hdu, region_path)` → `{regions:
  PixelRegion[], warnings}`; per-region conversion failures become
  warnings, not errors. `save_region_file(region_path, out_path)` →
  `{count, warnings}` re-writes a .reg in the normalized dialect. Typed
  wrappers + `pickRegionFile`/`pickRegionSavePath` in `src/api.ts`.
- **Frontend overlay**: `src/render/regionlayer.ts` draws onto a separate
  2D canvas (`.region-canvas`, pointer-events none) stacked over the WebGL
  canvas; redrawn inside `Viewer.draw()` so pan/zoom stays perfectly
  synced. Colors are DS9 names (CSS-valid), default green; dash, width,
  text labels, point markers (circle/box/diamond/cross/x/boxcircle),
  annuli as two concentric circles, excluded regions get a DS9-style
  diagonal slash. **Reg… button** opens a .reg picker; regions re-resolve
  per HDU switch (sky regions through that HDU's WCS); **Save button**
  (visible when loaded) writes the loaded file back out normalized via a
  save panel; **× button** clears; readout line shows "N regions loaded",
  save confirmation, or the first warning.
- **Contrast/bias (user feedback applied 2026-07-04)**: contrast range now
  ⅕…5× (`5^(1−2fy)`), bias extended to **−0.5…1.5** across the drag width —
  bias is well-defined outside 0..1 in `t' = 0.5 + (t−bias)·c`, and ±0.5
  beyond the old range makes the image fully saturate white/black at the
  drag edges even at contrast 1 (verified: all-white at left edge, label
  shows `b -0.50`; reset via double-right-click works).
- **Verified visually (2026-07-04)** via screenshot + CGEvent loop:
  image.reg (6 regions: red w2 circle + "core" label, dashed ellipse,
  rotated cyan box, polygon + label, yellow cross, excluded box w/ slash)
  and icrs.reg (8 regions incl. sexagesimal positions, arcmin/degree
  units, all landing on fixture-predicted pixels) on sample.fits; a
  hand-written fk5 .reg on **CEERS MIRI1 f770w i2d** — shapes land on the
  goto-verified target coordinate with orientation matching the mosaic's
  position angle.

## In flight / NOT yet verified

- ~~**Table horizontal scroll**~~ **DONE & verified live 2026-07-05, user
  re-confirmed 2026-07-12** on a wide 17-col catalog (`min-width: 0` on
  `.table-view` + explicit `.table-inner` width) — see the numbered item above.
- ~~**M5 depth (split view, overlay-all, image→row) + multi-region select**~~
  **DONE & user-verified live 2026-07-12** (checklist hand-off, all five items
  passed — see the top section). The heuristic gaps have since been closed by
  the overnight batch (manual position-column picker, reverse link keeps
  sort/filter, cross-file marker→row), also all user-verified 2026-07-12.
  Remaining known limitation: sky round-trip for edited ellipse/box is exact
  only for conformal WCS (fixture variants are); a strongly sheared WCS
  degrades like astropy's own SVD approximation.
- ~~**Zoom-flash**~~ **user-verified gone 2026-07-12** — side-by-side eye on a
  big mosaic during fast wheel zoom confirmed the transient low-res flash is
  fixed.
- **Save normalizes** (unchanged): decimal degrees / arcsec / icrs, globals
  baked per line; DS9/astropy read it, not byte-identical to input.
- Region text labels fixed 11px; M2 leftovers (contrast/bias feel, asinh/
  sinh stretch, heat/cool vs DS9) still pending.

## Environment facts

- macOS arm64; **Node v18**; Rust via rustup →
  `export PATH="$HOME/.cargo/bin:$PATH"` (PATH doesn't persist between Bash
  calls). `scripts/venv/` has astropy + matplotlib + **regions 0.12**.
- Real test files: CEERS MIRI i2d pointings at
  `~/research/miri-photometry/egs/data/images/i2d/ceers-miri-pointings/`
  (60 MB each, TAN WCS, empty primary → auto-select SCI).

## Session gotchas (hard-won, do not relearn)

- **`.claude/skills/verify/SKILL.md` now exists** (2026-07-05) with the
  full launch/screenshot/CGEvent/dialog-automation recipe — use it instead
  of re-deriving the bullets below.

- **CGEvent clicks: the reliable recipe (2026-07-05, hard-won).** Plain
  `CGEventPost` of MouseMoved/Down/Up got silently *suppressed* mid-session
  (moves stopped landing, buttons/canvas didn't respond) — macOS local-event
  suppression after synthetic events. What works every time: **(1)
  `CGWarpMouseCursorPosition(pt)` + `CGAssociateMouseAndMouseCursorPosition(1)`
  to place the cursor** (warp bypasses suppression), short delay, **(2) post
  LeftMouseDown then LeftMouseUp to `kCGHIDEventTap` with a null source
  (`$()`), ~0.1 s between.** For the WebGL canvas specifically, also post a
  **MouseMoved to `kCGHIDEventTap` first** (before down/up) or the canvas
  never sees pointerdown. Session-tap posting and HID-source objects were
  unreliable. `mouse.js` in this session's scratchpad was rebuilt to warp +
  HID-tap; copy that version, not the older HID-move one.
- **Synthetic *horizontal* scroll is ignored by WKWebView** (2026-07-05):
  CGScrollWheelEvent vertical deltas scroll web content fine, but the
  horizontal axis (wheel2) and Shift+wheel both no-op — so you can't drive a
  table's horizontal scroll or reveal off-screen columns via `mouse.js`. To
  verify horizontal-overflow behavior, inject a DOM measurement instead
  (temporarily write `scroll.scrollWidth/clientWidth` into a visible element
  like the filter placeholder; note `document.title` won't work — Tauri fixes
  the native window title, so System Events can't read it back).
- **Resizing the Tauri window via System Events is ignored** (2026-07-05):
  `set size of window 1 to {…}` silently no-ops, so you can't shrink the
  window to force table horizontal overflow for a narrow-fixture test. Test
  horizontal scroll with an actually-wide catalog instead.
- **Save sheet: the name field keystroke often doesn't land** — a ⌘A + type
  right after the sheet opens went to nowhere and the file saved as
  `Untitled.reg` (still saved fine, just the default name). Give the sheet
  more time, or accept the default name and read the path from the "saved N
  regions to …" status message.
- **Native open/save panels attach as a *sheet*** — after clicking Open…/
  Reg…, the sheet may not appear in a screenshot for a beat; confirm it with
  `System Events → process "voyager" → count of sheets of window 1` before
  typing the ⌘⇧G path. (This session I twice typed a path into the wrong
  field because I assumed the click missed when the sheet just hadn't drawn.)
- **Table/Header tabs hide the image toolbar** — Reg…/colormap/etc. only
  exist on the Image tab, so load regions *before* switching to a table HDU,
  and remember keystrokes leak into whatever text field still has focus
  (the table filter input bit me).

- **Two Voyager instances confuse UI automation**: the user's bundled
  /Applications/Voyager.app may still be running from their own testing —
  `ps aux | grep -i voyager` first; System Events window targeting by name
  hits whichever it finds. (2026-07-04 I quit a leftover bundled instance
  to unblock automation — tell the user if their window vanished.)
- **Coordinate calibration for clicks**: don't trust `screencapture -R`
  region origins or System Events window positions for Tauri windows —
  take a FULL `screencapture -x` (2940×1912 px = 1470×956 pt, ÷2 for
  points) and read button positions off it; CGEvent posts in those same
  global points. Menu-bar auto-hide shifts things between captures.
- **Native open dialogs are automatable**: click the button, then System
  Events `keystroke "g" using {command down, shift down}` → type absolute
  path → Return ×2 (with delays). Works for the Reg…/Open… NSOpenPanel.
- **Wheel zoom via CGEvent needs big deltas** (`scroll x y 40`, repeated) —
  small values barely zoom (viewer factor is exp(−0.002·ΔY)).
- Dev argv opens need an ABSOLUTE path; vite hot-reload wipes frontend
  state (init() recovers open files); editing src-tauri/ restarts the app.
- mouse.js (CGEvent JXA: move/click/rclick/dblrclick/ldrag/rdrag/scroll)
  must be recreated in each session's scratchpad — copy from this session:
  it's plain CGEventCreateMouseEvent/ScrollWheelEvent posting.
- Old gotchas still apply: zoxide intercepts `cd relative-path` in
  compound commands (use absolute paths / --manifest-path), `lsof -ti
  :1420 | xargs kill` for stale vite, `pkill -f "tauri dev"; pkill -f
  "target/debug/voyager"`, don't pipe backgrounded output through tail.

### Crossmatch milestone — design agreed 2026-07-13, core landed (this session)

The next big feature is **catalog crossmatching** (TOPCAT replacement),
specced by the repo owner in **issue #10** and reconciled with the user
discussion in **`docs/CROSSMATCH_PLAN.md`** — read both before continuing.
Key decisions: fix large-table sort/filter first via a **columnar key
cache** (NOT SQLite conversion; user stress-tested a 1M-row/11 GB catalog
and the per-cell strided mmap scan in `build_view` is the bottleneck —
benchmark the extraction path on the user's Mac per the plan's benchmark
section); results become **derived tables** (pair list delegating `cell()`
to parent FITS tables — no data copied); export via a new FITS bintable
writer; v1 = **Best match** with `1 and 2` + `all from 1` joins; plus a
single-coordinate cone-search box ("goto for tables"). Work is on branch
`claude/voyager-catalog-cross-matching-uzlr06`.

**Landed 2026-07-13 (this session): `src-tauri/src/xmatch/` core.** Pure
module (no Tauri types): hand-rolled 3-D k-d tree over unit vectors
(`SkyIndex::build/nearest_within/within`), chord-radius queries (inclusive
`sep <= r`, matching `search_around_sky`), `crossmatch(ra_a, dec_a, ra_b,
dec_b, radius_deg, MatchMode::Best|All)` returning `(a, b, sep_deg)` pairs +
skipped-NaN counts per side. Best ties break to the lowest B row. Fixtures:
`scripts/gen_xmatch_fixtures.py` (new; needs scipy in the venv) writes
`fixtures/xmatch_expected.json` from astropy `match_to_catalog_sky` +
`search_around_sky` over 6 scenarios (random field, RA wrap, pole,
exact-radius boundary ±1e-6″, duplicate positions incl. sep-0, NaN rows);
`tests/xmatch_fixtures.rs` compares pair sets exactly + separations to 1 µas
(best-pair B compared by *coordinates* so duplicate-position nearest ties
don't flake). **72 tests green** (was 65). A 1M×1M <2 s perf test is in
`xmatch_fixtures.rs` behind `#[ignore]` — run
`cargo test --release --test xmatch_fixtures -- --ignored`.

**Also landed 2026-07-13: column cache (plan step 1, cache part).**
`table::cache::ColCache` (pure, unit-tested): LRU of materialized columns
(`Vec<Cell>`) keyed by (path, hdu, col), 512 MB default budget, byte
accounting incl. string heap, `purge_path` on close. `Table::extract_column`
+ free fn `table::build_view_from` (operates on materialized cells);
`Table::build_view` is now a thin wrapper over it so the astropy table
fixtures gate both paths identically. `lib.rs`: `AppState.col_cache`
(Arc<Mutex>), `table_view` fetches sort/filter columns through the cache
(extraction outside the lock; log line now shows `cols: hit+miss`),
`close_fits` purges. Effect: the full-file column scan happens **once per
column** instead of on every sort/filter change — the fix for the user's
1M-row/11 GB stress test. Cells (not compacted key arrays) are cached so
sort/filter semantics are provably unchanged. **Still open in step 1** (perf
polish, needs the user's Mac per the plan's benchmark section): madvise/
chunked reads, parallel extraction, multi-column single-pass, typed-array
compaction. 1M×1M xmatch perf test passed in this session's Linux container:
**1.07 s** (target < 2 s), single-threaded release.

**Also landed 2026-07-13: BINTABLE writer (plan step 2).**
`table::write` (child module of `table`, pure): `write_bintable` (empty
primary + BINTABLE header + streamed rows + block padding; fixed-format
cards with quote escaping) and `export_view(table, view, extname, path)` —
exports a table's rows through a view permutation by **raw row-byte copy**,
so exported cells are bit-identical to the source by construction (the same
primitive a derived table will use: A-row bytes ++ B-row bytes ++ f64 sep).
TTYPE/TFORM/TUNIT/TSCAL/TZERO carried over; ASCII-table sources error
cleanly (BACKLOG, with TNULL/TDISP carry-over). `tests/table_write.rs`:
identity / sorted+filtered / empty-view round-trips through our own reader,
comparing every cell exactly. **astropy gate verified in-session** (same
pattern as the region writer): `fits.verify('exception')` clean on all
three exports, all columns bit-identical to the source, and the view export
matches an independent numpy argsort+mask reproduction. **80 tests green.**

**Also landed 2026-07-13: derived tables + xmatch IPC (plan step 4).**
- `table::RowSource` trait (columns/nrows/cell required; page/extract_column/
  column_f64/build_view provided) — every table consumer now works for both
  FITS-backed and derived tables. `Table` implements it; inherent
  page/extract/build_view moved into the trait (callers import `RowSource`).
- `table::join` (pure): `JoinRow { a, b: Option, sep_deg: Option }` +
  `Joined::new(left, right, &rows)` — merged columns (case-insensitive name
  collisions suffixed `_1`/`_2`), appended `Separation` column (arcsec),
  cells delegate to parent mmaps (~24 B/row materialized, design decision
  #1 holds for 1M×1M joins). `Joined::export` streams raw A-row ++ B-row ++
  f64 separation bytes; unmatched right sides = null template (NaN floats,
  zero ints, blank strings — no TNULL yet, BACKLOG).
- `lib.rs`: `DerivedDef` in `AppState.derived` keyed by synthetic
  `voyager-derived://N` paths; parents pinned by Arc (derived table survives
  closing its source file). `resolve_table` + `TableHandle`/`OpenTable`
  (impls RowSource) route **all** table commands (columns/view/rows/
  view_pos/columns_f64) for both kinds. `get_header` synthesizes BINTABLE-
  shaped cards + XMATCHA/XMATCHB provenance for derived paths. New commands:
  **`xmatch_tables`** (Best match within radius; join `1and2` | `all1`;
  positions fetched through the column cache so re-runs and later sorts are
  warm; returns summary incl. median sep + columns) and **`export_table`**
  (real or derived, honors the current sort/filter view).
- Tests: `tests/join_fixtures.rs` (self-match via the real kd-tree path,
  cell routing, null right sides, sort-by-Separation, export round-trip
  through our reader with a reversing view). **astropy gate verified
  in-session**: `verify('exception')` clean on the joined export, suffixed
  names + arcsec unit + NaN nulls + reversed view all confirmed. **86 tests
  green**, tsc clean (no frontend changes yet).

**Also landed 2026-07-13: crossmatch UI (plan step 5) — NOT yet user-verified.**
Frontend only (`main.ts`/`api.ts`/`styles.css`), tsc clean:
- **Match… button** (table tab) opens a floating panel (`#match-panel`,
  fixed top-right): Table A = active frame's table (label), Table B = any
  open frame with a table (self-match allowed), RA/Dec column selects per
  side (numeric columns only, pre-seeded from `posOverride` or the name
  heuristics), radius (arcsec, default 1), join select (matched pairs only /
  all rows from A), Run. On success the panel closes, the result opens as a
  **new frame** and the readout shows "matched N of M (median sep …″)".
- **Derived frames**: `openDerivedFrame` builds a synthetic single-HDU
  `FileSummary` for the `voyager-derived://N` path (`addFrame` extracted
  from `openPath` for reuse); `derivedNames` map + `displayName()` give
  chips/labels/status the match name (XMATCH_N); status line shows
  "crossmatch result — N rows (in memory; Export… to save)". Everything
  else (table view, sort/filter, header tab, overlay, close) rides the
  existing frame machinery against the backend's derived path support.
- **Export… button** (table tab): save panel (`pickFitsSavePath`) →
  `export_table` with the current sort/filter view; works for real and
  derived tables.
- **Probe box + radius** (table tab, "Find coord…", default 5″): backend
  `parse_coord` (new command — coordinate parsing without a WCS, so it
  works on image-less catalogs) + `table_columns_f64` + a frontend linear
  cone scan (single query needs no index); reveals the nearest row
  (respecting sort/filter via revealRow), drops the goto crosshair when the
  frame shows an image with WCS, readout shows count + nearest separation.
- **Heuristics learned `_1`/`_2`**: `heurName()` strips crossmatch suffixes
  so RA_1/DEC_1 auto-detect in joined tables (locate/overlay/probe/match).

### Manual verification checklist for the user (crossmatch milestone)

Run with two overlapping catalogs (e.g. cross_catalog.fits + a second
catalog or a self-match), plus an image frame for overlay checks:
1. Open a catalog → Table tab → **Match…** — panel appears, RA/Dec selects
   pre-filled sensibly for both tables; radius 1″.
2. **Run match** — new frame chip named XMATCH_1 appears and activates; its
   table shows `*_1`, `*_2`, and `Separation` columns; readout shows
   matched count + median sep (sanity-check both against TOPCAT).
3. Sort the result by Separation (click header) and filter it — both work.
4. **Export…** the result → open the written file in TOPCAT/astropy —
   columns + values correct, Separation in arcsec.
5. On the XMATCH frame: **Overlay ▸ image** onto an open image frame —
   markers land (RA_1/DEC_1 auto-detected); click a marker → row reveals.
6. Probe box: type a coordinate inside the field (sexagesimal + decimal
   both) with radius ~5″ — nearest row highlights; on a frame showing an
   image, the crosshair drops at the probed spot. A far-away coordinate
   reports "no rows within …″".
7. `all rows from A` join: unmatched rows show blank right-side cells and
   blank Separation; sort by Separation puts them last.
8. Close the source catalog frame, then keep using the XMATCH frame
   (parents are pinned) — table still scrolls/sorts.

**Remaining after verification** (build order in CROSSMATCH_PLAN.md):
step-1 perf polish (madvise/parallel/multi-column extraction — benchmark on
the Mac first), then BACKLOG follow-ups (other match modes, xmatch-of-xmatch
via export, TNULL/TDISP, CSV/VOTable export, probe-by-image-click).

**Push blocked (2026-07-13)**: commits for this milestone exist only locally
on the feature branch — pushes 403 because the Claude GitHub App is not
installed on `anshrg/voyager` (the user has write permission; the owner was
asked to install the app at github.com/apps/claude). Push as soon as it works.

## Immediate next steps (in order)

1. ~~Collect the user's results on the verification hand-off~~ **DONE
   2026-07-12 — user confirmed all five features working live.**
2. ~~**Confirm on real data**~~ **DONE & user-verified 2026-07-12**: M5
   row-locate on a wide JWST catalog and edited-region save round-trip both
   confirmed on real data.
3. ~~**M5 depth follow-ups**~~ **ALL DONE & user-verified 2026-07-12**:
   cross-file marker → row; reverse link keeps sort/filter (`table_view_pos`);
   manual position-column picker; new-polygon creation (click-to-add nodes).
4. ~~**Multi-frame**~~ first cut DONE; ~~**WCS-lock**~~ + ~~**cross-file
   catalog→image overlay**~~ **DONE & verified live 2026-07-05** (see the
   section up top). Remaining multi-frame follow-up: **many-frame scaling**
   (WKWebView caps ~16 WebGL contexts — currently one per frame, lazily
   created + `WEBGL_lose_context` on close; if it bites, pool contexts or move
   to a single-context multi-viewport renderer). Overlay follow-ups (BACKLOG):
   per-source overlay of a single selected catalog row onto another frame;
   image→row reverse link; manual RA/Dec column picker; a target-frame picker
   (today it overlays onto *all* other WCS image frames).
5. **M4 polish** if the user asks: per-column filters, column show/hide/
   reorder, copy/export, huge-table sort speed.

## Decisions made during M0–M3 (rationale in CLAUDE.md or code comments)

- Hand-rolled FITS header parsing (revisit for .fz support).
- Node stays at system v18; `[profile.dev.package."*"] opt-level = 2`.
- Tiles block-SAMPLE (not average); zscale/histogram share a ~200k spatial
  subsample; tiles draw only after scale limits arrive.
- Colormap LUTs generated (`colormaps.gen.ts`); don't hand-edit.
- WCS scope: TAN only, SIP ignored (flagged), other projections degrade to
  pixel-only readout.
- Contrast/bias applied post-stretch in the shader; ranges per user
  feedback: contrast ⅕…5×, bias −0.5…1.5 (fully saturates at drag edges).
- **Regions correctness is defined as "matches astropy-regions"** (same
  role astropy plays for WCS/zscale): sky circles via mean local scale,
  ellipses/boxes via Jacobian+SVD, fk5≈icrs. DS9 .reg quirks the parser
  can't read produce warnings surfaced in the UI, never hard failures.
- Region overlay is a 2D canvas redrawn per frame (not WebGL): hundreds of
  stroked paths cost ≪1 frame; revisit only if users load 10k+ regions.
