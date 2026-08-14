#!/usr/bin/env python
"""Generate crossmatch ground-truth fixtures for Voyager's Rust tests.

astropy is the reference implementation (issue #10): for several small
synthetic catalog pairs this writes the input positions plus the expected
match pairs from `match_to_catalog_sky` (best match, filtered to the radius)
and `search_around_sky` (all pairs within the radius) into
fixtures/xmatch_expected.json. `src-tauri/tests/xmatch_fixtures.rs` compares
the Rust xmatch module against it. Regenerate with:

    scripts/venv/bin/python scripts/gen_xmatch_fixtures.py

Scenarios cover the edge cases called out in issue #10: RA wrap at 0/360,
pole proximity, exact-radius boundary, duplicate positions, and NaN rows.
NaN semantics: rows with a NaN coordinate simply don't participate; expected
pairs are computed over the valid subset and mapped back to original indices.
"""

import json
import math
from pathlib import Path

import numpy as np
import astropy.units as u
from astropy.coordinates import SkyCoord, search_around_sky

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def expected_pairs(ra_a, dec_a, ra_b, dec_b, radius_arcsec):
    """Best + all pairs (original indices, separations in deg) via astropy."""
    ra_a, dec_a = np.asarray(ra_a, float), np.asarray(dec_a, float)
    ra_b, dec_b = np.asarray(ra_b, float), np.asarray(dec_b, float)
    valid_a = np.flatnonzero(np.isfinite(ra_a) & np.isfinite(dec_a))
    valid_b = np.flatnonzero(np.isfinite(ra_b) & np.isfinite(dec_b))
    radius = radius_arcsec * u.arcsec

    best, allp = [], []
    if len(valid_a) and len(valid_b):
        ca = SkyCoord(ra=ra_a[valid_a] * u.deg, dec=dec_a[valid_a] * u.deg)
        cb = SkyCoord(ra=ra_b[valid_b] * u.deg, dec=dec_b[valid_b] * u.deg)

        idx, sep2d, _ = ca.match_to_catalog_sky(cb)
        for i, (j, s) in enumerate(zip(idx, sep2d)):
            if s <= radius:
                best.append([int(valid_a[i]), int(valid_b[j]), float(s.deg)])

        ia, ib, sep2d, _ = search_around_sky(ca, cb, radius)
        for i, j, s in zip(ia, ib, sep2d):
            allp.append([int(valid_a[i]), int(valid_b[j]), float(s.deg)])

    allp.sort()
    return {
        "n_valid_a": int(len(valid_a)),
        "n_valid_b": int(len(valid_b)),
        "best": best,
        "all": allp,
    }


def jsonable(arr):
    """float list with NaN -> None (JSON null)."""
    return [None if not math.isfinite(v) else float(v) for v in arr]


def scenario(name, radius_arcsec, ra_a, dec_a, ra_b, dec_b):
    exp = expected_pairs(ra_a, dec_a, ra_b, dec_b, radius_arcsec)
    return {
        "name": name,
        "radius_arcsec": float(radius_arcsec),
        "ra_a": jsonable(ra_a),
        "dec_a": jsonable(dec_a),
        "ra_b": jsonable(ra_b),
        "dec_b": jsonable(dec_b),
        **exp,
    }


def random_field(rng):
    # ~0.5 deg patch; half of B is a perturbation (within ~5") of A rows so
    # there is a healthy population of close matches, the rest random.
    n_a, n_pert, n_rand = 300, 150, 250
    ra_a = 150.0 + rng.uniform(-0.25, 0.25, n_a)
    dec_a = 2.0 + rng.uniform(-0.25, 0.25, n_a)
    off = 5.0 / 3600.0
    ra_b = np.concatenate(
        [
            ra_a[:n_pert] + rng.uniform(-off, off, n_pert),
            150.0 + rng.uniform(-0.25, 0.25, n_rand),
        ]
    )
    dec_b = np.concatenate(
        [
            dec_a[:n_pert] + rng.uniform(-off, off, n_pert),
            2.0 + rng.uniform(-0.25, 0.25, n_rand),
        ]
    )
    return scenario("random_field", 30.0, ra_a, dec_a, ra_b, dec_b)


def ra_wrap(rng):
    # Sources straddling RA 0/360; matches must cross the wrap seamlessly.
    n = 80
    ra_a = (359.95 + rng.uniform(0.0, 0.1, n)) % 360.0
    dec_a = rng.uniform(-0.05, 0.05, n)
    ra_b = (359.95 + rng.uniform(0.0, 0.1, n)) % 360.0
    dec_b = rng.uniform(-0.05, 0.05, n)
    return scenario("ra_wrap", 20.0, ra_a, dec_a, ra_b, dec_b)


def pole(rng):
    # Clustered near the north celestial pole where RA degenerates.
    n = 60
    ra_a = rng.uniform(0.0, 360.0, n)
    dec_a = 89.95 + rng.uniform(0.0, 0.049, n)
    ra_b = rng.uniform(0.0, 360.0, n)
    dec_b = 89.95 + rng.uniform(0.0, 0.049, n)
    return scenario("pole", 15.0, ra_a, dec_a, ra_b, dec_b)


def boundary():
    # B rows constructed at exact separations from A rows via
    # directional_offset_by: radius 1" with pairs at 1"±1e-6" (one in, one
    # out — robustly on either side of the boundary for both
    # implementations), plus a comfortable inlier and outlier.
    seps = np.array([1.0 - 1e-6, 1.0 + 1e-6, 0.5, 2.0])  # arcsec
    a = SkyCoord(ra=[150.0] * 4 * u.deg, dec=[2.0, 2.01, 2.02, 2.03] * u.deg)
    b = a.directional_offset_by(45.0 * u.deg, seps * u.arcsec)
    return scenario(
        "boundary", 1.0, a.ra.deg, a.dec.deg, b.ra.deg, b.dec.deg
    )


def duplicates():
    # Exact duplicate positions on both sides, including a zero-separation
    # match. Best-match tie-breaking between identical B rows is arbitrary;
    # the Rust test compares the matched B *coordinates*, not the index.
    p_ra, p_dec = 150.0, 2.0
    q = SkyCoord(ra=p_ra * u.deg, dec=p_dec * u.deg).directional_offset_by(
        90.0 * u.deg, 0.3 * u.arcsec
    )
    ra_a = [p_ra, p_ra, 150.001]
    dec_a = [p_dec, p_dec, 2.0]
    ra_b = [q.ra.deg, q.ra.deg, p_ra]
    dec_b = [q.dec.deg, q.dec.deg, p_dec]
    return scenario("duplicates", 1.0, ra_a, dec_a, ra_b, dec_b)


def nan_rows(rng):
    n = 40
    ra_a = 150.0 + rng.uniform(-0.02, 0.02, n)
    dec_a = 2.0 + rng.uniform(-0.02, 0.02, n)
    ra_b = 150.0 + rng.uniform(-0.02, 0.02, n)
    dec_b = 2.0 + rng.uniform(-0.02, 0.02, n)
    ra_a[2] = np.nan
    dec_a[5] = np.nan
    ra_b[0] = np.nan
    ra_b[7] = np.nan
    dec_b[7] = np.nan  # doubly-invalid row
    return scenario("nan_rows", 30.0, ra_a, dec_a, ra_b, dec_b)


def main():
    rng = np.random.default_rng(20260713)
    scenarios = [
        random_field(rng),
        ra_wrap(rng),
        pole(rng),
        boundary(),
        duplicates(),
        nan_rows(rng),
    ]
    for s in scenarios:
        print(
            f"{s['name']:>14}: {len(s['ra_a'])}x{len(s['ra_b'])} rows, "
            f"r={s['radius_arcsec']}\" -> {len(s['best'])} best, "
            f"{len(s['all'])} all"
        )
        assert s["best"], f"{s['name']}: no best pairs — scenario is vacuous"
    out = FIXTURES / "xmatch_expected.json"
    out.write_text(json.dumps({"scenarios": scenarios}, indent=1))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
