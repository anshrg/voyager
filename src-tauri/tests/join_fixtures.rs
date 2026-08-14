//! Integration tests for derived (joined) tables: crossmatch the fixture
//! catalog with itself, wrap the pairs in a `Joined`, and check cell
//! routing, join semantics, view building, and FITS export round-trip.

use std::path::PathBuf;
use voyager_lib::fits::FitsFile;
use voyager_lib::table::join::{JoinRow, Joined};
use voyager_lib::table::{Cell, RowSource, SortSpec, Table};
use voyager_lib::xmatch::{crossmatch, MatchMode};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("fixtures")
}

fn out_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("voyager-join-tests");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

/// CATALOG (HDU 2) self-match: RA/DEC are strictly increasing linspaces, so
/// with a tight radius each row's best match is itself at separation 0.
fn self_match_rows(t: &Table) -> Vec<JoinRow> {
    let ra = t.column_f64(1);
    let dec = t.column_f64(2);
    let result = crossmatch(&ra, &dec, &ra, &dec, 0.1 / 3600.0, MatchMode::Best);
    assert_eq!(result.pairs.len() as u64, t.nrows, "every row matches itself");
    result
        .pairs
        .iter()
        .map(|p| {
            assert_eq!(p.a, p.b, "best match is the row itself");
            JoinRow { a: p.a, b: Some(p.b), sep_deg: Some(p.sep_deg) }
        })
        .collect()
}

#[test]
fn joined_cells_route_to_parents_and_separation() {
    let file = FitsFile::open(&fixtures().join("sample.fits")).unwrap();
    let left = Table::open(&file, 2).unwrap();
    let right = Table::open(&file, 2).unwrap();
    let rows = self_match_rows(&left);
    let j = Joined::new(left, right, &rows);

    let src = Table::open(&file, 2).unwrap();
    let ncol = src.columns.len();
    assert_eq!(j.columns().len(), 2 * ncol + 1);
    // Self-join: every name collides → all suffixed.
    for (i, c) in j.columns().iter().enumerate() {
        if i < ncol {
            assert_eq!(c.name, format!("{}_1", src.columns[i].name));
        } else if i < 2 * ncol {
            assert_eq!(c.name, format!("{}_2", src.columns[i - ncol].name));
        } else {
            assert_eq!(c.name, "Separation");
            assert_eq!(c.unit.as_deref(), Some("arcsec"));
        }
        assert_eq!(c.index, i);
    }
    assert_eq!(RowSource::nrows(&j), src.nrows);
    for row in [0u64, 5, 122] {
        for col in 0..ncol {
            assert_eq!(j.cell(col, row), src.cell(col, row), "left col {col} row {row}");
            assert_eq!(j.cell(ncol + col, row), src.cell(col, row), "right col {col} row {row}");
        }
        match j.cell(2 * ncol, row) {
            Cell::Float(s) => assert!(s.abs() < 1e-9, "self-match separation ~0, got {s}"),
            other => panic!("separation cell: {other:?}"),
        }
    }
    // Out of range → Null, not panic.
    assert_eq!(j.cell(0, 10_000), Cell::Null);
    assert_eq!(j.cell(2 * ncol + 1, 0), Cell::Null);
}

#[test]
fn unmatched_left_rows_have_null_right_and_separation() {
    let file = FitsFile::open(&fixtures().join("sample.fits")).unwrap();
    let left = Table::open(&file, 2).unwrap();
    let right = Table::open(&file, 2).unwrap();
    // "all from 1"-shaped rows: even rows matched to themselves, odd unmatched.
    let rows: Vec<JoinRow> = (0..left.nrows)
        .map(|a| {
            if a % 2 == 0 {
                JoinRow { a, b: Some(a), sep_deg: Some(0.0) }
            } else {
                JoinRow { a, b: None, sep_deg: None }
            }
        })
        .collect();
    let j = Joined::new(left, right, &rows);
    let src = Table::open(&file, 2).unwrap();
    let ncol = src.columns.len();

    for row in [1u64, 3, 121] {
        assert_eq!(j.cell(0, row), src.cell(0, row), "left side still present");
        for col in 0..ncol {
            assert_eq!(j.cell(ncol + col, row), Cell::Null, "right col {col} is null");
        }
        assert_eq!(j.cell(2 * ncol, row), Cell::Null, "separation is null");
    }

    // Sorting by Separation puts the null (unmatched) rows last.
    let view = j.build_view(Some(SortSpec { col: 2 * ncol, desc: false }), None).unwrap();
    let n = view.len();
    assert_eq!(n as u64, src.nrows);
    assert!(view[..n / 2].iter().all(|&r| r % 2 == 0), "matched rows first");
    assert!(view[n / 2 + 1..].iter().all(|&r| r % 2 == 1), "unmatched rows last");
}

#[test]
fn joined_export_round_trips_through_reader() {
    let file = FitsFile::open(&fixtures().join("sample.fits")).unwrap();
    let left = Table::open(&file, 2).unwrap();
    let right = Table::open(&file, 2).unwrap();
    // Mixed rows incl. an unmatched one, exported through a reordering view.
    let mut rows = self_match_rows(&left);
    rows[7] = JoinRow { a: 7, b: None, sep_deg: None };
    let j = Joined::new(left, right, &rows);
    let view: Vec<u64> = (0..rows.len() as u64).rev().collect();

    let path = out_path("joined.fits");
    let n = j.export(Some(&view), Some("XMATCH_TEST"), &path).unwrap();
    assert_eq!(n as usize, rows.len());

    let out_file = FitsFile::open(&path).unwrap();
    let exported = Table::open(&out_file, 1).unwrap();
    assert_eq!(exported.nrows as usize, rows.len());
    assert_eq!(exported.columns.len(), j.columns().len());
    for (a, b) in j.columns().iter().zip(&exported.columns) {
        assert_eq!(a.name, b.name);
        assert_eq!(a.tform, b.tform);
        assert_eq!(a.unit, b.unit);
    }
    for out_row in 0..exported.nrows {
        let src_row = view[out_row as usize];
        for col in 0..j.columns().len() {
            let want = match j.cell(col, src_row) {
                // Unmatched int/logical cells export as zero (no TNULL yet).
                Cell::Null if !matches!(exported.cell(col, out_row), Cell::Null) => {
                    let got = exported.cell(col, out_row);
                    assert!(
                        got == Cell::Int(0) || got == Cell::Str(String::new()) || got == Cell::Bool(false),
                        "null col {col} row {out_row} exported as {got:?}"
                    );
                    continue;
                }
                c => c,
            };
            assert_eq!(exported.cell(col, out_row), want, "col {col} out-row {out_row}");
        }
    }
}
