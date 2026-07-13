//! Round-trip tests for the BINTABLE writer: export a view of the fixture
//! catalog, reopen the output with our own reader, and compare metadata +
//! every cell against the source through the view permutation. (Raw row
//! bytes are copied verbatim, so cells must match *exactly*.) astropy
//! readability of the output is verified out-of-band — same pattern as the
//! region writer (see docs/STATE.md).

use std::path::PathBuf;
use voyager_lib::fits::FitsFile;
use voyager_lib::table::{write::export_view, FilterSpec, SortSpec, Table};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("fixtures")
}

fn out_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("voyager-table-write-tests");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

/// Compare every cell of `exported` against `src` mapped through `view`.
fn assert_cells_match(src: &Table, view: Option<&[u64]>, exported: &Table) {
    let nrows = view.map(|v| v.len() as u64).unwrap_or(src.nrows);
    assert_eq!(exported.nrows, nrows, "row count");
    assert_eq!(exported.columns.len(), src.columns.len(), "column count");
    for (a, b) in src.columns.iter().zip(&exported.columns) {
        assert_eq!(a.name, b.name);
        assert_eq!(a.tform, b.tform);
        assert_eq!(a.unit, b.unit);
        assert_eq!(a.kind, b.kind);
        assert_eq!(a.repeat, b.repeat);
    }
    for out_row in 0..nrows {
        let src_row = view.map(|v| v[out_row as usize]).unwrap_or(out_row);
        for c in 0..src.columns.len() {
            assert_eq!(
                exported.cell(c, out_row),
                src.cell(c, src_row),
                "cell col {c} out-row {out_row} (src row {src_row})"
            );
        }
    }
}

#[test]
fn identity_export_round_trips() {
    let file = FitsFile::open(&fixtures().join("sample.fits")).unwrap();
    // HDU 2 = CATALOG bintable (see gen_fixtures.py).
    let src = Table::open(&file, 2).unwrap();
    let path = out_path("identity.fits");

    let n = export_view(&src, None, Some("CATALOG"), &path).unwrap();
    assert_eq!(n, src.nrows);

    let out_file = FitsFile::open(&path).unwrap();
    // HDU 0 is the empty primary; the table is HDU 1.
    let exported = Table::open(&out_file, 1).unwrap();
    assert_cells_match(&src, None, &exported);
}

#[test]
fn sorted_filtered_view_export_round_trips() {
    let file = FitsFile::open(&fixtures().join("sample.fits")).unwrap();
    let src = Table::open(&file, 2).unwrap();
    // Sort by FLUX (col 3) descending, filter ID (col 0) > 40 — the same
    // spec shapes the astropy-gated table fixtures use.
    let view = src
        .build_view(
            Some(SortSpec { col: 3, desc: true }),
            Some(FilterSpec { col: 0, query: ">40".to_string() }),
        )
        .expect("non-identity view");
    assert!(!view.is_empty() && (view.len() as u64) < src.nrows, "view is a strict subset");
    let path = out_path("view.fits");

    let n = export_view(&src, Some(&view), Some("MATCHED"), &path).unwrap();
    assert_eq!(n as usize, view.len());

    let out_file = FitsFile::open(&path).unwrap();
    let exported = Table::open(&out_file, 1).unwrap();
    assert_cells_match(&src, Some(&view), &exported);
}

#[test]
fn empty_view_export_round_trips() {
    let file = FitsFile::open(&fixtures().join("sample.fits")).unwrap();
    let src = Table::open(&file, 2).unwrap();
    let path = out_path("empty.fits");

    let n = export_view(&src, Some(&[]), None, &path).unwrap();
    assert_eq!(n, 0);

    let out_file = FitsFile::open(&path).unwrap();
    let exported = Table::open(&out_file, 1).unwrap();
    assert_eq!(exported.nrows, 0);
    assert_eq!(exported.columns.len(), src.columns.len());
}

#[test]
fn ascii_table_export_errors_cleanly() {
    let file = FitsFile::open(&fixtures().join("sample.fits")).unwrap();
    // HDU 6 = ASCIICAT ascii table (WCS-variant image HDUs sit at 3–5).
    let src = Table::open(&file, 6).unwrap();
    let err = export_view(&src, None, None, &out_path("ascii.fits")).unwrap_err();
    assert!(err.contains("ASCII"), "{err}");
}
