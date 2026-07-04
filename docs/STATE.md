# DS10 — Living State Document

> **For every Claude session**: read this first (after CLAUDE.md); update it
> before you finish any significant work. Keep it **current-state only** —
> history lives in `git log`. New feature ideas go to `BACKLOG.md`, durable
> decisions with rationale to `CLAUDE.md`.

## Current milestone: M0 — skeleton + FITS open spike (~90% done)

M0 remaining: (1) verify the app end-to-end visually, (2) get real user FITS
files, (3) then start M1 (tiled WebGL image rendering — see CLAUDE.md roadmap).

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

## In flight / NOT yet verified

- **End-to-end UI check**: nobody has *seen* the app render a file yet.
  Previous session couldn't screenshot: terminal lacked Screen Recording
  permission (screencapture silently returns wallpaper-only) and osascript
  lacked Accessibility. **User has now granted both** (effective after
  terminal restart) — so: launch app, `screencapture -x shot.png`, Read the
  png, confirm HDU list + header cards render, argv-opened file appears.
- An `eprintln!` was just added to `open_fits` in `lib.rs` (logs path/HDUs/ms
  to stderr) to verify the frontend→backend IPC loop from process output.
  Not yet compiled/run. Keep or remove after verification, either is fine.
- File association (double-click .fits in Finder) is declared in
  `tauri.conf.json` but only works in a **bundled** app (`npm run tauri build`,
  then open the .app once to register with LaunchServices). Untested.
- Dialog open (⌘O) untested end-to-end (needs a human or the screenshot loop).

## Environment facts

- macOS arm64; **Node v18** (system); Rust via rustup →
  `export PATH="$HOME/.cargo/bin:$PATH"` before any cargo command (PATH does
  not persist between Bash calls).
- **Disk is critically low: ~1.6 GiB free of 926 GiB.** Blocked creating a
  2 GB benchmark file (used 500 MB instead, since deleted). Debug+release
  cargo target dirs consume several GB — `cargo clean` frees space if
  desperate, at the cost of a ~5 min rebuild. User should clear space.
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

## Immediate next steps (in order)

1. Relaunch app (`npx tauri dev -- -- $PWD/fixtures/sample.fits`), screenshot
   (permissions now granted), confirm UI renders HDUs/header correctly; check
   stderr shows the `[ds10] open_fits` line.
2. `npm run tauri build`; open the bundled .app; test double-clicking a .fits
   in Finder routes into the app (M0 exit criterion).
3. Get real FITS files from the user; run bench_open + the app on them; note
   any parser failures here.
4. Update this file + commit; declare M0 done.
5. M1 kickoff (per CLAUDE.md): Rust tile server (cutouts + downsample levels,
   binary IPC via `tauri::ipc::Response`), WebGL2 canvas with pan/zoom,
   zscale/stretch/colormap shaders. fitsgl (see CLAUDE.md §5) is the design
   reference — no code copying (unlicensed).

## Decisions made during M0 (rationale in CLAUDE.md)

- Hand-rolled FITS header parsing instead of `fitsrs`; revisit only when
  compressed FITS (`.fz`) support is needed.
- Node stays at system v18; don't upgrade casually.
- `[profile.dev.package."*"] opt-level = 2` in Cargo.toml so dev builds stay
  usable on real data.
