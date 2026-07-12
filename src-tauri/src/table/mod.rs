//! FITS table reading: BINTABLE and ASCII TABLE column metadata, windowed
//! row reads, and sort/filter "views". Pure logic (no Tauri types) so it
//! unit-tests against astropy fixtures like the rest of the backend.
//!
//! Design:
//! - Nothing is read into RAM at open; cells are pulled from the mmap on
//!   demand (bounds-checked), so opening a million-row catalog is instant.
//! - A `view` is a permutation of row indices produced by sort/filter. The
//!   identity view (no sort, no filter) is represented as `None` so we never
//!   allocate an index array for the common "just scroll it" case.
//! - Correctness is gated on fixtures: `scripts/gen_fixtures.py` writes the
//!   table + expected column/cell/sort JSON, `tests/table_fixtures.rs` checks.

use crate::fits::{FitsFile, HduKind};
use serde::Serialize;
use std::cmp::Ordering;

/// A cell value. Serialized untagged so JSON carries a bare number / string /
/// bool / null — the frontend renders it directly.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Cell {
    /// Blank / NaN / undefined.
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
}

impl Cell {
    /// Numeric key for sorting/filtering; non-numeric → NaN (sorts last).
    fn as_f64(&self) -> f64 {
        match self {
            Cell::Int(v) => *v as f64,
            Cell::Float(v) => *v,
            Cell::Bool(b) => {
                if *b {
                    1.0
                } else {
                    0.0
                }
            }
            _ => f64::NAN,
        }
    }

    /// Display string used for the string-filter fallback and sort keys.
    fn as_display(&self) -> String {
        match self {
            Cell::Null => String::new(),
            Cell::Bool(b) => (if *b { "T" } else { "F" }).to_string(),
            Cell::Int(v) => v.to_string(),
            Cell::Float(v) => format_float(*v),
            Cell::Str(s) => s.clone(),
        }
    }
}

/// Broad column category the frontend uses for alignment and sort affordances.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ColKind {
    Logical,
    Int,
    Float,
    Str,
    /// Vector, complex, bit, or variable-length: shown as text, not sortable.
    Other,
}

/// How to pull one column's cell out of a row's bytes.
#[derive(Debug, Clone)]
enum Layout {
    /// BINTABLE field: `repeat` elements of `elem`, at `offset` in the row.
    Binary {
        offset: usize,
        elem: Elem,
        repeat: usize,
        scale: f64,
        zero: f64,
    },
    /// ASCII TABLE field: fixed-width text slice parsed as `fmt`.
    Ascii {
        start: usize,
        width: usize,
        fmt: AsciiFmt,
        scale: f64,
        zero: f64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Elem {
    Logical, // L, 1 byte
    U8,      // B, 1 byte unsigned
    I16,     // I, 2 bytes
    I32,     // J, 4 bytes
    I64,     // K, 8 bytes
    F32,     // E, 4 bytes
    F64,     // D, 8 bytes
    Char,    // A, 1 byte per char (string)
    /// X (bits), C/M (complex), P/Q (var-length): read as a placeholder.
    Opaque(usize), // bytes per element
}

impl Elem {
    fn bytes(self) -> usize {
        match self {
            Elem::Logical | Elem::U8 | Elem::Char => 1,
            Elem::I16 => 2,
            Elem::I32 | Elem::F32 => 4,
            Elem::I64 | Elem::F64 => 8,
            Elem::Opaque(n) => n,
        }
    }

    fn is_int(self) -> bool {
        matches!(self, Elem::U8 | Elem::I16 | Elem::I32 | Elem::I64)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum AsciiFmt {
    Str,
    Int,
    Float,
}

/// Column metadata exposed to the frontend (`layout` stays internal).
#[derive(Debug, Clone, Serialize)]
pub struct Column {
    pub index: usize,
    pub name: String,
    pub unit: Option<String>,
    pub tform: String,
    pub kind: ColKind,
    /// Element count (string length for `A`/text columns).
    pub repeat: usize,
    /// Scalar numeric / logical / string columns can drive a sort.
    pub sortable: bool,
    #[serde(skip)]
    layout: Layout,
}

/// A parsed table bound to its file, ready for cell/page/view reads.
pub struct Table<'f> {
    file: &'f FitsFile,
    pub columns: Vec<Column>,
    data_offset: usize,
    row_width: usize,
    pub nrows: u64,
}

/// A column to sort by, ascending unless `desc`.
#[derive(Debug, Clone, Copy)]
pub struct SortSpec {
    pub col: usize,
    pub desc: bool,
}

/// A filter on one column. `query` is a numeric predicate (`>3`, `<=5`,
/// `1..10`, `=4`) on numeric columns, else a case-insensitive substring.
#[derive(Debug, Clone)]
pub struct FilterSpec {
    pub col: usize,
    pub query: String,
}

impl<'f> Table<'f> {
    pub fn open(file: &'f FitsFile, hdu_index: usize) -> Result<Table<'f>, String> {
        let hdu = file.hdu(hdu_index).map_err(|e| e.to_string())?;
        let ascii = match hdu.kind {
            HduKind::AsciiTable => true,
            HduKind::BinTable => false,
            _ => return Err("HDU is not a table".to_string()),
        };
        let header = &hdu.header;
        let tfields = header.get_i64("TFIELDS").unwrap_or(0).max(0) as usize;
        let row_width = header.get_i64("NAXIS1").unwrap_or(0).max(0) as usize;
        let nrows = header.get_i64("NAXIS2").unwrap_or(0).max(0) as u64;

        let mut columns = Vec::with_capacity(tfields);
        let mut bin_offset = 0usize;
        for j in 1..=tfields {
            let tform = header
                .get_str(&format!("TFORM{j}"))
                .ok_or_else(|| format!("column {j}: missing TFORM{j}"))?
                .trim()
                .to_string();
            let name = header
                .get_str(&format!("TTYPE{j}"))
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|| format!("col{j}"));
            let unit = header
                .get_str(&format!("TUNIT{j}"))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let scale = header.get_f64(&format!("TSCAL{j}")).unwrap_or(1.0);
            let zero = header.get_f64(&format!("TZERO{j}")).unwrap_or(0.0);

            let (kind, repeat, sortable, layout) = if ascii {
                let start = header
                    .get_i64(&format!("TBCOL{j}"))
                    .ok_or_else(|| format!("column {j}: missing TBCOL{j}"))?
                    .max(1) as usize
                    - 1;
                let (fmt, width) = parse_ascii_tform(&tform)
                    .ok_or_else(|| format!("column {j}: bad ASCII TFORM {tform:?}"))?;
                let kind = match fmt {
                    AsciiFmt::Str => ColKind::Str,
                    AsciiFmt::Int => ColKind::Int,
                    AsciiFmt::Float => ColKind::Float,
                };
                (
                    kind,
                    width,
                    true,
                    Layout::Ascii { start, width, fmt, scale, zero },
                )
            } else {
                let (repeat, elem) = parse_bin_tform(&tform)
                    .ok_or_else(|| format!("column {j}: bad TFORM {tform:?}"))?;
                let field_bytes = match elem {
                    // X is a bit array: repeat bits packed into ceil/8 bytes.
                    Elem::Opaque(_) if tform.to_ascii_uppercase().contains('X') => {
                        repeat.div_ceil(8)
                    }
                    _ => repeat * elem.bytes(),
                };
                let offset = bin_offset;
                bin_offset += field_bytes;
                let is_text = elem == Elem::Char;
                let scalar = repeat == 1 && matches!(elem, Elem::Logical | Elem::U8 | Elem::I16 | Elem::I32 | Elem::I64 | Elem::F32 | Elem::F64);
                let kind = if is_text {
                    ColKind::Str
                } else if !scalar {
                    ColKind::Other
                } else if elem == Elem::Logical {
                    ColKind::Logical
                } else if elem.is_int() {
                    ColKind::Int
                } else {
                    ColKind::Float
                };
                // Text columns and scalars are sortable; vectors/opaque aren't.
                let sortable = is_text || scalar;
                (
                    kind,
                    repeat,
                    sortable,
                    Layout::Binary { offset, elem, repeat, scale, zero },
                )
            };

            columns.push(Column {
                index: j - 1,
                name,
                unit,
                tform,
                kind,
                repeat,
                sortable,
                layout,
            });
        }

        Ok(Table {
            file,
            columns,
            data_offset: hdu.data_offset as usize,
            row_width,
            nrows,
        })
    }

    fn row_bytes(&self, row: u64) -> Option<&[u8]> {
        let start = self.data_offset.checked_add((row as usize).checked_mul(self.row_width)?)?;
        let end = start.checked_add(self.row_width)?;
        self.file.data().get(start..end)
    }

    /// One cell (bounds-checked; out-of-range or unparseable → `Cell::Null`).
    pub fn cell(&self, col: usize, row: u64) -> Cell {
        let Some(column) = self.columns.get(col) else {
            return Cell::Null;
        };
        let Some(bytes) = self.row_bytes(row) else {
            return Cell::Null;
        };
        match &column.layout {
            Layout::Binary { offset, elem, repeat, scale, zero } => {
                read_binary(bytes, *offset, *elem, *repeat, *scale, *zero)
            }
            Layout::Ascii { start, width, fmt, scale, zero } => {
                read_ascii(bytes, *start, *width, *fmt, *scale, *zero)
            }
        }
    }

    /// Every row of one column as f64 (Null/non-numeric → NaN), in native row
    /// order. Used to bulk-project a catalog's RA/Dec onto an image frame
    /// (cross-file source overlay) without boxing every column through JSON.
    pub fn column_f64(&self, col: usize) -> Vec<f64> {
        (0..self.nrows).map(|r| self.cell(col, r).as_f64()).collect()
    }

    /// A window of rows (`start`..start+count`) as cell rows, mapped through
    /// `view` (a row-index permutation) when present.
    pub fn page(&self, view: Option<&[u64]>, start: u64, count: u64) -> Vec<Vec<Cell>> {
        let ncol = self.columns.len();
        let mut out = Vec::new();
        for i in start..start.saturating_add(count) {
            let row = match view {
                Some(v) => match v.get(i as usize) {
                    Some(&r) => r,
                    None => break,
                },
                None => {
                    if i >= self.nrows {
                        break;
                    }
                    i
                }
            };
            let mut cells = Vec::with_capacity(ncol);
            for c in 0..ncol {
                cells.push(self.cell(c, row));
            }
            out.push(cells);
        }
        out
    }

    /// Build a row-index view for the given sort/filter. Returns `None` for
    /// the identity view (no sort, no filter) so huge tables pay nothing.
    pub fn build_view(
        &self,
        sort: Option<SortSpec>,
        filter: Option<FilterSpec>,
    ) -> Option<Vec<u64>> {
        if sort.is_none() && filter.is_none() {
            return None;
        }

        // Start from the filtered set (or all rows).
        let mut idx: Vec<u64> = match &filter {
            Some(f) => {
                let pred = Predicate::parse(f, self.columns.get(f.col).map(|c| c.kind));
                (0..self.nrows)
                    .filter(|&r| pred.matches(&self.cell(f.col, r)))
                    .collect()
            }
            None => (0..self.nrows).collect(),
        };

        if let Some(s) = sort {
            let numeric = matches!(
                self.columns.get(s.col).map(|c| c.kind),
                Some(ColKind::Int) | Some(ColKind::Float) | Some(ColKind::Logical)
            );
            if numeric {
                let mut keyed: Vec<(f64, u64)> =
                    idx.iter().map(|&r| (self.cell(s.col, r).as_f64(), r)).collect();
                keyed.sort_by(|a, b| cmp_f64_nan_last(a.0, b.0).then(a.1.cmp(&b.1)));
                if s.desc {
                    keyed.reverse();
                }
                idx = keyed.into_iter().map(|(_, r)| r).collect();
            } else {
                let mut keyed: Vec<(String, u64)> = idx
                    .iter()
                    .map(|&r| (self.cell(s.col, r).as_display(), r))
                    .collect();
                keyed.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
                if s.desc {
                    keyed.reverse();
                }
                idx = keyed.into_iter().map(|(_, r)| r).collect();
            }
        }

        Some(idx)
    }
}

/// Sort comparator putting NaN last regardless of direction (reversal of the
/// ascending order then flips finite values but we want NaN at the end; the
/// caller reverses the whole vec, so we keep NaN "large" here and accept that
/// desc puts NaN first — matching how spreadsheets surface blanks on desc).
fn cmp_f64_nan_last(a: f64, b: f64) -> Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => a.partial_cmp(&b).unwrap_or(Ordering::Equal),
    }
}

/// A parsed column filter.
enum Predicate {
    Cmp(Ordering, f64, bool), // ordering vs value; bool = also accept equal
    Range(f64, f64),
    Substr(String),
}

impl Predicate {
    fn parse(f: &FilterSpec, kind: Option<ColKind>) -> Predicate {
        let q = f.query.trim();
        let numeric = matches!(kind, Some(ColKind::Int) | Some(ColKind::Float) | Some(ColKind::Logical));
        if numeric {
            if let Some((a, b)) = q.split_once("..") {
                if let (Ok(a), Ok(b)) = (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
                    return Predicate::Range(a.min(b), a.max(b));
                }
            }
            for (op, ord, eq) in [
                (">=", Ordering::Greater, true),
                ("<=", Ordering::Less, true),
                (">", Ordering::Greater, false),
                ("<", Ordering::Less, false),
                ("=", Ordering::Equal, true),
            ] {
                if let Some(rest) = q.strip_prefix(op) {
                    if let Ok(v) = rest.trim().parse::<f64>() {
                        return Predicate::Cmp(ord, v, eq);
                    }
                }
            }
        }
        Predicate::Substr(q.to_lowercase())
    }

    fn matches(&self, cell: &Cell) -> bool {
        match self {
            Predicate::Cmp(ord, v, eq) => {
                let x = cell.as_f64();
                if x.is_nan() {
                    return false;
                }
                match x.partial_cmp(v) {
                    Some(Ordering::Equal) => *eq,
                    Some(o) => o == *ord,
                    None => false,
                }
            }
            Predicate::Range(lo, hi) => {
                let x = cell.as_f64();
                !x.is_nan() && x >= *lo && x <= *hi
            }
            Predicate::Substr(needle) => {
                needle.is_empty() || cell.as_display().to_lowercase().contains(needle.as_str())
            }
        }
    }
}

// ---- element readers ------------------------------------------------------

fn read_binary(bytes: &[u8], offset: usize, elem: Elem, repeat: usize, scale: f64, zero: f64) -> Cell {
    if elem == Elem::Char {
        let end = (offset + repeat).min(bytes.len());
        let slice = bytes.get(offset..end).unwrap_or(&[]);
        let s: String = slice
            .iter()
            .map(|&b| b as char)
            .collect::<String>()
            .trim_end_matches([' ', '\0'])
            .to_string();
        return Cell::Str(s);
    }
    if let Elem::Opaque(_) = elem {
        return Cell::Str("<binary>".to_string());
    }
    let sz = elem.bytes();
    let read_one = |i: usize| -> Option<Cell> {
        let s = offset + i * sz;
        let b = bytes.get(s..s + sz)?;
        Some(match elem {
            Elem::Logical => match b[0] {
                b'T' | b't' => Cell::Bool(true),
                b'F' | b'f' => Cell::Bool(false),
                _ => Cell::Null,
            },
            Elem::U8 => scaled_int(b[0] as i64, scale, zero),
            Elem::I16 => scaled_int(i16::from_be_bytes([b[0], b[1]]) as i64, scale, zero),
            Elem::I32 => scaled_int(i32::from_be_bytes([b[0], b[1], b[2], b[3]]) as i64, scale, zero),
            Elem::I64 => scaled_int(
                i64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]),
                scale,
                zero,
            ),
            Elem::F32 => scaled_float(f32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64, scale, zero),
            Elem::F64 => scaled_float(
                f64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]),
                scale,
                zero,
            ),
            _ => Cell::Null,
        })
    };

    if repeat == 1 {
        return read_one(0).unwrap_or(Cell::Null);
    }
    // Vector column: format as "[a, b, c]".
    let mut parts = Vec::with_capacity(repeat);
    for i in 0..repeat {
        parts.push(read_one(i).unwrap_or(Cell::Null).as_display());
    }
    Cell::Str(format!("[{}]", parts.join(", ")))
}

fn scaled_int(raw: i64, scale: f64, zero: f64) -> Cell {
    if scale == 1.0 && zero.fract() == 0.0 {
        Cell::Int(raw + zero as i64)
    } else {
        Cell::Float(raw as f64 * scale + zero)
    }
}

fn scaled_float(raw: f64, scale: f64, zero: f64) -> Cell {
    let v = raw * scale + zero;
    if v.is_nan() {
        Cell::Null
    } else {
        Cell::Float(v)
    }
}

fn read_ascii(bytes: &[u8], start: usize, width: usize, fmt: AsciiFmt, scale: f64, zero: f64) -> Cell {
    let end = (start + width).min(bytes.len());
    let slice = bytes.get(start..end).unwrap_or(&[]);
    let text: String = slice.iter().map(|&b| b as char).collect();
    let trimmed = text.trim();
    match fmt {
        AsciiFmt::Str => Cell::Str(trimmed.to_string()),
        AsciiFmt::Int => match trimmed.parse::<i64>() {
            Ok(v) => scaled_int(v, scale, zero),
            Err(_) => Cell::Null,
        },
        AsciiFmt::Float => match trimmed.replace(['D', 'd'], "E").parse::<f64>() {
            Ok(v) => scaled_float(v, scale, zero),
            Err(_) => Cell::Null,
        },
    }
}

// ---- TFORM parsing --------------------------------------------------------

/// Parse a BINTABLE `TFORM` (`rT...`): leading repeat (default 1) + type char.
fn parse_bin_tform(s: &str) -> Option<(usize, Elem)> {
    let s = s.trim();
    let split = s.find(|c: char| c.is_ascii_alphabetic())?;
    let repeat = if split == 0 {
        1
    } else {
        s[..split].trim().parse::<usize>().ok()?
    };
    let ty = s[split..].chars().next()?.to_ascii_uppercase();
    let elem = match ty {
        'L' => Elem::Logical,
        'B' => Elem::U8,
        'I' => Elem::I16,
        'J' => Elem::I32,
        'K' => Elem::I64,
        'A' => Elem::Char,
        'E' => Elem::F32,
        'D' => Elem::F64,
        'X' => Elem::Opaque(0), // bit array; field width handled by caller
        'C' => Elem::Opaque(8),
        'M' => Elem::Opaque(16),
        'P' => Elem::Opaque(8),
        'Q' => Elem::Opaque(16),
        _ => return None,
    };
    Some((repeat.max(1), elem))
}

/// Parse an ASCII TABLE `TFORM` (`Aw`, `Iw`, `Fw.d`, `Ew.d`, `Dw.d`, `Gw.d`).
fn parse_ascii_tform(s: &str) -> Option<(AsciiFmt, usize)> {
    let s = s.trim();
    let ty = s.chars().next()?.to_ascii_uppercase();
    let rest = &s[1..];
    let width_str = rest.split('.').next().unwrap_or(rest);
    let width = width_str.trim().parse::<usize>().ok()?;
    let fmt = match ty {
        'A' => AsciiFmt::Str,
        'I' => AsciiFmt::Int,
        'F' | 'E' | 'D' | 'G' => AsciiFmt::Float,
        _ => return None,
    };
    Some((fmt, width))
}

/// Compact float formatting for display strings (avoids Rust's `1` vs `1.0`
/// integer-looking floats staying readable without trailing zero spew).
fn format_float(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    if !v.is_finite() {
        return String::new();
    }
    let a = v.abs();
    if a >= 1e6 || a < 1e-4 {
        format!("{v:.6e}")
    } else {
        // Trim trailing zeros from a fixed rendering.
        let s = format!("{v:.6}");
        let s = s.trim_end_matches('0').trim_end_matches('.');
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bin_tforms() {
        assert_eq!(parse_bin_tform("J"), Some((1, Elem::I32)));
        assert_eq!(parse_bin_tform("1D"), Some((1, Elem::F64)));
        assert_eq!(parse_bin_tform("16A"), Some((16, Elem::Char)));
        assert_eq!(parse_bin_tform("3E"), Some((3, Elem::F32)));
    }

    #[test]
    fn parses_ascii_tforms() {
        assert_eq!(parse_ascii_tform("A10"), Some((AsciiFmt::Str, 10)));
        assert_eq!(parse_ascii_tform("I6"), Some((AsciiFmt::Int, 6)));
        assert_eq!(parse_ascii_tform("F12.5"), Some((AsciiFmt::Float, 12)));
    }

    #[test]
    fn scaled_int_stays_int_when_unscaled() {
        assert_eq!(scaled_int(5, 1.0, 0.0), Cell::Int(5));
        assert_eq!(scaled_int(5, 1.0, 32768.0), Cell::Int(32773));
        assert_eq!(scaled_int(5, 0.5, 0.0), Cell::Float(2.5));
    }
}
