//! RGB composite ground truth (issue #14): numpy (scripts/gen_rgb_fixtures.py)
//! computes each band's trilogy stats and identity; Voyager's sampler + stats
//! + band detection must agree. Regenerate with:
//!   scripts/venv/bin/python scripts/gen_rgb_fixtures.py

use serde_json::Value as Json;
use std::path::PathBuf;
use voyager_lib::fits::FitsFile;
use voyager_lib::{rgb, tiles};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("fixtures")
}

fn expected() -> Json {
    serde_json::from_str(
        &std::fs::read_to_string(fixtures_dir().join("rgb_expected.json"))
            .expect("rgb_expected.json missing — run scripts/gen_rgb_fixtures.py"),
    )
    .unwrap()
}

fn close(got: f64, want: f64, what: &str) {
    let tol = 1e-9 * want.abs().max(1e-6);
    assert!((got - want).abs() <= tol, "{what}: got {got}, want {want}");
}

#[test]
fn band_stats_match_numpy() {
    let exp = expected();
    for b in exp["bands"].as_array().unwrap() {
        let name = b["file"].as_str().unwrap();
        let hdu = b["hdu"].as_u64().unwrap() as usize;
        let file = FitsFile::open(&fixtures_dir().join(name)).unwrap();
        // Same call get_band_info makes; the fixture is below the sample
        // target, so every pixel is read (as numpy does).
        let values = tiles::gather_values(&file, hdu, 1_000_000).unwrap();
        let s = rgb::trilogy_stats(&values).expect("stats");
        let e = &b["stats"];
        for (got, key) in [
            (s.mean, "mean"),
            (s.sigma, "sigma"),
            (s.p99, "p99"),
            (s.p99_9, "p99_9"),
            (s.p99_99, "p99_99"),
            (s.p99_999, "p99_999"),
        ] {
            close(got, e[key].as_f64().unwrap(), &format!("{name} {key}"));
        }
    }
}

#[test]
fn band_identity_from_i2d_headers() {
    let exp = expected();
    for b in exp["bands"].as_array().unwrap() {
        let name = b["file"].as_str().unwrap();
        let file = FitsFile::open(&fixtures_dir().join(name)).unwrap();
        let ext = &file.hdu(1).unwrap().header;
        let prim = &file.hdu(0).unwrap().header;
        let band = rgb::detect_band(&[ext, prim]).expect("band");
        assert_eq!(band.filter, b["filter"].as_str().unwrap(), "{name}");
        assert_eq!(band.pivot_um, b["pivot_um"].as_f64().unwrap(), "{name}");
        assert_eq!(band.telescope, "JWST");
    }
}
