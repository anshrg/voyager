# DS10 — Living State Document

> **For every Claude session**: read this first (after CLAUDE.md); update it
> before you finish any significant work. Keep it **current-state only** —
> history lives in `git log`. New feature ideas go to `BACKLOG.md`, durable
> decisions with rationale to `CLAUDE.md`.

## Current milestone: M0 — **DONE** (2026-07-03). Next: M1 kickoff.

All exit criteria verified: UI render, IPC, bundled-app file-open routing,
and real-file validation (see below). M1 = tiled WebGL image rendering
(see CLAUDE.md roadmap + step list at bottom).

## What works (verified)

- **Rust `fits` module** (`src-tauri/src/fits/mod.rs`): hand-rolled header
  parser (typed card values, D-exponents, escaped quotes), HDU enumeration
  (image/bintable/asciitable, PCOUNT/GCOUNT sizing), mmap-backed open,
  `pixel_value()` with BSCALE/BZERO. Pure module, no Tauri types.
- **All tests green**: 5 unit tests + 2 astropy ground-truth fixture tests
  (`cd src-tauri && cargo test`). Structure and pixel values match astropy.
- **Fixture harness**: `scripts/venv/` (has astropy) +
  `scripts/gen_fixtures.py` → `fixtures/sample.fits` + `expected.json`
  (committed). Rust side: `src-tauri/tests/fixtures.rs`.
- **Benchmark** (`cargo run --release --example bench_open -- <file>`):
  500 MB float32 image opens in **23 ms**, spot pixel reads 0.3 ms
  (target < 50 ms; open time is size-independent thanks to mmap).
- **TS frontend compiles strict** (`npx tsc --noEmit`): dark UI shell, HDU
  sidebar, header-card table with filter box, ⌘O open dialog, status bar
  showing open-time. `src/api.ts` = typed IPC wrappers; `src/main.ts` = UI.
- **App launches**: `npx tauri dev -- -- /abs/path/file.fits` runs, window
  created onscreen (confirmed via CGWindowList), vite on :1420.
- **End-to-end UI verified visually (2026-07-03)**: screenshot loop works now
  (Screen Recording + Accessibility granted). Confirmed: argv-opened fixture
  renders 3 HDUs in sidebar (PRIMARY/SCI/CATALOG with dims + BITPIX), header
  card table with typed values (escaped quote `O'NEILL FIELD`, D-exponent CD
  values), status bar shows path/size/HDU count/open-ms. Clicking an HDU via
  `osascript … click at {x,y}` switches the header table correctly. stderr
  shows `[ds10] open_fits … 3 HDUs in 11.3 ms` (IPC loop verified; the
  eprintln in `open_fits` was kept — it's a useful log line).

- **Real-file validation (2026-07-03)** — user's three representative files,
  all parse and render correctly in bench_open **and** the bundled app:
  - `/Volumes/Extreme SSD/data/primer-uds/images/primeruds_nrc_f444w_sci.fits`
    — 5.0 GiB, single 41800×32000 float32 SCI HDU. Open: 28.5 ms cold from
    external SSD / 0.4 ms warm. Corner spot-read is NaN (blank coverage —
    expected; M1 shaders must handle NaN).
  - `~/research/miri-photometry/egs/data/images/i2d/ceers-miri-pointings/`
    `ceers_miri1_f770w_i2d.fits` — 63 MB JWST i2d, 10 HDUs (empty primary,
    SCI/ERR/CON/WHT/VAR_*, HDRTAB bintable 3×409 cols, ASDF). This is the
    "typical image" shape to optimize UX for (auto-select SCI, not primary?).
  - `/Volumes/Extreme SSD/data/euclid/catalogs/dawn-v1_7/edfn_dawn_catalog_dr1_v1.7_lp.fits`
    — 29.6 GiB bintable, **26,965,827 rows × 157 cols**. Open: 126.7 ms cold
    / 0.7 ms warm. This is the M4 table-viewer stress target; 1M-row sort
    target will need rethinking at 27M rows (chunked/lazy column reads).
  - External-drive caveat: opens only touch header blocks so the cable
    doesn't matter for open-time; it WILL matter for M1 full-res pixel
    streaming (copy a big file to internal disk when benchmarking M1).
- **Bundled app + Apple Events open verified (2026-07-03)**: `npm run tauri
  build` produced DS10.app + DMG; registered via `lsregister -f`. Both
  `open -a DS10 file.fits` at launch (opened in 5.3 ms) and opening a second
  file into the **running** instance (17.2 ms, status bar updates) work —
  the `RunEvent::Opened` → `dispatch_open` plumbing is correct end-to-end.

## In flight / NOT yet verified

- Plain `open file.fits` / Finder double-click does NOT reach DS10 on this
  machine because the user's default .fits handler is a personal Automator
  app (`com.apple.automator.fits2topcat` per LSHandlers). Not a DS10 bug —
  DS10 claims the type correctly. User decides if/when to flip the default
  (right-click → Get Info → Open with → Change All, or wait until DS10
  replaces the TOPCAT workflow).
- Dialog open (⌘O) untested end-to-end (needs a human).

## Environment facts

- macOS arm64; **Node v18** (system); Rust via rustup →
  `export PATH="$HOME/.cargo/bin:$PATH"` before any cargo command (PATH does
  not persist between Bash calls).
- Disk space recovered: **63 GiB free** as of 2026-07-03 (was 1.6 GiB — user
  cleared space). Big benchmark files are OK to create again (delete after).
- Regenerate a benchmark file with the inline python snippet in git history,
  or: any big local FITS. **Ask the user for 2–3 representative real FITS
  files (largest image, typical image, big catalog table) — still not done.**

## Session gotchas (hard-won, do not relearn)

- `cd` in compound Bash commands gets intercepted by zoxide when the target
  doesn't exist relative to cwd; cwd persists between calls. Prefer absolute
  paths.
- Backgrounded commands piped to `tail` buffer everything until exit — you
  see nothing while it runs. Redirect to a file or drop the pipe.
- Kill dev app with `pkill -f "tauri dev"; pkill -f "target/debug/ds10"`.
- `tsconfig` needs `lib: ES2022` (done) — v18-era default was too old for
  `Array.at`.
- Tauri argv passthrough that works: `npx tauri dev -- -- <abs-path>`.
- Screenshot loop that works: `screencapture -x shot.png` + Read the png;
  UI clicks via `osascript -e 'tell app "System Events" to tell process
  "ds10" to click at {x, y}'` (coords = screen points ≈ retina px / 2).
- Don't `open` the .app while `tauri build` is still in its DMG-bundling
  phase — bundle_dmg.sh has the app mounted/busy and results are confusing.
- Stale vite on :1420 from a dead session blocks `tauri dev`
  (`Error: Port 1420 is already in use`) — `lsof -ti :1420 | xargs kill`.

## Immediate next steps (in order)

1. M1 kickoff (per CLAUDE.md): Rust tile server (cutouts + downsample levels,
   binary IPC via `tauri::ipc::Response`), WebGL2 canvas with pan/zoom,
   zscale/stretch/colormap shaders. fitsgl (see CLAUDE.md §5) is the design
   reference — no code copying (unlicensed). Bench against the PRIMER 5 GiB
   image (copy to internal disk first — external cable will skew streaming
   numbers). Shaders must handle NaN pixels (blank mosaic coverage).
2. M1 UX detail from real files: JWST i2d files open on an EMPTY primary
   HDU — auto-select the first image HDU with data (usually SCI).

## Decisions made during M0 (rationale in CLAUDE.md)

- Hand-rolled FITS header parsing instead of `fitsrs`; revisit only when
  compressed FITS (`.fz`) support is needed.
- Node stays at system v18; don't upgrade casually.
- `[profile.dev.package."*"] opt-level = 2` in Cargo.toml so dev builds stay
  usable on real data.
