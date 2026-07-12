# Voyager — A fast, modern replacement for DS9 + TOPCAT

## Context

The user (an astronomer, non-expert in app development) wants a single desktop tool replacing their daily use of **DS9** (FITS image viewing, regions) and **TOPCAT** (tabular data, crossmatching). Motivations:

1. **Performance**: DS9 lags badly on large images; TOPCAT is slow to open large tables. Both are decades-old architectures (Tcl/Tk, JVM).
2. **UX improvements**: double-click a `.fits` file to open it in the right mode (image vs. table); click column headers to sort; jump to arbitrary sky coordinates (like FITSMAP); more improvements to be specified as we go.

The user will act as domain expert and daily tester; Claude does all implementation. Key risk is scope creep — DS9/TOPCAT have enormous feature surfaces. Strategy: build the ~20% of features used daily, correctly and fast, and grow by demand.

**Decisions made with user:**
- **Stack**: Tauri 2 (Rust backend) + TypeScript/WebGL2 frontend — top priority is speed and a polished double-click desktop app.
- **Platform**: macOS first (Apple Silicon); keep code portable, Linux/Windows later.
- **Interop**: read/write DS9 `.reg` files from the start; SAMP/XPA deferred.
- **Sequencing**: image viewer (DS9 side) first, then tables.

Working directory: `/Users/arg5965/research/ds10` (currently empty; will `git init`).

## Architecture

```
voyager/
├── src-tauri/          Rust backend (Tauri 2)
│   ├── fits/           FITS parsing, mmap data access, pyramid builder
│   ├── wcs/            WCS transforms (pixel ↔ sky)
│   ├── regions/        DS9 .reg parse/serialize
│   └── tiles/          Tile server: cutouts + downsampled levels as raw bytes
├── src/                TypeScript frontend
│   ├── viewer/         WebGL2 canvas: tiled rendering, pan/zoom
│   ├── shaders/        Stretch (linear/log/asinh/sqrt) + colormap LUTs in GLSL
│   └── ui/             Toolbar, header inspector, coordinate readout, goto box
└── package.json / Cargo.toml
```

### Core design points

- **Instant open via mmap**: parse the FITS header (2880-byte blocks), then `mmap` the data unit — no full read into RAM. A multi-GB image shows first pixels in well under a second.
- **Tile pyramid**: on open, Rust builds downsampled levels (2×, 4×, …) in the background; the frontend requests only visible tiles at the current zoom. This is the FITSMAP model, applied locally.
- **GPU stretch/colormap**: raw float32 tiles are uploaded as textures once; scale limits (zscale/min-max/percentile), stretch function, and colormap are uniforms/LUTs in the fragment shader — changing them re-renders in one frame with zero CPU work. Implement IRAF's zscale algorithm exactly so it matches DS9.
- **Binary IPC**: tiles go over Tauri 2's raw-bytes IPC (`tauri::ipc::Response`), not JSON.
- **FITS library**: start with `fitsrs` (pure Rust, used by Aladin Lite) for header parsing + our own mmap path for uncompressed images; if format coverage gaps appear (tile-compressed `.fits.fz`, exotic HDUs), fall back to CFITSIO via the `fitsio` crate. Decide finally in M0 spike using the user's real files.
- **WCS**: `wcs` crate (Rust, covers TAN/SIN/common projections). Fallback: wcslib bindings if the user's data uses uncommon projections/distortions (SIP, TPV — check early with real files).
- **Tables (later milestones)**: Arrow/Polars in Rust for columnar ops; frontend virtualized grid (render only visible rows) — sorting/filtering 10M rows stays interactive. Crossmatch via k-d tree on unit vectors (exact small-angle matching).
- **File association**: Tauri config registers `.fits`/`.fit`/`.fts`; on open, inspect the primary/first HDU to route to image or table mode automatically.

### Insights adopted from fitsgl (github.com/hollisakins/fitsgl)

A cloud-optimized FITS tile-pyramid WebGL2 renderer with an extensive test suite. **No license file → design reference only, no code copying** (unless the user obtains permission from the author). Lessons we adopt:

- **WebGL2 gotcha**: `R32F` textures support only NEAREST filtering in core WebGL2. Plan: NEAREST is actually DS9-correct when zoomed in (sharp pixels); use pyramid levels for minification; optional manual bilinear in the fragment shader later.
- **Fixture-based correctness testing**: Python scripts using astropy generate JSON/binary fixtures (stretch values, WCS transforms, decoded tiles); Rust/TS tests compare against them (bit-exact for decode, ULP tolerance for float math). Adopt this as voyager's primary correctness strategy.
- **Tiered tile caching**: GPU textures → RAM LRU of decoded arrays → (for us) Rust-side mmap + on-disk pyramid cache, so reopening a file is instant.
- **Module separation** that worked for them: tile-source / tile-manager / renderer / view-transform / camera as distinct layers; overlay subsystem (catalog markers) with its own spatial index + hit-testing; auto-stretch as a pure module. Pure logic kept free of GL/DOM so it unit-tests in Node; same principle for our Rust core (no Tauri types in `fits/`/`wcs/` modules).
- **Strict TypeScript, no `any`** — enforced from day one.
- **WCS scoping**: they shipped ICRS+TAN only; validates our "common projections first, expand with real files" approach.

## Project documentation & long-term continuity

The user will bring fresh Claude instances to this project over months. Three standing documents, created in M0 and maintained thereafter:

- **`CLAUDE.md`** (project root — auto-loaded each session): what voyager is, the stack, architecture map, design decisions (with rationale), performance targets, dev commands (build/run/test), testing strategy, and a pointer instructing every session to read `docs/STATE.md` first and update it before finishing.
- **`docs/STATE.md`** (living handoff doc): current milestone + status, what was done recently, in-flight work, recent learnings/gotchas (e.g. FITS edge cases discovered in the user's data), and immediate next steps. Each Claude session updates it as part of wrapping up any significant work; keep it current-state-only (history lives in git log), so it never bloats.
- **`docs/BACKLOG.md`**: the parked feature list — the user's "many various improvements" get captured here as they come up, so scope stays disciplined without losing ideas.

Git discipline: `git init` at M0, commit at each working increment with descriptive messages — git history is the project's long-term memory alongside STATE.md.

## Milestones

Each milestone ends with a working app the user tests on real data.

- **M0 — Skeleton + open spike** (foundation): `git init`; write `CLAUDE.md`, `docs/STATE.md`, `docs/BACKLOG.md`; scaffold Tauri app; open a FITS file via dialog *and* double-click association; show HDU list + full header; set up the astropy fixture-generation test harness; benchmark open time on the user's largest real file. Validates the FITS-library and IPC choices before building on them.
- **M1 — Image display**: tiled WebGL rendering, smooth pan/zoom (trackpad + keyboard), stretch functions + scale limits (zscale, min-max, percentiles), standard colormaps (gray, viridis, heat, cool…), live pixel-value + sky-coordinate readout under cursor.
- **M2 — Navigation**: jump-to-coordinate box (accepts decimal degrees, sexagesimal, common formats), zoom-to-fit, multi-HDU/extension switching, image histogram.
- **M3 — Regions**: load/save DS9 `.reg` (fk5 + image coords); create/move/resize circle, box, ellipse, polygon, point; labels/colors.
- **M4 — Table viewer**: open FITS tables, VOTable, CSV/TSV; virtualized grid; click-header sort; row filtering by expression; auto image-vs-table routing on open.
- **M5 — Crossmatch + linking**: sky crossmatch between two loaded tables (radius match, best/all pairs); overlay a catalog on the image; click a table row → pan image to that source.
- **M6 — Polish + packaging**: signed `.app`/DMG, preferences (default colormap/stretch), performance pass, backlog triage for the user's further feature list.

## Verification

- Every milestone: user opens their own real FITS files (large images, weird headers) and compares behavior side-by-side with DS9/TOPCAT.
- **Correctness**: pixel values and WCS readouts checked against `astropy` (scripted spot checks at known pixels); zscale limits compared to DS9's; `.reg` files round-tripped through DS9.
- **Performance targets**: first render of a ~2 GB image < 1 s; stretch/colormap change < 16 ms (one frame); pan/zoom at 60 fps; 1M-row table sort < 100 ms.
- Rust unit tests for FITS parsing, WCS transforms, region serialization; run via `cargo test`.

## Prerequisites (to set up in M0)

Rust toolchain (rustup), Node.js, Xcode command-line tools, Tauri CLI. `git init` the repo. Ask the user for 2–3 representative FITS files (their largest image, a typical image, a big catalog table) as the standing test set.

## Out of scope for now (parked backlog)

SAMP/XPA, plotting (histograms beyond basic, sky plots), cube/3D support, HiPS surveys, Windows/Linux packaging, name-resolution via Sesame (needs network; easy to add later).
