//! FITS BINTABLE writer: export a table view (or, later, a derived/joined
//! table) as a standalone FITS file. Pure logic (no Tauri types).
//!
//! Design: rows are streamed as **raw row bytes** — for a view over an
//! existing BINTABLE that's a bit-exact copy of the selected rows (same
//! TFORMs, same TSCAL/TZERO semantics), and a future derived table's row is
//! just `A-row bytes ++ B-row bytes ++ f64 separation`. Nothing is decoded
//! and re-encoded, so export can't drift from what the viewer shows.
//!
//! v1 scope: BINTABLE sources only (ASCII tables error cleanly — BACKLOG);
//! TTYPE/TFORM/TUNIT/TSCAL/TZERO cards are carried over. TNULL/TDISP aren't
//! parsed by the reader yet, so they aren't carried either (same BACKLOG).

use super::{Column, Layout, Table};
use std::io::Write;
use std::path::Path;

const BLOCK: usize = 2880;
const CARD: usize = 80;

/// Column cards for one output column.
#[derive(Debug, Clone)]
pub struct OutColumn {
    pub name: String,
    pub tform: String,
    pub unit: Option<String>,
    pub tscal: Option<f64>,
    pub tzero: Option<f64>,
}

impl OutColumn {
    /// Carry over a source column's cards. `scale`/`zero` live in the
    /// layout; only non-default values become cards.
    pub fn from_column(c: &Column) -> OutColumn {
        let (scale, zero) = match &c.layout {
            Layout::Binary { scale, zero, .. } | Layout::Ascii { scale, zero, .. } => {
                (*scale, *zero)
            }
        };
        OutColumn {
            name: c.name.clone(),
            tform: c.tform.clone(),
            unit: c.unit.clone(),
            tscal: (scale != 1.0).then_some(scale),
            tzero: (zero != 0.0).then_some(zero),
        }
    }
}

/// Write a complete FITS file (empty primary + one BINTABLE extension) to
/// `out`. `rows` must yield exactly `nrows` rows of exactly `row_width`
/// bytes each (checked). Returns the number of rows written.
pub fn write_bintable(
    out: &mut dyn Write,
    extname: Option<&str>,
    cols: &[OutColumn],
    row_width: usize,
    nrows: u64,
    rows: &mut dyn Iterator<Item = Result<Vec<u8>, String>>,
) -> Result<u64, String> {
    let io = |e: std::io::Error| format!("write failed: {e}");

    // ---- empty primary HDU --------------------------------------------------
    let mut h = HeaderBuf::new();
    h.logical("SIMPLE", true, "conforms to FITS standard");
    h.int("BITPIX", 8, "");
    h.int("NAXIS", 0, "");
    h.logical("EXTEND", true, "");
    out.write_all(&h.finish()).map_err(io)?;

    // ---- bintable header ----------------------------------------------------
    let mut h = HeaderBuf::new();
    h.string("XTENSION", "BINTABLE", "binary table extension");
    h.int("BITPIX", 8, "");
    h.int("NAXIS", 2, "");
    h.int("NAXIS1", row_width as i64, "bytes per row");
    h.int("NAXIS2", nrows as i64, "number of rows");
    h.int("PCOUNT", 0, "");
    h.int("GCOUNT", 1, "");
    h.int("TFIELDS", cols.len() as i64, "");
    if let Some(name) = extname {
        h.string("EXTNAME", name, "");
    }
    for (i, c) in cols.iter().enumerate() {
        let j = i + 1;
        h.string(&format!("TTYPE{j}"), &c.name, "");
        h.string(&format!("TFORM{j}"), &c.tform, "");
        if let Some(u) = &c.unit {
            h.string(&format!("TUNIT{j}"), u, "");
        }
        if let Some(s) = c.tscal {
            h.float(&format!("TSCAL{j}"), s, "");
        }
        if let Some(z) = c.tzero {
            h.float(&format!("TZERO{j}"), z, "");
        }
    }
    out.write_all(&h.finish()).map_err(io)?;

    // ---- row data + zero padding to a block boundary ------------------------
    let mut written = 0u64;
    for row in rows {
        let row = row?;
        if row.len() != row_width {
            return Err(format!(
                "row {written}: {} bytes, expected {row_width}",
                row.len()
            ));
        }
        out.write_all(&row).map_err(io)?;
        written += 1;
    }
    if written != nrows {
        return Err(format!("wrote {written} rows, header promised {nrows}"));
    }
    let data_len = (nrows as usize).saturating_mul(row_width);
    let pad = (BLOCK - data_len % BLOCK) % BLOCK;
    out.write_all(&vec![0u8; pad]).map_err(io)?;
    Ok(written)
}

/// Export a table's rows — mapped through `view` (a row-index permutation,
/// `None` = native order) — as a new FITS file at `out_path`. Returns the
/// number of rows written.
pub fn export_view(
    table: &Table,
    view: Option<&[u64]>,
    extname: Option<&str>,
    out_path: &Path,
) -> Result<u64, String> {
    // Raw row copy is only exact for BINTABLE layouts.
    if table
        .columns
        .iter()
        .any(|c| matches!(c.layout, Layout::Ascii { .. }))
    {
        return Err("exporting ASCII tables is not supported yet".to_string());
    }
    let cols: Vec<OutColumn> = table.columns.iter().map(OutColumn::from_column).collect();
    let nrows = view.map(|v| v.len() as u64).unwrap_or(table.nrows);

    let row_of = |r: u64| -> Result<Vec<u8>, String> {
        table
            .row_bytes(r)
            .map(|b| b.to_vec())
            .ok_or_else(|| format!("row {r} out of range (file truncated?)"))
    };
    let mut rows: Box<dyn Iterator<Item = Result<Vec<u8>, String>>> = match view {
        Some(v) => Box::new(v.iter().map(move |&r| row_of(r))),
        None => Box::new((0..table.nrows).map(move |r| row_of(r))),
    };

    let file = std::fs::File::create(out_path)
        .map_err(|e| format!("create {}: {e}", out_path.display()))?;
    let mut out = std::io::BufWriter::new(file);
    let written = write_bintable(&mut out, extname, &cols, table.row_width, nrows, &mut rows)?;
    out.flush().map_err(|e| format!("write failed: {e}"))?;
    Ok(written)
}

// ---- header card formatting -------------------------------------------------

/// Accumulates 80-byte cards and pads the header to a 2880 block on finish.
struct HeaderBuf {
    bytes: Vec<u8>,
}

impl HeaderBuf {
    fn new() -> HeaderBuf {
        HeaderBuf { bytes: Vec::with_capacity(BLOCK) }
    }

    fn push_card(&mut self, text: &str) {
        let mut card = [b' '; CARD];
        let src = text.as_bytes();
        let n = src.len().min(CARD);
        card[..n].copy_from_slice(&src[..n]);
        self.bytes.extend_from_slice(&card);
    }

    /// `KEYWORD = value / comment` with the value right-justified to col 30
    /// (fixed format).
    fn fixed(&mut self, key: &str, value: &str, comment: &str) {
        let mut s = format!("{key:<8}= {value:>20}");
        if !comment.is_empty() {
            s.push_str(" / ");
            s.push_str(comment);
        }
        self.push_card(&s);
    }

    fn logical(&mut self, key: &str, v: bool, comment: &str) {
        self.fixed(key, if v { "T" } else { "F" }, comment);
    }

    fn int(&mut self, key: &str, v: i64, comment: &str) {
        self.fixed(key, &v.to_string(), comment);
    }

    fn float(&mut self, key: &str, v: f64, comment: &str) {
        // Shortest round-trip repr; FITS wants an uppercase exponent and we
        // keep a decimal point so the value reads as real, not integer.
        let mut s = format!("{v}");
        if !s.contains('.') && !s.contains('e') && !s.contains('E') {
            s.push_str(".0");
        }
        self.fixed(key, &s.to_uppercase(), comment);
    }

    /// String card: opening quote at col 11, content padded to ≥8 chars,
    /// embedded single quotes doubled.
    fn string(&mut self, key: &str, v: &str, comment: &str) {
        let escaped = v.replace('\'', "''");
        // 68 = card minus "KEY     = '" and closing "'".
        let clipped: String = escaped.chars().take(68).collect();
        let mut s = format!("{key:<8}= '{clipped:<8}'");
        if !comment.is_empty() {
            s.push_str(" / ");
            s.push_str(comment);
        }
        self.push_card(&s);
    }

    fn finish(mut self) -> Vec<u8> {
        self.push_card("END");
        let pad = (BLOCK - self.bytes.len() % BLOCK) % BLOCK;
        let len = self.bytes.len() + pad;
        self.bytes.resize(len, b' ');
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_cards_are_80_bytes_and_block_padded() {
        let mut h = HeaderBuf::new();
        h.logical("SIMPLE", true, "c");
        h.int("BITPIX", 8, "");
        h.string("OBJECT", "O'NEILL", "escaped");
        let bytes = h.finish();
        assert_eq!(bytes.len(), BLOCK);
        let card0 = std::str::from_utf8(&bytes[..80]).unwrap();
        assert!(card0.starts_with("SIMPLE  =                    T / c"));
        // Escaped content is 8 bytes, so the closing quote sits at col 20
        // (the fixed-format minimum) with no extra padding needed.
        let card2 = std::str::from_utf8(&bytes[160..240]).unwrap();
        assert!(card2.starts_with("OBJECT  = 'O''NEILL' / escaped"), "{card2:?}");
        let card3 = std::str::from_utf8(&bytes[240..320]).unwrap();
        assert!(card3.starts_with("END"));
    }

    #[test]
    fn float_cards_read_as_reals() {
        let mut h = HeaderBuf::new();
        h.float("TZERO1", 32768.0, "");
        h.float("TSCAL1", 1.5e-7, "");
        let bytes = h.finish();
        let c0 = std::str::from_utf8(&bytes[..80]).unwrap();
        assert!(c0.contains("32768.0"), "{c0:?}");
        // Rust's shortest round-trip repr prints 1.5e-7 without an exponent;
        // either spelling is a valid FITS real, we just require a '.'.
        let c1 = std::str::from_utf8(&bytes[80..160]).unwrap();
        assert!(c1.contains("0.00000015"), "{c1:?}");
    }

    #[test]
    fn from_column_carries_unit_and_scaling_cards() {
        use super::super::ColKind;
        let col = Column {
            index: 0,
            name: "COUNTS".to_string(),
            unit: Some("adu".to_string()),
            tform: "I".to_string(),
            kind: ColKind::Int,
            repeat: 1,
            sortable: true,
            layout: Layout::Binary {
                offset: 0,
                elem: super::super::Elem::I16,
                repeat: 1,
                scale: 1.0,
                zero: 32768.0, // unsigned-short convention
            },
        };
        let out = OutColumn::from_column(&col);
        assert_eq!(out.name, "COUNTS");
        assert_eq!(out.tform, "I");
        assert_eq!(out.unit.as_deref(), Some("adu"));
        assert_eq!(out.tscal, None, "default scale writes no card");
        assert_eq!(out.tzero, Some(32768.0));
    }

    #[test]
    fn row_width_mismatch_is_an_error() {
        let cols = [OutColumn {
            name: "X".into(),
            tform: "J".into(),
            unit: None,
            tscal: None,
            tzero: None,
        }];
        let mut rows = vec![Ok(vec![0u8; 3])].into_iter();
        let mut out = Vec::new();
        let err = write_bintable(&mut out, None, &cols, 4, 1, &mut rows).unwrap_err();
        assert!(err.contains("expected 4"), "{err}");
    }

    #[test]
    fn row_count_mismatch_is_an_error() {
        let cols = [OutColumn {
            name: "X".into(),
            tform: "J".into(),
            unit: None,
            tscal: None,
            tzero: None,
        }];
        let mut rows = vec![Ok(vec![0u8; 4])].into_iter();
        let mut out = Vec::new();
        let err = write_bintable(&mut out, None, &cols, 4, 2, &mut rows).unwrap_err();
        assert!(err.contains("promised 2"), "{err}");
    }
}
