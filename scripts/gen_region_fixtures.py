#!/usr/bin/env python
"""Generate DS9 region-file fixtures + ground truth for Voyager's Rust tests.

The astropy `regions` package is the reference implementation: this script
writes .reg files into fixtures/regions/ plus regions_expected.json holding
the pixel-space result of parsing each file and (for sky frames) converting
it through the WCS of a named HDU of fixtures/sample.fits. Rust tests
(src-tauri/tests/region_fixtures.rs) must reproduce those numbers.

Regenerate with:  scripts/venv/bin/python scripts/gen_region_fixtures.py

Notes on scope (mirrors the Rust module):
- Frames: image + icrs only in fixtures. Voyager treats fk5 as an alias of
  icrs (the ~23 mas frame rotation is ignored); fixtures stick to icrs so
  the ground truth has no frame-conversion component.
- Shapes: circle, annulus, ellipse, box, polygon, point.
"""

import json
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from regions import Regions

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
REGDIR = FIXTURES / "regions"

# (file name, HDU index whose WCS applies, file content)
# HDU 0: CRVAL (150.1163213, +2.2058057), CRPIX (32, 24), 0.03"/px, 64x48.
# HDU 3 "ROT": CRVAL (83.6331, +61.2007), CRPIX (16.5, 12.25), rotated 33°
#   and slightly anisotropic/skewed CD, ~0.76"/px, 32x24.
REG_FILES = [
    (
        "image.reg",
        0,
        """\
# Region file format: DS9 version 4.1
global color=green width=1
image
circle(32.0,24.0,10.5) # color=red width=2 text={core}
annulus(26,15,3,6) # color=magenta
annulus(45,35,2,4,6.5)
ellipse(20,30,8,4,25) # dash=1
box(40,20,12.5,6,75) # color=cyan
polygon(5,5,20,8,15,20) # text={poly one}
point(10,40) # point=cross color=yellow
-box(50,40,8,8,0)
""",
    ),
    (
        "icrs.reg",
        0,
        """\
# sky frame, sexagesimal + decimal + mixed size units, tiny HST-like field
global color=green
icrs
circle(150.1163213,2.2058057,0.30")
circle(10:00:27.9000,+02:12:20.500,0.24") # color=red text={sexagesimal}
annulus(150.116350,2.205870,0.12",0.25") # text={sky annulus}
ellipse(150.116200,2.205850,0.30",0.15",30) # width=3
box(150.116450,2.205900,0.6",0.3",45) # color=blue dash=1
polygon(150.116400,2.205740,150.116250,2.205950,150.116150,2.205700)
point(10:00:27.92,+2:12:20.9) # point=x
-circle(150.116300,2.205800,0.005')
box(150.1163213,2.2058057,0.0001d,0.00005d,10) # text={degree units}
""",
    ),
    (
        "rot.reg",
        3,
        """\
# rotated + skewed CD at dec +61: stresses the Jacobian/SVD conversion
icrs
circle(83.6331,61.2007,3.0")
annulus(83.6335,61.2008,2.0",4.0")
ellipse(83.6340,61.2010,4.0",2.0",25) # color=magenta
box(83.6320,61.2004,6.0",3.0",60)
polygon(83.6345,61.2002,83.6338,61.2015,83.6318,61.2010,83.6325,61.2000)
point(83.63285,61.20095)
""",
    ),
    (
        "mixed.reg",
        0,
        """\
# frame switching + semicolon-separated statements on one line
icrs; circle(150.1163213,2.2058057,0.3") # color=red
circle(150.116250,2.205780,0.2"); point(150.116350,2.205830)
image
box(30,20,10,5,15) # text={pixel box}
circle(12,12,4)
-polygon(3,3,9,3,9,9,3,9)
""",
    ),
]


def region_record(reg) -> dict:
    """PixelRegion → comparable JSON record (0-based pixels, degrees)."""
    name = type(reg).__name__
    rec: dict = {}
    if name == "CirclePixelRegion":
        rec = {"shape": "circle", "x": reg.center.x, "y": reg.center.y,
               "r": float(reg.radius)}
    elif name == "CircleAnnulusPixelRegion":
        rec = {"shape": "annulus", "x": reg.center.x, "y": reg.center.y,
               "rin": float(reg.inner_radius), "rout": float(reg.outer_radius)}
    elif name == "EllipsePixelRegion":
        # regions stores full width/height; Voyager stores semi-axes.
        rec = {"shape": "ellipse", "x": reg.center.x, "y": reg.center.y,
               "rx": float(reg.width) / 2, "ry": float(reg.height) / 2,
               "angle": float(np.mod(reg.angle.to_value("deg"), 360.0))}
    elif name == "RectanglePixelRegion":
        rec = {"shape": "box", "x": reg.center.x, "y": reg.center.y,
               "w": float(reg.width), "h": float(reg.height),
               "angle": float(np.mod(reg.angle.to_value("deg"), 360.0))}
    elif name == "PolygonPixelRegion":
        rec = {"shape": "polygon",
               "xs": [float(v) for v in np.atleast_1d(reg.vertices.x)],
               "ys": [float(v) for v in np.atleast_1d(reg.vertices.y)]}
    elif name == "PointPixelRegion":
        rec = {"shape": "point", "x": reg.center.x, "y": reg.center.y}
    else:
        raise TypeError(f"unexpected region type {name}")
    for k in ("x", "y"):
        if k in rec:
            rec[k] = float(rec[k])

    rec["include"] = bool(reg.meta.get("include", True))
    # The ds9 reader maps color= to matplotlib edgecolor (points keep color).
    color = reg.visual.get("color") or reg.visual.get("edgecolor")
    if color is not None:
        rec["color"] = color
    width = reg.visual.get("linewidth")
    if width is not None:
        rec["width"] = float(width)
    rec["dash"] = reg.visual.get("linestyle") == "dashed"
    text = reg.meta.get("text")
    if text:
        rec["text"] = text
    return rec


def main() -> None:
    REGDIR.mkdir(parents=True, exist_ok=True)
    hdul = fits.open(FIXTURES / "sample.fits")

    files = []
    for fname, hdu_index, content in REG_FILES:
        path = REGDIR / fname
        path.write_text(content)
        wcs = WCS(hdul[hdu_index].header)
        parsed = Regions.read(path, format="ds9")
        records = []
        for reg in parsed:
            pix = reg if "Pixel" in type(reg).__name__ else reg.to_pixel(wcs)
            records.append(region_record(pix))
        files.append({"file": fname, "hdu": hdu_index, "regions": records})
        print(f"{fname}: {len(records)} regions vs HDU {hdu_index}")

    out = FIXTURES / "regions_expected.json"
    out.write_text(json.dumps({"files": files}, indent=2) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
