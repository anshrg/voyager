//! Derived (joined) tables: the result of a crossmatch is just a list of
//! `(row_a, row_b, separation)` triples; cells are answered by delegating to
//! the two parent tables through their mmaps, so a 1M×1M join materializes
//! ~24 bytes/row, never the data (design decision #1 + issue #10).
//!
//! Join semantics carried by the row list itself: `1 and 2` rows have both
//! sides; `all from 1` (left join) rows may have `b: None` — right-side
//! cells and the separation render as `Cell::Null`.

use super::write::{write_bintable, OutColumn};
use super::{bin_field_bytes, Cell, ColKind, Column, Elem, Layout, RowSource, Table};
use std::path::Path;

/// One output row of a join: a left-table row, optionally matched to a
/// right-table row at `sep_deg` degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JoinRow {
    pub a: u64,
    pub b: Option<u64>,
    pub sep_deg: Option<f64>,
}

/// A joined view over two parent tables. Column layout: all of A's columns,
/// then all of B's (name collisions get `_1`/`_2` suffixes, case-insensitive),
/// then a `Separation` column in arcsec.
pub struct Joined<'a, 'b, 'r> {
    left: Table<'a>,
    right: Table<'b>,
    rows: &'r [JoinRow],
    columns: Vec<Column>,
    n_left: usize,
}

impl<'a, 'b, 'r> Joined<'a, 'b, 'r> {
    pub fn new(left: Table<'a>, right: Table<'b>, rows: &'r [JoinRow]) -> Joined<'a, 'b, 'r> {
        let columns = merged_columns(&left.columns, &right.columns);
        let n_left = left.columns.len();
        Joined { left, right, rows, columns, n_left }
    }

    /// Index of the appended separation column.
    pub fn separation_col(&self) -> usize {
        self.columns.len() - 1
    }

    /// Export the join — mapped through `view` when present — as a real FITS
    /// BINTABLE: raw A-row bytes ++ raw B-row bytes ++ big-endian f64
    /// separation (arcsec). Unmatched right sides are written as a null row
    /// (NaN floats, zero ints, blank strings) with a NaN separation.
    pub fn export(
        &self,
        view: Option<&[u64]>,
        extname: Option<&str>,
        out_path: &Path,
    ) -> Result<u64, String> {
        let left_w = contiguous_width(&self.left)?;
        let right_w = contiguous_width(&self.right)?;
        let row_width = left_w + right_w + 8;
        let null_right = null_row(&self.right.columns, right_w);

        let mut cols: Vec<OutColumn> = Vec::with_capacity(self.columns.len());
        for (i, meta) in self.columns.iter().enumerate() {
            let src = if i < self.n_left {
                Some(&self.left.columns[i])
            } else if i < self.n_left + self.right.columns.len() {
                Some(&self.right.columns[i - self.n_left])
            } else {
                None // Separation
            };
            let mut out = match src {
                Some(c) => OutColumn::from_column(c),
                None => OutColumn {
                    name: String::new(),
                    tform: "D".to_string(),
                    unit: Some("arcsec".to_string()),
                    tscal: None,
                    tzero: None,
                },
            };
            out.name = meta.name.clone(); // suffixed names
            cols.push(out);
        }

        let nrows = view.map(|v| v.len() as u64).unwrap_or(self.rows.len() as u64);
        let row_of = |i: u64| -> Result<Vec<u8>, String> {
            let jr = self
                .rows
                .get(i as usize)
                .ok_or_else(|| format!("join row {i} out of range"))?;
            let mut bytes = Vec::with_capacity(row_width);
            let a = self
                .left
                .row_bytes(jr.a)
                .ok_or_else(|| format!("left row {} out of range", jr.a))?;
            bytes.extend_from_slice(&a[..left_w]);
            match jr.b {
                Some(b) => {
                    let rb = self
                        .right
                        .row_bytes(b)
                        .ok_or_else(|| format!("right row {b} out of range"))?;
                    bytes.extend_from_slice(&rb[..right_w]);
                }
                None => bytes.extend_from_slice(&null_right),
            }
            let sep_arcsec = jr.sep_deg.map(|s| s * 3600.0).unwrap_or(f64::NAN);
            bytes.extend_from_slice(&sep_arcsec.to_be_bytes());
            Ok(bytes)
        };
        let mut rows: Box<dyn Iterator<Item = Result<Vec<u8>, String>>> = match view {
            Some(v) => Box::new(v.iter().map(|&i| row_of(i))),
            None => Box::new((0..self.rows.len() as u64).map(row_of)),
        };

        let file = std::fs::File::create(out_path)
            .map_err(|e| format!("create {}: {e}", out_path.display()))?;
        let mut out = std::io::BufWriter::new(file);
        let written = write_bintable(&mut out, extname, &cols, row_width, nrows, &mut rows)?;
        use std::io::Write as _;
        out.flush().map_err(|e| format!("write failed: {e}"))?;
        Ok(written)
    }
}

impl<'a, 'b, 'r> RowSource for Joined<'a, 'b, 'r> {
    fn columns(&self) -> &[Column] {
        &self.columns
    }

    fn nrows(&self) -> u64 {
        self.rows.len() as u64
    }

    fn cell(&self, col: usize, row: u64) -> Cell {
        let Some(jr) = self.rows.get(row as usize) else {
            return Cell::Null;
        };
        let n_right = self.right.columns.len();
        if col < self.n_left {
            self.left.cell(col, jr.a)
        } else if col < self.n_left + n_right {
            match jr.b {
                Some(b) => self.right.cell(col - self.n_left, b),
                None => Cell::Null,
            }
        } else if col == self.n_left + n_right {
            match jr.sep_deg {
                Some(s) => Cell::Float(s * 3600.0),
                None => Cell::Null,
            }
        } else {
            Cell::Null
        }
    }
}

/// A + B column metadata with `_1`/`_2` suffixes on (case-insensitive) name
/// collisions, then the `Separation` column.
fn merged_columns(left: &[Column], right: &[Column]) -> Vec<Column> {
    let collides = |name: &str, other: &[Column]| {
        other.iter().any(|c| c.name.eq_ignore_ascii_case(name))
    };
    let mut out = Vec::with_capacity(left.len() + right.len() + 1);
    for (side, cols, other) in [(1, left, right), (2, right, left)] {
        for c in cols {
            let mut c = c.clone();
            if collides(&c.name, other) {
                c.name = format!("{}_{side}", c.name);
            }
            c.index = out.len();
            out.push(c);
        }
    }
    let mut sep_name = "Separation".to_string();
    while out.iter().any(|c| c.name.eq_ignore_ascii_case(&sep_name)) {
        sep_name.push('_');
    }
    out.push(Column {
        index: out.len(),
        name: sep_name,
        unit: Some("arcsec".to_string()),
        tform: "D".to_string(),
        kind: ColKind::Float,
        repeat: 1,
        sortable: true,
        // Never consulted — Joined::cell answers this column directly.
        layout: Layout::Binary { offset: 0, elem: Elem::F64, repeat: 1, scale: 1.0, zero: 0.0 },
    });
    out
}

/// The width of a BINTABLE's contiguous field region. Errors if the row is
/// wider than its fields (gap/heap padding — raw re-export would misalign)
/// or if any column is ASCII-layout.
fn contiguous_width(t: &Table) -> Result<usize, String> {
    let mut w = 0usize;
    for c in &t.columns {
        match &c.layout {
            Layout::Binary { elem, repeat, .. } => w += bin_field_bytes(&c.tform, *elem, *repeat),
            Layout::Ascii { .. } => {
                return Err("exporting joins of ASCII tables is not supported yet".to_string())
            }
        }
    }
    if w > t.row_width {
        return Err(format!(
            "column widths ({w}) exceed row width ({}) — corrupt table?",
            t.row_width
        ));
    }
    Ok(w)
}

/// A right-side row for unmatched left rows: NaN floats, zero ints/logical,
/// blank strings.
fn null_row(cols: &[Column], width: usize) -> Vec<u8> {
    let mut row = vec![0u8; width];
    let mut offset = 0usize;
    for c in cols {
        let Layout::Binary { elem, repeat, .. } = &c.layout else {
            continue;
        };
        let field = bin_field_bytes(&c.tform, *elem, *repeat);
        match elem {
            Elem::Char => row[offset..offset + field].fill(b' '),
            Elem::F32 => {
                for i in 0..*repeat {
                    row[offset + i * 4..offset + i * 4 + 4]
                        .copy_from_slice(&f32::NAN.to_be_bytes());
                }
            }
            Elem::F64 => {
                for i in 0..*repeat {
                    row[offset + i * 8..offset + i * 8 + 8]
                        .copy_from_slice(&f64::NAN.to_be_bytes());
                }
            }
            _ => {} // ints/logical/opaque stay zero
        }
        offset += field;
    }
    row
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merged_columns_suffix_collisions_and_add_separation() {
        // Build two synthetic column sets sharing "RA" (case-insensitively).
        let mk = |name: &str| Column {
            index: 0,
            name: name.to_string(),
            unit: None,
            tform: "D".to_string(),
            kind: ColKind::Float,
            repeat: 1,
            sortable: true,
            layout: Layout::Binary { offset: 0, elem: Elem::F64, repeat: 1, scale: 1.0, zero: 0.0 },
        };
        let left = vec![mk("RA"), mk("FLUX_A")];
        let right = vec![mk("ra"), mk("FLUX_B")];
        let merged = merged_columns(&left, &right);
        let names: Vec<&str> = merged.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["RA_1", "FLUX_A", "ra_2", "FLUX_B", "Separation"]);
        assert!(merged.iter().enumerate().all(|(i, c)| c.index == i));
        let sep = merged.last().unwrap();
        assert_eq!(sep.unit.as_deref(), Some("arcsec"));
        assert!(sep.sortable);
    }

    #[test]
    fn separation_name_dodges_existing_column() {
        let mk = |name: &str| Column {
            index: 0,
            name: name.to_string(),
            unit: None,
            tform: "D".to_string(),
            kind: ColKind::Float,
            repeat: 1,
            sortable: true,
            layout: Layout::Binary { offset: 0, elem: Elem::F64, repeat: 1, scale: 1.0, zero: 0.0 },
        };
        let merged = merged_columns(&[mk("SEPARATION")], &[mk("X")]);
        assert_eq!(merged.last().unwrap().name, "Separation_");
    }

    #[test]
    fn null_row_fills_by_type() {
        let mk = |tform: &str, elem: Elem, repeat: usize, offset: usize| Column {
            index: 0,
            name: "C".to_string(),
            unit: None,
            tform: tform.to_string(),
            kind: ColKind::Float,
            repeat,
            sortable: false,
            layout: Layout::Binary { offset, elem, repeat, scale: 1.0, zero: 0.0 },
        };
        let cols = vec![
            mk("J", Elem::I32, 1, 0),
            mk("E", Elem::F32, 1, 4),
            mk("4A", Elem::Char, 4, 8),
            mk("2D", Elem::F64, 2, 12),
        ];
        let row = null_row(&cols, 4 + 4 + 4 + 16);
        assert_eq!(&row[0..4], &[0, 0, 0, 0]);
        assert!(f32::from_be_bytes(row[4..8].try_into().unwrap()).is_nan());
        assert_eq!(&row[8..12], b"    ");
        assert!(f64::from_be_bytes(row[12..20].try_into().unwrap()).is_nan());
        assert!(f64::from_be_bytes(row[20..28].try_into().unwrap()).is_nan());
    }
}
