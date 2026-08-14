//! Ground-truth tests for the xmatch module against astropy-generated
//! fixtures (`scripts/gen_xmatch_fixtures.py` writes
//! `fixtures/xmatch_expected.json` from `match_to_catalog_sky` /
//! `search_around_sky`). Scenarios cover issue #10's edge cases: RA wrap,
//! pole proximity, exact-radius boundary, duplicate positions, NaN rows.

use serde_json::Value as Json;
use std::path::PathBuf;
use voyager_lib::xmatch::{crossmatch, MatchMode};

/// Separation agreement tolerance: 1 µas (issue #10 asks for ~1 µas).
const SEP_TOL_DEG: f64 = 1e-6 / 3600.0;

fn load() -> Json {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures/xmatch_expected.json");
    serde_json::from_str(
        &std::fs::read_to_string(&path)
            .expect("xmatch_expected.json missing — run scripts/gen_xmatch_fixtures.py"),
    )
    .unwrap()
}

/// A coordinate array with JSON null → NaN.
fn coords(v: &Json) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap_or(f64::NAN))
        .collect()
}

fn triples(v: &Json) -> Vec<(u64, u64, f64)> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let t = t.as_array().unwrap();
            (
                t[0].as_u64().unwrap(),
                t[1].as_u64().unwrap(),
                t[2].as_f64().unwrap(),
            )
        })
        .collect()
}

#[test]
fn crossmatch_matches_astropy() {
    let expected = load();
    let scenarios = expected["scenarios"].as_array().unwrap();
    assert!(!scenarios.is_empty(), "no scenarios in fixture");

    for sc in scenarios {
        let name = sc["name"].as_str().unwrap();
        let radius_deg = sc["radius_arcsec"].as_f64().unwrap() / 3600.0;
        let (ra_a, dec_a) = (coords(&sc["ra_a"]), coords(&sc["dec_a"]));
        let (ra_b, dec_b) = (coords(&sc["ra_b"]), coords(&sc["dec_b"]));

        // Skipped-row accounting matches the fixture's valid counts.
        let skipped_a_exp = ra_a.len() - sc["n_valid_a"].as_u64().unwrap() as usize;
        let skipped_b_exp = ra_b.len() - sc["n_valid_b"].as_u64().unwrap() as usize;

        // ---- All pairs vs search_around_sky --------------------------------
        let got = crossmatch(&ra_a, &dec_a, &ra_b, &dec_b, radius_deg, MatchMode::All);
        assert_eq!(got.skipped_a, skipped_a_exp, "{name}: skipped_a");
        assert_eq!(got.skipped_b, skipped_b_exp, "{name}: skipped_b");

        let want = triples(&sc["all"]);
        let mut got_all: Vec<(u64, u64, f64)> =
            got.pairs.iter().map(|p| (p.a, p.b, p.sep_deg)).collect();
        got_all.sort_by(|x, y| x.0.cmp(&y.0).then(x.1.cmp(&y.1)));
        assert_eq!(
            got_all.len(),
            want.len(),
            "{name}: all-pair count (got {:?} want {:?})",
            got_all.iter().map(|p| (p.0, p.1)).collect::<Vec<_>>(),
            want.iter().map(|p| (p.0, p.1)).collect::<Vec<_>>(),
        );
        for (g, w) in got_all.iter().zip(&want) {
            assert_eq!((g.0, g.1), (w.0, w.1), "{name}: all-pair identity");
            assert!(
                (g.2 - w.2).abs() < SEP_TOL_DEG,
                "{name}: all-pair sep {} vs {}",
                g.2,
                w.2
            );
        }

        // ---- Best pairs vs match_to_catalog_sky ----------------------------
        let got = crossmatch(&ra_a, &dec_a, &ra_b, &dec_b, radius_deg, MatchMode::Best);
        let want = triples(&sc["best"]);
        assert_eq!(got.pairs.len(), want.len(), "{name}: best-pair count");
        for (g, w) in got.pairs.iter().zip(&want) {
            assert_eq!(g.a, w.0, "{name}: best-pair A row");
            assert!(
                (g.sep_deg - w.2).abs() < SEP_TOL_DEG,
                "{name}: best sep for A row {} — {} vs {}",
                g.a,
                g.sep_deg,
                w.2
            );
            // Nearest-neighbour ties between duplicate B positions break
            // arbitrarily in astropy; compare the matched *coordinates*,
            // not the index.
            let (gb, wb) = (g.b as usize, w.1 as usize);
            assert!(
                (ra_b[gb] - ra_b[wb]).abs() < 1e-12 && (dec_b[gb] - dec_b[wb]).abs() < 1e-12,
                "{name}: best B position for A row {} — row {} vs {}",
                g.a,
                gb,
                wb
            );
        }
    }
}

/// Issue #10 acceptance: 1M × 1M best-match in < 2 s (index build + query).
/// Ignored by default — run in release mode where it's meaningful:
///   cargo test --release --test xmatch_fixtures -- --ignored
#[test]
#[ignore]
fn million_by_million_under_two_seconds() {
    // Deterministic pseudo-random field, ~3 deg on a side (no rand dep).
    let mut state = 0x243f6a8885a308d3u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1u64 << 53) as f64
    };
    let n = 1_000_000;
    let mut ra_a = Vec::with_capacity(n);
    let mut dec_a = Vec::with_capacity(n);
    let mut ra_b = Vec::with_capacity(n);
    let mut dec_b = Vec::with_capacity(n);
    for _ in 0..n {
        ra_a.push(150.0 + next() * 3.0);
        dec_a.push(next() * 3.0);
        ra_b.push(150.0 + next() * 3.0);
        dec_b.push(next() * 3.0);
    }
    let t0 = std::time::Instant::now();
    let result = crossmatch(&ra_a, &dec_a, &ra_b, &dec_b, 1.0 / 3600.0, MatchMode::Best);
    let elapsed = t0.elapsed();
    eprintln!(
        "1M x 1M best-match: {} pairs in {:.3} s",
        result.pairs.len(),
        elapsed.as_secs_f64()
    );
    assert!(!result.pairs.is_empty());
    assert!(
        elapsed.as_secs_f64() < 2.0,
        "1M x 1M took {:.3} s (target < 2 s)",
        elapsed.as_secs_f64()
    );
}
