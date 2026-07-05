//! Ground-truth tests for DS9 region parsing + pixel conversion: the
//! astropy `regions` package (via scripts/gen_region_fixtures.py) writes
//! fixtures/regions/*.reg plus regions_expected.json holding the parsed
//! regions in pixel space; we must reproduce them. Regenerate with:
//!   scripts/venv/bin/python scripts/gen_region_fixtures.py

use ds10_lib::fits::FitsFile;
use ds10_lib::regions::{parse, PixelRegion, PixelShape};
use ds10_lib::wcs::Wcs;
use serde_json::Value as Json;
use std::path::PathBuf;

const TOL: f64 = 1e-4; // pixels / degrees; algorithmic errors are ≫ this

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures")
}

fn approx(got: f64, want: f64, what: &str) {
    assert!(
        (got - want).abs() <= TOL,
        "{what}: got {got}, want {want}"
    );
}

/// Angles compare on the circle (0 ≡ 360).
fn approx_angle(got: f64, want: f64, what: &str) {
    let d = (got - want).rem_euclid(360.0);
    assert!(
        d.min(360.0 - d) <= TOL,
        "{what}: got {got}, want {want}"
    );
}

fn check_shape(got: &PixelShape, want: &Json, ctx: &str) {
    let f = |k: &str| want[k].as_f64().unwrap_or_else(|| panic!("{ctx}: fixture missing {k}"));
    match (want["shape"].as_str().unwrap(), got) {
        ("circle", PixelShape::Circle { x, y, r }) => {
            approx(*x, f("x"), &format!("{ctx} x"));
            approx(*y, f("y"), &format!("{ctx} y"));
            approx(*r, f("r"), &format!("{ctx} r"));
        }
        ("ellipse", PixelShape::Ellipse { x, y, rx, ry, angle }) => {
            approx(*x, f("x"), &format!("{ctx} x"));
            approx(*y, f("y"), &format!("{ctx} y"));
            approx(*rx, f("rx"), &format!("{ctx} rx"));
            approx(*ry, f("ry"), &format!("{ctx} ry"));
            approx_angle(*angle, f("angle"), &format!("{ctx} angle"));
        }
        ("box", PixelShape::Box { x, y, w, h, angle }) => {
            approx(*x, f("x"), &format!("{ctx} x"));
            approx(*y, f("y"), &format!("{ctx} y"));
            approx(*w, f("w"), &format!("{ctx} w"));
            approx(*h, f("h"), &format!("{ctx} h"));
            approx_angle(*angle, f("angle"), &format!("{ctx} angle"));
        }
        ("polygon", PixelShape::Polygon { xs, ys }) => {
            let wxs = want["xs"].as_array().unwrap();
            let wys = want["ys"].as_array().unwrap();
            assert_eq!(xs.len(), wxs.len(), "{ctx} vertex count");
            for (i, (got, want)) in xs.iter().zip(wxs).enumerate() {
                approx(*got, want.as_f64().unwrap(), &format!("{ctx} x[{i}]"));
            }
            for (i, (got, want)) in ys.iter().zip(wys).enumerate() {
                approx(*got, want.as_f64().unwrap(), &format!("{ctx} y[{i}]"));
            }
        }
        ("point", PixelShape::Point { x, y }) => {
            approx(*x, f("x"), &format!("{ctx} x"));
            approx(*y, f("y"), &format!("{ctx} y"));
        }
        (want_kind, got) => panic!("{ctx}: expected {want_kind}, got {got:?}"),
    }
}

fn check_props(got: &PixelRegion, want: &Json, ctx: &str) {
    assert_eq!(
        got.include,
        want["include"].as_bool().unwrap(),
        "{ctx} include"
    );
    assert_eq!(
        got.color.as_deref(),
        want["color"].as_str(),
        "{ctx} color"
    );
    assert_eq!(got.text.as_deref(), want["text"].as_str(), "{ctx} text");
    assert_eq!(
        got.dash,
        want["dash"].as_bool().unwrap_or(false),
        "{ctx} dash"
    );
    // Width: astropy-regions only reports linewidth for outline shapes
    // (points get a marker width instead), so compare only when present.
    if let Some(w) = want["width"].as_f64() {
        assert_eq!(got.width, Some(w), "{ctx} width");
    }
}

#[test]
fn region_files_match_astropy_regions() {
    let dir = fixtures_dir();
    let expected: Json = serde_json::from_str(
        &std::fs::read_to_string(dir.join("regions_expected.json"))
            .expect("regions_expected.json missing — run scripts/gen_region_fixtures.py"),
    )
    .unwrap();
    let fits = FitsFile::open(&dir.join("sample.fits")).expect("open sample.fits");

    for file_entry in expected["files"].as_array().unwrap() {
        let fname = file_entry["file"].as_str().unwrap();
        let hdu = file_entry["hdu"].as_u64().unwrap() as usize;
        let wcs = Wcs::from_header(&fits.hdus[hdu].header);

        let text = std::fs::read_to_string(dir.join("regions").join(fname)).unwrap();
        let parsed = parse::parse(&text);
        assert!(
            parsed.warnings.is_empty(),
            "{fname}: unexpected warnings {:?}",
            parsed.warnings
        );

        let want_regions = file_entry["regions"].as_array().unwrap();
        assert_eq!(
            parsed.regions.len(),
            want_regions.len(),
            "{fname}: region count"
        );
        for (i, (region, want)) in parsed.regions.iter().zip(want_regions).enumerate() {
            let ctx = format!("{fname} region {i}");
            let pix = region
                .to_pixel(wcs.as_ref())
                .unwrap_or_else(|e| panic!("{ctx}: to_pixel failed: {e}"));
            check_shape(&pix.shape, want, &ctx);
            check_props(&pix, want, &ctx);
        }
    }
}
