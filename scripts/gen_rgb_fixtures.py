#!/usr/bin/env python
"""Ground truth for RGB composites (issue #14).

Writes three co-gridded JWST/NIRCam-style bands (F115W, F277W, F444W; i2d
layout: filter keywords in the primary, pixels in SCI) plus one band whose
grid is offset by half a pixel, and rgb_expected.json with:

  - per-band trilogy stats (median, 1.4826*MAD, bright-tail percentiles) —
    numpy over the full array (the fixture is small enough that Voyager's
    sampler reads every pixel) → tests/rgb_fixtures.rs
  - detected filter + pivot → tests/rgb_fixtures.rs
  - trilogy levels for two knob settings, and composite RGB at sample pixels
    for a trilogy and a simple-RGB draw → scripts/check_trilogy.mjs (TS port)
  - the TAN WCS params of each band + whether it shares the reference grid →
    scripts/check_trilogy.mjs (gridMismatch)

The level/composite math here is an independent numpy transcription of the
fitsgl semantics (stretch.ts trilogyLevels / weightedTrilogyPixel), with the
softening solved by a separate bisection — the TS port must agree with it.

    scripts/venv/bin/python scripts/gen_rgb_fixtures.py
"""

import json
import math
from pathlib import Path

import numpy as np
from astropy.io import fits

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
NX, NY = 120, 100
CRVAL = (214.8, 52.8)
SCALE = 0.03 / 3600.0  # 30 mas/px

BANDS = [
    # name, filter, pivot, sky, noise, source amplitude scale
    ("rgb_f115w.fits", "F115W", 1.154, 0.02, 0.010, 1.0),
    ("rgb_f277w.fits", "F277W", 2.786, 0.05, 0.006, 2.5),
    ("rgb_f444w.fits", "F444W", 4.421, 0.08, 0.008, 4.0),
]
OFFGRID = ("rgb_offgrid.fits", "F200W", 1.990)


def wcs_header(h, crpix1=60.5, crpix2=50.5):
    h["CTYPE1"] = "RA---TAN"
    h["CTYPE2"] = "DEC--TAN"
    h["CRVAL1"] = CRVAL[0]
    h["CRVAL2"] = CRVAL[1]
    h["CRPIX1"] = crpix1
    h["CRPIX2"] = crpix2
    h["CD1_1"] = -SCALE
    h["CD1_2"] = 0.0
    h["CD2_1"] = 0.0
    h["CD2_2"] = SCALE


def band_data(rng, sky, noise, amp):
    yy, xx = np.mgrid[0:NY, 0:NX]
    data = sky + noise * rng.standard_normal((NY, NX))
    # A few sources whose color differs by band (amp), plus one bright star.
    for (x0, y0, a, s) in [(30, 30, 0.3, 2.0), (80, 60, 0.5, 3.0), (60, 20, 0.15, 1.5), (95, 85, 3.0, 1.2)]:
        data += amp * a * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * s * s))
    data = data.astype(np.float32)
    data[0:6, 0:10] = np.nan  # no-coverage corner
    return data


def write_band(path, filt, data, crpix1=60.5):
    prim = fits.PrimaryHDU()
    prim.header["TELESCOP"] = "JWST"
    prim.header["INSTRUME"] = "NIRCAM"
    prim.header["FILTER"] = filt
    prim.header["PUPIL"] = "CLEAR"
    sci = fits.ImageHDU(data=data, name="SCI")
    sci.header["BUNIT"] = "MJy/sr"
    wcs_header(sci.header, crpix1=crpix1)
    fits.HDUList([prim, sci]).writeto(path, overwrite=True)


def stats(data):
    f = data[np.isfinite(data)].astype(np.float64)
    p50, p99, p999, p9999, p99999 = np.percentile(f, [50.0, 99.0, 99.9, 99.99, 99.999])
    sigma = 1.4826 * float(np.median(np.abs(f - p50)))
    return {
        "mean": float(p50),
        "sigma": sigma,
        "p99": float(p99),
        "p99_9": float(p999),
        "p99_99": float(p9999),
        "p99_999": float(p99999),
    }


def solve_k(n1, noiselum):
    # Independent of the TS bisection bracket: fixed wide log-space bisection.
    if not (0 < n1 < 1):
        return 1000.0
    if noiselum <= n1:
        return 0.0
    g = lambda k: math.log(k * n1 + 1) / math.log(k + 1)
    lo, hi = math.log(1e-12), math.log(1e30)
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if g(math.exp(mid)) < noiselum:
            lo = mid
        else:
            hi = mid
    return math.exp(0.5 * (lo + hi))


def sat_value(s, satpercent):
    xs = np.log10([1.0, 0.1, 0.01, 0.001])[::-1]  # ascending
    vs = [s["p99_999"], s["p99_99"], s["p99_9"], s["p99"]]
    sp = min(1.0, max(0.001, satpercent))
    return float(np.interp(math.log10(sp), xs, vs))


def levels(s, p):
    x0 = s["mean"] - p["noisesig0"] * s["sigma"]
    x1 = s["mean"] + p["noisesig"] * s["sigma"]
    x2 = sat_value(s, p["satpercent"])
    if not x2 > x0:
        x2 = x0 + max(s["sigma"], 1e-30)
    n1 = min(0.999, max(0.0, (x1 - x0) / (x2 - x0)))
    return {"x0": x0, "x1": x1, "x2": x2, "k": solve_k(n1, p["noiselum"])}


DS9 = {
    0: lambda t: t,
    1: lambda t: math.log(1000 * t + 1) / math.log(1001),
    2: math.sqrt,
}


def composite(values, bands, stretch, saturation, bias, contrast):
    num = np.zeros(3)
    den = np.zeros(3)
    nan = 0
    for v, b in zip(values, bands):
        w = np.asarray(b["weight"], dtype=float)
        den += w
        if math.isnan(v):
            nan += 1
            continue
        span = b["hi"] - b["lo"]
        t = min(1.0, max(0.0, (v - b["lo"]) / span))
        if stretch == 7:
            k = b["k"]
            s = math.log(k * t + 1) / math.log(k + 1) if k > 0 else t
        else:
            s = DS9[stretch](t)
        num += w * s
    if nan == len(bands):
        return None
    rgb = np.where(den > 0, np.clip(num / np.where(den > 0, den, 1), 0, 1), 0.0)
    if saturation != 1:
        lum = rgb.mean()
        rgb = np.clip(lum + (rgb - lum) * saturation, 0, 1)
    rgb = np.clip(0.5 + (rgb - bias) * contrast, 0, 1)
    return [float(c) for c in rgb]


def wcs_params(crpix1):
    cd = [[-SCALE, 0.0], [0.0, SCALE]]
    inv = np.linalg.inv(np.array(cd)).tolist()
    return {
        "crpix": [crpix1, 50.5],
        "lon0": CRVAL[0],
        "lat0": CRVAL[1],
        "cd": cd,
        "cd_inv": inv,
        "lonpole": 180.0,
        "swapped": False,
    }


def main():
    rng = np.random.default_rng(14)
    out = {"bands": [], "nx": NX, "ny": NY}
    datas = []
    for name, filt, pivot, sky, noise, amp in BANDS:
        data = band_data(rng, sky, noise, amp)
        write_band(FIXTURES / name, filt, data)
        datas.append(data)
        out["bands"].append(
            {"file": name, "hdu": 1, "filter": filt, "pivot_um": pivot, "stats": stats(data),
             "wcs": wcs_params(60.5), "same_grid": True}
        )
    off = band_data(rng, 0.04, 0.007, 1.8)
    write_band(FIXTURES / OFFGRID[0], OFFGRID[1], off, crpix1=61.0)  # +0.5 px
    out["bands"].append(
        {"file": OFFGRID[0], "hdu": 1, "filter": OFFGRID[1], "pivot_um": OFFGRID[2], "stats": stats(off),
         "wcs": wcs_params(61.0), "same_grid": False}
    )

    param_sets = [
        {"noiselum": 0.15, "satpercent": 0.001, "noisesig": 1.0, "noisesig0": 2.0},
        {"noiselum": 0.3, "satpercent": 0.05, "noisesig": 2.5, "noisesig0": 1.0},
    ]
    out["levels"] = [
        {"params": p, "per_band": [levels(b["stats"], p) for b in out["bands"][:3]]} for p in param_sets
    ]

    pix = [(30, 30), (80, 60), (95, 85), (5, 2), (110, 90), (60, 20)]  # (x, y); (5,2) is NaN
    rainbow = [[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]]
    tri_bands = [
        {"lo": lv["x0"], "hi": lv["x2"], "k": lv["k"], "weight": w}
        for lv, w in zip(out["levels"][0]["per_band"], rainbow)
    ]
    # Simple: R=F444W, G=F277W, B=F115W, shared range, log stretch.
    simple_bands = [
        {"lo": 0.0, "hi": 0.6, "k": 0.0, "weight": [1.0, 0.0, 0.0]},
        {"lo": 0.0, "hi": 0.6, "k": 0.0, "weight": [0.0, 1.0, 0.0]},
        {"lo": 0.0, "hi": 0.6, "k": 0.0, "weight": [0.0, 0.0, 1.0]},
    ]
    draws = [
        {"name": "trilogy", "bands": tri_bands, "order": [0, 1, 2], "stretch": 7, "saturation": 1.0,
         "bias": 0.5, "contrast": 1.0},
        {"name": "trilogy_sat_cb", "bands": tri_bands, "order": [0, 1, 2], "stretch": 7, "saturation": 1.6,
         "bias": 0.4, "contrast": 1.3},
        {"name": "simple_log", "bands": simple_bands, "order": [2, 1, 0], "stretch": 1, "saturation": 1.0,
         "bias": 0.5, "contrast": 1.0},
    ]
    for d in draws:
        d["pixels"] = []
        for (x, y) in pix:
            vals = [float(datas[i][y, x]) for i in d["order"]]
            d["pixels"].append(
                {"x": x, "y": y, "values": [None if math.isnan(v) else v for v in vals],
                 "rgb": composite(vals, d["bands"], d["stretch"], d["saturation"], d["bias"], d["contrast"])}
            )
    out["draws"] = draws
    out["rainbow"] = {str(n): [list(map(float, w)) for w in rb] for n, rb in [
        (1, [[1, 1, 1]]), (3, rainbow),
        (5, [[0, 0, 1], [0, 1, 1], [0, 1, 0], [1, 1, 0], [1, 0, 0]]),
    ]}

    (FIXTURES / "rgb_expected.json").write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {len(BANDS) + 1} bands + rgb_expected.json to {FIXTURES}")


if __name__ == "__main__":
    main()
