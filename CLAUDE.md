# DS10

A fast, modern desktop replacement for **DS9** (FITS image viewing, regions) and **TOPCAT** (tables, crossmatching), built for an astronomer who is the sole user and daily tester. Claude does all implementation; the user is the domain expert.

**Every session: read `docs/STATE.md` first** — it is the living handoff document with current status, in-flight work, and recent gotchas. **Update it before finishing any significant work.** Park new feature ideas in `docs/BACKLOG.md` instead of expanding current scope.

## Stack & why

- **Tauri 2**: Rust backend + system webview. Chosen for performance (the whole point of the project — DS9/TOPCAT are slow on large data) and clean macOS packaging with file associations.
- **Rust backend** (`src-tauri/`): FITS I/O, WCS, regions, tables. Pure logic lives in modules with **no Tauri types** (`fits/`, later `wcs/`, `regions/`, `tiles/`) so it unit-tests without the app shell.
- **TypeScript frontend** (`src/`): strict mode, **no `any`**. WebGL2 for image rendering (M1+). All `invoke` calls go through typed wrappers in `src/api.ts`.
- **Platform**: macOS (Apple Silicon) first; keep code portable for Linux later.

## Architecture map

```
src-tauri/src/
  fits/          FITS parsing, HDU enumeration, mmap data access (pure, tested)
  lib.rs         Tauri commands, app state (open files), file-open plumbing
src/
  api.ts         Typed IPC wrappers + shared types (mirror Rust serde output)
  main.ts        UI shell (M0: HDU list + header viewer)
scripts/         Fixture generation (Python/astropy) + dev utilities
fixtures/        Small committed FITS files + expected-value JSON (ground truth)
docs/            STATE.md (living handoff), BACKLOG.md (parked features)
```

## Non-negotiable design decisions

1. **Never read data units into RAM at open time.** Files are mmap'd; only header blocks are touched on open. This is what makes multi-GB opens instant. Don't add code that slurps whole data arrays.
2. **Correctness is gated on astropy fixtures.** Python scripts in `scripts/` generate FITS files + expected-value JSON into `fixtures/`; Rust tests compare against them. Any new parsing/math feature gets a fixture test (pattern borrowed from the fitsgl project).
3. **GPU does the visual math** (M1+): stretch, scale limits, colormaps are shader uniforms/LUTs so re-stretching is one frame, never a CPU re-render. Note: `R32F` textures are NEAREST-filter-only in core WebGL2.
4. **Match DS9/astropy semantics** where they exist (zscale algorithm, region formats, WCS conventions) — the user will compare side-by-side.
5. **fitsgl (github.com/hollisakins/fitsgl) is a design reference only** — it has no license; do not copy code from it.
6. **File-open paths**: dialog, macOS Apple Events (`RunEvent::Opened`), CLI args. All funnel through `dispatch_open` in `lib.rs` (queue + event, frontend drains queue once at startup).

## Dev commands

```bash
export PATH="$HOME/.cargo/bin:$PATH"       # rustup-installed toolchain
npm run tauri dev                           # run the app (dev)
npm run tauri build                         # bundle DS10.app (needed to test file associations)
npx tsc --noEmit                            # typecheck frontend
cd src-tauri && cargo test                  # Rust unit + fixture tests
scripts/venv/bin/python scripts/gen_fixtures.py   # regenerate fixtures (venv has astropy)
```

- File associations only work in the **bundled** app, not `tauri dev`. Dev-test opens with `npm run tauri dev -- -- /path/to/file.fits` (argv path) instead.
- Node is v18 (system). Vite/tooling versions must stay compatible with it, or upgrade Node deliberately.

## Performance targets (regressions are bugs)

- First render of a ~2 GB image: **< 1 s** (M0 header display: < 50 ms)
- Stretch/colormap change: **< 16 ms** (one frame)
- Pan/zoom: 60 fps; 1M-row table sort: < 100 ms

## Roadmap (details in the plan; status in docs/STATE.md)

M0 skeleton + FITS open spike → M1 tiled GPU image display (stretch/colormaps/readout) → M2 navigation (goto coordinate, histogram) → M3 DS9 regions → M4 table viewer (sort/filter) → M5 crossmatch + image↔table linking → M6 packaging/polish. Deferred: SAMP/XPA, plotting, cubes, HiPS, Windows/Linux.
