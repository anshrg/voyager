//! Ground-truth tests: astropy (via scripts/gen_fixtures.py) writes
//! fixtures/sample.fits + expected.json; we must report the same structure
//! and pixel values. Regenerate fixtures with:
//!   scripts/venv/bin/python scripts/gen_fixtures.py

use ds10_lib::fits::{FitsFile, HduKind};
use serde_json::Value as Json;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures")
}

fn load() -> (FitsFile, Json) {
    let dir = fixtures_dir();
    let expected: Json = serde_json::from_str(
        &std::fs::read_to_string(dir.join("expected.json"))
            .expect("expected.json missing — run scripts/gen_fixtures.py"),
    )
    .unwrap();
    let file = FitsFile::open(&dir.join("sample.fits")).expect("open sample.fits");
    (file, expected)
}

#[test]
fn hdu_structure_matches_astropy() {
    let (file, expected) = load();
    let hdus = expected["hdus"].as_array().unwrap();
    assert_eq!(file.hdus.len(), hdus.len(), "HDU count");

    for exp in hdus {
        let i = exp["index"].as_u64().unwrap() as usize;
        let hdu = &file.hdus[i];

        let kind = match exp["kind"].as_str().unwrap() {
            "image" => HduKind::Image,
            "bin_table" => HduKind::BinTable,
            other => panic!("unexpected fixture kind {other}"),
        };
        assert_eq!(hdu.kind, kind, "HDU {i} kind");
        assert_eq!(
            hdu.name.as_deref(),
            exp["name"].as_str(),
            "HDU {i} EXTNAME"
        );
        assert_eq!(hdu.bitpix, exp["bitpix"].as_i64().unwrap(), "HDU {i} BITPIX");

        let shape: Vec<i64> = exp["shape"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap())
            .collect();
        assert_eq!(hdu.shape, shape, "HDU {i} shape");

        for (key, val) in exp["header_cards"].as_object().unwrap() {
            if let Some(want) = val.as_f64() {
                let got = hdu
                    .header
                    .get_f64(key)
                    .unwrap_or_else(|| panic!("HDU {i} missing numeric card {key}"));
                assert!(
                    (got - want).abs() <= want.abs() * 1e-12,
                    "HDU {i} card {key}: got {got}, want {want}"
                );
            } else if let Some(want) = val.as_str() {
                assert_eq!(
                    hdu.header.get_str(key),
                    Some(want),
                    "HDU {i} string card {key}"
                );
            }
        }
    }
}

#[test]
fn pixel_values_match_astropy() {
    let (file, expected) = load();
    for check in expected["pixel_checks"].as_array().unwrap() {
        let hdu = check["hdu"].as_u64().unwrap() as usize;
        let x = check["x"].as_u64().unwrap();
        let y = check["y"].as_u64().unwrap();
        let want = check["value"].as_f64().unwrap();
        let got = file.pixel_value(hdu, x, y).unwrap();
        assert!(
            (got - want).abs() <= 1e-6 * want.abs().max(1.0),
            "pixel ({x},{y}) HDU {hdu}: got {got}, want {want}"
        );
    }
}
