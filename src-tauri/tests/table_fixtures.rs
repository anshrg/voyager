//! Ground-truth tests for the table reader against astropy-generated
//! fixtures (scripts/gen_fixtures.py writes the `table_checks` block of
//! expected.json). Covers BINTABLE and ASCII TABLE column metadata, cell
//! values, sort order, and filter counts. Regenerate fixtures with:
//!   scripts/venv/bin/python scripts/gen_fixtures.py

use voyager_lib::fits::FitsFile;
use voyager_lib::table::{Cell, FilterSpec, RowSource, SortSpec, Table};
use serde_json::Value as Json;
use std::path::PathBuf;

fn load() -> (FitsFile, Json) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures");
    let expected: Json = serde_json::from_str(
        &std::fs::read_to_string(dir.join("expected.json"))
            .expect("expected.json missing — run scripts/gen_fixtures.py"),
    )
    .unwrap();
    let file = FitsFile::open(&dir.join("sample.fits")).expect("open sample.fits");
    (file, expected)
}

/// Compare a Cell against expected JSON (number tolerant, string/int exact).
fn cell_matches(cell: &Cell, exp: &Json) -> bool {
    match (cell, exp) {
        (Cell::Null, Json::Null) => true,
        (Cell::Int(v), _) if exp.is_i64() => *v == exp.as_i64().unwrap(),
        (Cell::Int(v), _) if exp.is_f64() => (*v as f64 - exp.as_f64().unwrap()).abs() < 1e-9,
        (Cell::Float(v), _) if exp.is_number() => (v - exp.as_f64().unwrap()).abs() < 1e-4,
        (Cell::Str(s), Json::String(e)) => s == e,
        (Cell::Bool(b), Json::Bool(e)) => b == e,
        _ => false,
    }
}

#[test]
fn table_columns_cells_sort_filter_match_astropy() {
    let (file, expected) = load();
    let checks = expected["table_checks"].as_array().unwrap();
    assert!(!checks.is_empty(), "no table_checks in fixture");

    for chk in checks {
        let hdu = chk["hdu"].as_u64().unwrap() as usize;
        let table = Table::open(&file, hdu).expect("open table HDU");

        assert_eq!(table.nrows, chk["nrows"].as_u64().unwrap(), "hdu {hdu} nrows");

        // Column metadata.
        let cols = chk["columns"].as_array().unwrap();
        assert_eq!(table.columns.len(), cols.len(), "hdu {hdu} column count");
        for (c, exp) in table.columns.iter().zip(cols) {
            assert_eq!(c.name, exp["name"].as_str().unwrap(), "hdu {hdu} col name");
            let kind = format!("{:?}", c.kind).to_lowercase();
            assert_eq!(kind, exp["kind"].as_str().unwrap(), "hdu {hdu} col {} kind", c.name);
            assert_eq!(
                c.repeat as u64,
                exp["repeat"].as_u64().unwrap(),
                "hdu {hdu} col {} repeat",
                c.name
            );
            assert_eq!(c.sortable, exp["sortable"].as_bool().unwrap(), "hdu {hdu} col {} sortable", c.name);
            assert_eq!(c.unit.as_deref(), exp["unit"].as_str(), "hdu {hdu} col {} unit", c.name);
        }

        // Cell spot-checks.
        for cc in chk["cells"].as_array().unwrap() {
            let row = cc["row"].as_u64().unwrap();
            let col = cc["col"].as_u64().unwrap() as usize;
            let cell = table.cell(col, row);
            assert!(
                cell_matches(&cell, &cc["value"]),
                "hdu {hdu} cell ({row},{col}) = {cell:?}, expected {}",
                cc["value"]
            );
        }

        // Ascending sort: the first N rows of the view must match argsort.
        let sort = &chk["sort"];
        let spec = SortSpec {
            col: sort["col"].as_u64().unwrap() as usize,
            desc: sort["desc"].as_bool().unwrap(),
        };
        let view = table.build_view(Some(spec), None).expect("sort produces a view");
        let top: Vec<u64> = sort["top"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
        assert_eq!(&view[..top.len()], &top[..], "hdu {hdu} sort order (first {})", top.len());

        // Filters: resulting row count matches the reference.
        for f in chk["filters"].as_array().unwrap() {
            let spec = FilterSpec {
                col: f["col"].as_u64().unwrap() as usize,
                query: f["query"].as_str().unwrap().to_string(),
            };
            let view = table.build_view(None, Some(spec)).expect("filter produces a view");
            assert_eq!(
                view.len() as u64,
                f["count"].as_u64().unwrap(),
                "hdu {hdu} filter {:?} count",
                f["query"]
            );
        }
    }
}
