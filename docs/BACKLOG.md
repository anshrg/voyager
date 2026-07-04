# DS10 Backlog

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

- Cancel/debounce tile requests during fast zoom bursts: wheeling from fit to
  level 0 currently fetches every transient level's visible tiles (~900 tiles
  / 240 MB observed on the 5 GiB mosaic). Works, but wasteful; consider
  requesting only after the level is stable for a frame or two, or cancelling
  stale in-flight requests. **User confirmed the visible symptom (2026-07-04):
  a low-res image flashes on screen during quick zoom in/out — the coarse
  backdrop showing through while target-level tiles load. Not urgent but on
  the radar; fixing the debounce + keeping the previous level's tiles drawn
  until the new level covers the view would remove the flash.**
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
  one (bias = x, contrast = 2^(2(1−2y)), i.e. ¼…4×) feels off side-by-side.

## User ideas (add here as they come up)

- (the user has "many various improvements" to explicate — collect them here)
