---
name: verify
description: Launch and drive DS10 (Tauri app) to verify changes end-to-end on macOS — build/launch recipe, UI automation via CGEvent, dialog automation.
---

# Verifying DS10 changes in the running app

## Launch

```bash
ps aux | grep -i ds10 | grep -v grep       # kill stale instances FIRST (incl. bundled /Applications/DS10.app)
lsof -ti :1420 | xargs kill                # stale vite
export PATH="$HOME/.cargo/bin:$PATH"
npm run tauri dev -- -- /abs/path/to.fits  # argv open needs an ABSOLUTE path
```

Run in background, wait for `[ds10] open_fits` in the log (~1–2 min cold compile).
Good test files: `fixtures/sample.fits` (6 HDUs, WCS on 0 and 3),
`fixtures/regions/*.reg`, CEERS MIRI i2d at
`~/research/miri-photometry/egs/data/images/i2d/ceers-miri-pointings/`.

## Drive

- **Coordinates**: take a FULL `screencapture -x shot.png` (2940×1912 px = 1470×956 pt);
  read positions off it and divide px by 2 → CGEvent global points. Don't trust
  `screencapture -R` origins or System Events window positions.
- **Input**: recreate `mouse.js` (JXA posting CGEventCreateMouseEvent/ScrollWheelEvent;
  copy pattern from a previous session or STATE.md) — cmds move/click/rclick/dblrclick/scroll.
  Wheel zoom needs big deltas (±40, repeated).
- **Open/Save panels are automatable**: click the button, then System Events
  `keystroke "g" using {command down, shift down}` → type absolute path → Return (×2 for
  open; for save: goto folder, then cmd+a + type filename + Return). Delays ≥0.4 s between steps.
- Readout/status messages appear in the bottom status bar (crop `--cropOffset 1832 0`,
  height 80, from the 1912-px capture).
- Vite hot-reload wipes frontend state; editing src-tauri/ restarts the app.

## Teardown

`pkill -f "tauri dev"; pkill -f "target/debug/ds10"` — and tell the user if you quit
their own running instance.
