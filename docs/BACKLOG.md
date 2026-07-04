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
  stale in-flight requests.
- Block-AVERAGE downsampling option (current levels block-sample like DS9's
  default; averaging shows depth better when zoomed out — DS9 has it as an
  option too).
- zscale gather speedup: sampled rows currently fault in every page they
  cross; reading contiguous row chunks (or madvise) could cut the ~750 ms
  cold-start on 5 GiB mosaics further.
- Manual scale limits entry + percentile modes (99%, 99.5%…) next to
  zscale/minmax; histogram-driven limits UI is the M2 item.
- Colormap inversion and DS9-style colormap contrast/bias dragging.
- Keyboard shortcuts for zoom (+/-/0), stretch cycling, colormap cycling.
- NaN rendering color: currently fixed near-black; consider making it
  configurable (DS9 lets you pick the blank color).
- Readout could also show WCS sky coordinates once M2's WCS lands (currently
  image x/y/value only).

## User ideas (add here as they come up)

- (the user has "many various improvements" to explicate — collect them here)
