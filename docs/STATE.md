# DS10 — Living State Document

> **For every Claude session**: read this first (after CLAUDE.md); update it
> before you finish any significant work. Keep it **current-state only** —
> history lives in `git log`. New feature ideas go to `BACKLOG.md`, durable
> decisions with rationale to `CLAUDE.md`.

## Current milestone: M2 (navigation) — **core DONE** (2026-07-04). Next: user acceptance, then M3 (DS9 regions).

M2 delivered and verified: WCS (TAN) sky readout, goto-coordinate box with
crosshair flash, histogram panel with draggable scale limits, plus the
user-requested right-drag contrast/bias adjustment. Verified live on the
fixture and on a real CEERS MIRI i2d — DS10's sexagesimal readout matches
astropy exactly at the same pixel.

## What works (verified)

- **Rust `fits` module** (`src-tauri/src/fits/mod.rs`): header parser, HDU
  enumeration, mmap-backed open. Unchanged from M0/M1.
- **Rust `tiles` module**: 256×256 f32 sampled tiles, zscale/minmax (astropy
  exact on small images), `histogram` (numpy semantics, fixture-tested).
- **Rust `wcs` module** (`src-tauri/src/wcs/`): TAN pix↔world matching
  astropy `wcs_pix2world`/`wcs_world2pix` to 1e-6 across four fixture
  variants: plain CD, rotated+skewed CD, legacy CDELT+CROTA2, and swapped
  axes (CTYPE1=DEC--TAN). Handles PC+CDELT, LONPOLE, either axis order.
  `RA---TAN-SIP` accepted with distortion IGNORED (`sip_ignored` flag;
  backlog). Non-TAN → None → UI falls back to pixel-only readout.
  `wcs::coords`: sexagesimal formatting (carry-safe rounding) and parsing
  (decimal deg, colon/hms/dms, 6-token, RA hours vs 'd'-degrees) —
  unit-tested. **28 tests green** (`cd src-tauri && cargo test`).
- **IPC**: `get_readout` (replaces `get_pixel`: value + ra/dec deg +
  formatted sky string), `resolve_coord(query)` → fractional pixel with
  user-facing error strings, `get_histogram(bins)` (async spawn_blocking,
  same ~200k spatial sample as scale limits, range = sample min..max).
- **Frontend**:
  - Status-bar readout now appends sexagesimal α δ when the HDU has WCS
    (keeps last sky string while a readout is in flight, no flicker).
  - **Goto box** in the toolbar (placeholder "goto α δ"): Enter → centers at
    the target pixel keeping zoom + orange crosshair pulse; parse/WCS errors
    show red border + message in the readout area.
  - **Hist button** toggles a bottom-left overlay panel (`src/render/
    histogram.ts`): 200-bin log-count bars, orange lo/hi handles, drag =
    live `viewer.setLimits` (shader uniform, one frame); shading outside
    limits; lazy per-HDU load, syncs when scale mode changes.
  - **Right-drag contrast/bias** (user request): horizontal = bias 0..1,
    vertical = contrast 2^(2(1−2y)) (¼…4×, 1 at mid-height), DS9-ish
    `t' = 0.5 + (t − bias)·contrast` applied post-stretch in the shader.
    Double-right-click resets; "b … c …" indicator in the toolbar when
    non-default; resets on HDU switch. Left-button-only pan (right button
    no longer pans).
- **Verified visually (2026-07-04)** via screenshot loop + CGEvent input:
  fixture sky readout exact at/off CRPIX; goto by decimal degrees lands on
  the exact corner pixel; goto by sexagesimal on **real CEERS MIRI i2d**
  (10 HDUs, auto-selected SCI) → readout `14:20:40.142 +53:02:58.77` ==
  astropy `14:20:40.142 +53:02:58.772` at the same pixel; parse-error path;
  histogram drag updates limits label live; contrast/bias drag + reset;
  SCI (no WCS) shows pixel-only readout and per-HDU histogram reload.

## In flight / NOT yet verified

- **M2 user acceptance pending**: goto input forms feel, contrast/bias drag
  *feel* vs DS9 (mapping is a guess — see BACKLOG), histogram usability.
- ROT/ROTA/SWAP WCS variants are fixture-tested but not eyeballed on real
  rotated images; SIP files show slightly wrong coords by design (ignored
  distortion) — worst on non-drizzled cal frames.
- From M1, still pending user side-by-side vs DS9: asinh/sinh stretches,
  heat/cool colormaps.
- Finder default-handler situation unchanged (user's Automator app owns
  .fits; `open -a DS10` works). Dialog open verified by user via **Ctrl+O**
  (⌘O is taken by something else on their system — keep both bindings).

## Environment facts

- macOS arm64; **Node v18**; Rust via rustup →
  `export PATH="$HOME/.cargo/bin:$PATH"` (PATH doesn't persist between Bash
  calls). `scripts/venv/` has astropy + matplotlib.
- Real test files: CEERS MIRI i2d pointings at
  `~/research/miri-photometry/egs/data/images/i2d/ceers-miri-pointings/`
  (60 MB each, TAN WCS, empty primary → auto-select SCI).

## Session gotchas (hard-won, do not relearn)

- **Dev argv opens need an ABSOLUTE path**: `npm run tauri dev -- -- file`
  runs the binary with cwd = `src-tauri/`, so relative paths fail with
  "No such file or directory" in the status bar.
- **vite hot-reload wipes frontend state** in dev; init() recovers open
  files via `list_open_files`. Editing src-tauri/ restarts the app (argv
  file re-opens); editing src/ only reloads the page.
- **UI automation**: CGEvent JXA helper (scratchpad `mouse.js`, recreated
  this session with move/click/rclick/dblrclick/ldrag/rdrag/scroll) — only
  way to get real pointermove/wheel/right-button events into WebKit.
  Screen points = retina px / 2. `screencapture -R x,y,w,h` crops in points
  (status bar crop: `-R 500,925,970,30` at the current window size).
  Text inputs: click, then System Events `keystroke` + `key code 36`.
- Old gotchas still apply: zoxide cd quirk, `lsof -ti :1420 | xargs kill`
  for stale vite, `pkill -f "tauri dev"; pkill -f "target/debug/ds10"`,
  don't pipe backgrounded output through tail.

## Immediate next steps (in order)

1. **User acceptance pass on M2**: try goto with your preferred coordinate
   formats, drag the histogram handles on a real image, judge the
   contrast/bias drag feel vs DS9 (mapping is adjustable — see BACKLOG),
   and spot-check readout coords against DS9 on a JWST field. Plus the M1
   leftovers: asinh stretch + heat/cool side-by-side.
2. **M3 kickoff (DS9 regions)**: region file parser (pure Rust,
   fixture-tested against DS9/astropy-regions semantics), circle/box/
   ellipse/polygon/point first, WCS + image coordinate flavors, overlay
   rendering in the viewer, load/save.
3. Zoom-burst tile over-fetch / low-res flash (user-confirmed annoyance):
   debounce target-level fetches + keep previous-level tiles until the new
   level covers the view (BACKLOG item has details).

## Decisions made during M0–M2 (rationale in CLAUDE.md or code comments)

- Hand-rolled FITS header parsing (revisit for .fz support).
- Node stays at system v18; `[profile.dev.package."*"] opt-level = 2`.
- Tiles block-SAMPLE (not average) — matches DS9 default; averaging parked.
- zscale on huge images uses a ~200k spatial subsample (exact on small
  images — that's what fixtures pin down); histogram reuses the same
  sample and its min..max as the range.
- Tiles draw only after scale limits arrive (no wrong-stretch flash).
- Colormap LUTs are generated (`colormaps.gen.ts`); don't hand-edit.
- WCS scope: TAN only, SIP ignored (flagged), no distortion tables; other
  projections cleanly degrade to pixel-only readout rather than guessing.
- Contrast/bias applied to the *stretched* value in the shader (cheap,
  order matches DS9's colormap-manipulation model closely enough; exact
  DS9 LUT math is a backlog item if side-by-side looks off).
