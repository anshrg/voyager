# DS10 — Living State Document

> **For every Claude session**: read this first (after CLAUDE.md); update it
> before you finish any significant work. Keep it **current-state only** —
> history lives in `git log`. New feature ideas go to `BACKLOG.md`, durable
> decisions with rationale to `CLAUDE.md`.

## Current milestone: M3 (DS9 regions) — **load/display DONE** (2026-07-04). Next: user acceptance, region save/edit later.

M2 accepted by user 2026-07-04 with contrast/bias tweaks (applied, see
below). M3 first pass delivered the same day: DS9 .reg parsing in Rust
(fixture-tested against the astropy `regions` package), sky→pixel
conversion through the WCS module, canvas overlay rendering, and a Reg…
toolbar button. Verified live on the fixture file and a CEERS MIRI i2d.
**Changes are uncommitted — commit when the user is happy with M3.**

## What works (verified)

- **Rust `fits`/`tiles`/`wcs` modules**: unchanged from M0–M2 (header parse,
  mmap open, sampled tiles, zscale/minmax/histogram, TAN WCS ±swap/rot/
  CROTA2, sexagesimal parse/format). 47 tests green
  (`cd src-tauri && cargo test`).
- **Rust `regions` module** (`src-tauri/src/regions/`): DS9 .reg parser
  (`parse.rs`) + pixel-space conversion (`mod.rs`).
  - Shapes: circle, ellipse (semi-axes), box (full w/h), polygon, point.
    Others (annulus, line, text, …) → warning, skipped. Unknown/unsupported
    frames (galactic, fk4, …) → warning, their shapes skipped.
  - Frames: image/physical (1-based pixels) and fk5/icrs/j2000 (**fk5
    treated as icrs**; the ~23 mas frame rotation is ignored — sub-pixel
    for JWST scales; exact rotation is in BACKLOG).
  - Units: sexagesimal (RA colons = hours) / decimal degrees positions;
    sizes `"`, `'`, `d`, `r`, bare = degrees in sky frames, pixels in image
    frame. Include/exclude (`-`), global+local props (color, width, dash,
    text, point type), `;` statement splitting (brace/quote aware).
  - Sky→pixel matches astropy-regions 0.12 exactly: circles use the local
    geometric-mean pixel scale; ellipses/boxes use the finite-difference
    Jacobian + 2×2 SVD composite (`sky_shape_to_pixel_svd` semantics,
    including the width-axis assignment and circular-input fallback).
  - **Fixtures**: `scripts/gen_region_fixtures.py` (venv now includes
    `regions` 0.12) writes `fixtures/regions/*.reg` +
    `fixtures/regions_expected.json`; `tests/region_fixtures.rs` compares
    parse+convert to 1e-4 px/deg across 25 regions on 2 WCS variants
    (plain CD + rotated/skewed high-dec ROT HDU).
- **IPC**: `load_region_file(path, hdu, region_path)` → `{regions:
  PixelRegion[], warnings}`; per-region conversion failures become
  warnings, not errors. Typed wrapper + `pickRegionFile` in `src/api.ts`.
- **Frontend overlay**: `src/render/regionlayer.ts` draws onto a separate
  2D canvas (`.region-canvas`, pointer-events none) stacked over the WebGL
  canvas; redrawn inside `Viewer.draw()` so pan/zoom stays perfectly
  synced. Colors are DS9 names (CSS-valid), default green; dash, width,
  text labels, point markers (circle/box/diamond/cross/x/boxcircle),
  excluded regions get a DS9-style diagonal slash. **Reg… button** opens a
  .reg picker; regions re-resolve per HDU switch (sky regions through that
  HDU's WCS); **× button** (visible when loaded) clears; readout line shows
  "N regions loaded" or the first warning.
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

- **M3 user acceptance pending**: try real DS9 region files from your
  workflow (weird syntax variants welcome — parser warns instead of
  failing; tell me what it warns about). Region *saving*, editing/dragging,
  and annulus etc. are not implemented yet (BACKLOG).
- Region text labels use a fixed 11px font; may be small on retina — say
  if you want them bigger.
- From M2, still pending: contrast/bias *feel* at the new ranges vs DS9;
  M1 leftovers (asinh/sinh stretch, heat/cool side-by-side vs DS9).
- Zoom-burst tile over-fetch / low-res flash (BACKLOG) still open.

## Environment facts

- macOS arm64; **Node v18**; Rust via rustup →
  `export PATH="$HOME/.cargo/bin:$PATH"` (PATH doesn't persist between Bash
  calls). `scripts/venv/` has astropy + matplotlib + **regions 0.12**.
- Real test files: CEERS MIRI i2d pointings at
  `~/research/miri-photometry/egs/data/images/i2d/ceers-miri-pointings/`
  (60 MB each, TAN WCS, empty primary → auto-select SCI).

## Session gotchas (hard-won, do not relearn)

- **Two DS10 instances confuse UI automation**: the user's bundled
  /Applications/DS10.app may still be running from their own testing —
  `ps aux | grep -i ds10` first; System Events window targeting by name
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
  "target/debug/ds10"`, don't pipe backgrounded output through tail.

## Immediate next steps (in order)

1. **User acceptance on M3 regions**: load your real .reg files (image and
   sky flavors) on JWST mosaics, compare overlay against DS9 side-by-side;
   check the new contrast/bias range feel (⅕–5×, extended bias) and the
   M1/M2 leftovers (asinh, heat/cool, goto feel).
2. **Commit M2-polish + M3 work** once accepted (currently uncommitted).
3. **M3 remainder**: region save (write .reg back out), then possibly
   annulus + basic region selection/hover info. Scope per user priorities.
4. Zoom-burst tile over-fetch / low-res flash fix (BACKLOG has details) —
   user-confirmed annoyance, good candidate after M3 acceptance.
5. **Multi-frame** (user request 2026-07-04, in BACKLOG): tabs/blink +
   tiled layouts with per-frame view state — needs a milestone slot
   decision (after M3 or alongside M5 linking).

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
