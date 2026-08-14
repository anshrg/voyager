//! Chunk-boundary tests for the streaming column extractor
//! (`Table::extract_columns`). The astropy fixtures gate cell-value
//! correctness but are far smaller than one 8 MB read chunk, so this
//! builds a synthetic multi-chunk BINTABLE (and a truncated variant) and
//! checks the streamed path against the bounds-checked per-cell path.

use voyager_lib::fits::FitsFile;
use voyager_lib::table::{Cell, RowSource, Table};

fn card(text: &str) -> [u8; 80] {
    let mut c = [b' '; 80];
    c[..text.len()].copy_from_slice(text.as_bytes());
    c
}

fn pad_block(bytes: &mut Vec<u8>) {
    while bytes.len() % 2880 != 0 {
        bytes.push(b' ');
    }
}

/// A minimal FITS file: empty primary HDU + one BINTABLE with columns
/// IDX (K) and VAL (D), where row r holds (r, r * 0.5). `data_rows` rows of
/// data are written while the header claims `header_rows` (equal for a
/// well-formed file; smaller to fake a truncated file).
fn synth_fits(header_rows: usize, data_rows: usize) -> Vec<u8> {
    let mut out = Vec::new();
    for t in ["SIMPLE  =                    T", "BITPIX  =                    8", "NAXIS   =                    0", "END"] {
        out.extend_from_slice(&card(t));
    }
    pad_block(&mut out);
    for t in [
        "XTENSION= 'BINTABLE'",
        "BITPIX  =                    8",
        "NAXIS   =                    2",
        "NAXIS1  =                   16",
        &format!("NAXIS2  = {header_rows:>20}"),
        "PCOUNT  =                    0",
        "GCOUNT  =                    1",
        "TFIELDS =                    2",
        "TTYPE1  = 'IDX     '",
        "TFORM1  = 'K       '",
        "TTYPE2  = 'VAL     '",
        "TFORM2  = 'D       '",
        "END",
    ] {
        out.extend_from_slice(&card(t));
    }
    pad_block(&mut out);
    for r in 0..data_rows {
        out.extend_from_slice(&(r as i64).to_be_bytes());
        out.extend_from_slice(&(r as f64 * 0.5).to_be_bytes());
    }
    // Data padding block only for the well-formed file; the truncated
    // variant ends mid-data on purpose.
    if data_rows == header_rows {
        pad_block(&mut out);
    }
    out
}

fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("voyager-test-{name}-{}.fits", std::process::id()));
    std::fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn multi_chunk_extraction_matches_per_cell_path() {
    // 16-byte rows → 524288 rows per 8 MB chunk; 1.2M rows → two full
    // chunks plus a partial one.
    let n = 1_200_000usize;
    let path = write_temp("stream", &synth_fits(n, n));
    let file = FitsFile::open(&path).unwrap();
    let table = Table::open(&file, 1).unwrap();
    assert_eq!(table.nrows, n as u64);

    let cols = table.extract_columns(&[0, 1]);
    assert_eq!(cols[0].len(), n);
    assert_eq!(cols[1].len(), n);
    for r in 0..n {
        assert_eq!(cols[0][r], Cell::Int(r as i64), "IDX row {r}");
        assert_eq!(cols[1][r], Cell::Float(r as f64 * 0.5), "VAL row {r}");
    }
    drop(file);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn truncated_file_yields_null_tail_like_per_cell_path() {
    // Header claims 40000 rows, data holds 30000 (plus a ragged half row):
    // both paths must agree cell-for-cell, with Null past the last full row.
    let (claimed, actual) = (40_000usize, 30_000usize);
    let mut bytes = synth_fits(claimed, actual);
    bytes.extend_from_slice(&[0u8; 7]); // ragged partial row
    let path = write_temp("truncated", &bytes);
    let file = FitsFile::open(&path).unwrap();
    let table = Table::open(&file, 1).unwrap();
    assert_eq!(table.nrows, claimed as u64);

    let cols = table.extract_columns(&[0, 1]);
    for r in 0..claimed {
        let want = (table.cell(0, r as u64), table.cell(1, r as u64));
        assert_eq!((cols[0][r].clone(), cols[1][r].clone()), want, "row {r}");
        if r >= actual {
            assert_eq!(cols[0][r], Cell::Null, "tail row {r} should be Null");
        }
    }
    drop(file);
    let _ = std::fs::remove_file(&path);
}
