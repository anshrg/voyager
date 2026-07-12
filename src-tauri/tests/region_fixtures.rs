//! Ground-truth tests for DS9 region parsing + pixel conversion: the
//! astropy `regions` package (via scripts/gen_region_fixtures.py) writes
//! fixtures/regions/*.reg plus regions_expected.json holding the parsed
//! regions in pixel space; we must reproduce them. Regenerate with:
//!   scripts/venv/bin/python scripts/gen_region_fixtures.py

use voyager_lib::fits::FitsFile;
use voyager_lib::regions::{parse, write, PixelRegion, PixelShape};
use voyager_lib::wcs::Wcs;
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
        ("annulus", PixelShape::Annulus { x, y, rin, rout }) => {
            approx(*x, f("x"), &format!("{ctx} x"));
            approx(*y, f("y"), &format!("{ctx} y"));
            approx(*rin, f("rin"), &format!("{ctx} rin"));
            approx(*rout, f("rout"), &format!("{ctx} rout"));
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

        // Writer round-trip: serializing and re-parsing must reproduce the
        // regions exactly (the writer uses shortest-exact float formatting).
        let rewritten = parse::parse(&write::write_ds9(&parsed.regions));
        assert!(
            rewritten.warnings.is_empty(),
            "{fname} rewrite warnings: {:?}",
            rewritten.warnings
        );
        assert_eq!(rewritten.regions, parsed.regions, "{fname}: write round-trip");
    }
}

/// A representative set of edited/created pixel regions to round-trip.
fn sample_pixel_regions() -> Vec<PixelRegion> {
    let mk = |shape| PixelRegion {
        shape,
        include: true,
        color: Some("green".into()),
        width: None,
        dash: false,
        text: None,
        point: None,
    };
    vec![
        mk(PixelShape::Circle { x: 30.0, y: 25.0, r: 8.0 }),
        mk(PixelShape::Annulus { x: 28.0, y: 22.0, rin: 3.0, rout: 6.0 }),
        mk(PixelShape::Ellipse { x: 32.0, y: 26.0, rx: 9.0, ry: 4.0, angle: 25.0 }),
        mk(PixelShape::Box { x: 30.0, y: 24.0, w: 12.0, h: 6.0, angle: 40.0 }),
        // Circular ellipse: SVD direction is arbitrary, angle must carry through.
        mk(PixelShape::Ellipse { x: 30.0, y: 24.0, rx: 5.0, ry: 5.0, angle: 0.0 }),
        mk(PixelShape::Polygon { xs: vec![10.0, 20.0, 18.0], ys: vec![10.0, 12.0, 22.0] }),
        mk(PixelShape::Point { x: 15.0, y: 30.0 }),
    ]
}

/// Box/ellipse are symmetric under a 180° flip, so compare angles mod 180.
fn assert_pixel_close(got: &PixelShape, want: &PixelShape, tol: f64, ctx: &str) {
    let near = |a: f64, b: f64, what: &str| {
        assert!((a - b).abs() <= tol, "{ctx} {what}: got {a}, want {b}");
    };
    let ang180 = |a: f64, b: f64| {
        let d = (a - b).rem_euclid(180.0);
        assert!(d.min(180.0 - d) <= 1e-2, "{ctx} angle: got {a}, want {b}");
    };
    match (got, want) {
        (PixelShape::Circle { x, y, r }, PixelShape::Circle { x: bx, y: by, r: br }) => {
            near(*x, *bx, "x");
            near(*y, *by, "y");
            near(*r, *br, "r");
        }
        (
            PixelShape::Annulus { x, y, rin, rout },
            PixelShape::Annulus { x: bx, y: by, rin: brin, rout: brout },
        ) => {
            near(*x, *bx, "x");
            near(*y, *by, "y");
            near(*rin, *brin, "rin");
            near(*rout, *brout, "rout");
        }
        (
            PixelShape::Ellipse { x, y, rx, ry, angle },
            PixelShape::Ellipse { x: bx, y: by, rx: brx, ry: bry, angle: ba },
        ) => {
            near(*x, *bx, "x");
            near(*y, *by, "y");
            near(*rx, *brx, "rx");
            near(*ry, *bry, "ry");
            // A circular ellipse has no defined orientation; skip its angle.
            if (brx - bry).abs() > 1e-3 {
                ang180(*angle, *ba);
            }
        }
        (
            PixelShape::Box { x, y, w, h, angle },
            PixelShape::Box { x: bx, y: by, w: bw, h: bh, angle: ba },
        ) => {
            near(*x, *bx, "x");
            near(*y, *by, "y");
            near(*w, *bw, "w");
            near(*h, *bh, "h");
            if (bw - bh).abs() > 1e-3 {
                ang180(*angle, *ba);
            }
        }
        (PixelShape::Polygon { xs, ys }, PixelShape::Polygon { xs: bxs, ys: bys }) => {
            assert_eq!(xs.len(), bxs.len(), "{ctx} vertex count");
            for (i, (a, b)) in xs.iter().zip(bxs).enumerate() {
                near(*a, *b, &format!("x[{i}]"));
            }
            for (i, (a, b)) in ys.iter().zip(bys).enumerate() {
                near(*a, *b, &format!("y[{i}]"));
            }
        }
        (PixelShape::Point { x, y }, PixelShape::Point { x: bx, y: by }) => {
            near(*x, *bx, "x");
            near(*y, *by, "y");
        }
        (g, w) => panic!("{ctx}: shape mismatch {g:?} vs {w:?}"),
    }
}

/// Saving edited regions must round-trip: PixelRegion → image/sky Region →
/// back to pixel space reproduces the original. Image frame is exact; sky
/// frame goes through the WCS and the same SVD used on load, so it is exact
/// for conformal WCS (fixture variants) to a tight tolerance.
#[test]
fn pixel_region_save_round_trips() {
    let dir = fixtures_dir();
    let fits = FitsFile::open(&dir.join("sample.fits")).expect("open sample.fits");
    let expected: Json = serde_json::from_str(
        &std::fs::read_to_string(dir.join("regions_expected.json")).unwrap(),
    )
    .unwrap();
    let samples = sample_pixel_regions();

    for file_entry in expected["files"].as_array().unwrap() {
        let hdu = file_entry["hdu"].as_u64().unwrap() as usize;
        let wcs = Wcs::from_header(&fits.hdus[hdu].header);
        for pr in &samples {
            // Image frame: exact inverse of image_to_pixel.
            let img = pr.to_image_region().to_pixel(None).unwrap();
            assert_pixel_close(&img.shape, &pr.shape, 1e-9, "image round-trip");
            // Sky frame: through the WCS (both directions use the same SVD).
            if let Some(w) = wcs.as_ref() {
                let sky = pr.to_sky_region(w).unwrap().to_pixel(Some(w)).unwrap();
                assert_pixel_close(&sky.shape, &pr.shape, 1e-4, "sky round-trip");
            }
        }
    }
}
