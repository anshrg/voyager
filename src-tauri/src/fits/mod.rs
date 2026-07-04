//! FITS file access: header parsing, HDU enumeration, mmap-backed data reads.
//!
//! Design constraints:
//! - No Tauri types here; this module is pure and unit-testable.
//! - Opening a file must never read the data units into RAM. The file is
//!   memory-mapped; only header blocks are touched at open time, so a
//!   multi-GB file opens in milliseconds and the OS pages data in on demand.
//! - Correctness is gated against astropy-generated fixtures (see
//!   `tests/fixtures.rs` and `scripts/gen_fixtures.py`).

use memmap2::Mmap;
use serde::Serialize;
use std::fmt;
use std::fs::File;
use std::path::Path;

pub const BLOCK: usize = 2880;
pub const CARD: usize = 80;
const CARDS_PER_BLOCK: usize = BLOCK / CARD;
/// Refuse to scan pathologically long headers (protects against non-FITS input).
const MAX_HEADER_BLOCKS: usize = 10_000;

#[derive(Debug)]
pub enum FitsError {
    Io(std::io::Error),
    NotFits(String),
    Malformed(String),
    BadHdu(usize),
}

impl fmt::Display for FitsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FitsError::Io(e) => write!(f, "I/O error: {e}"),
            FitsError::NotFits(m) => write!(f, "not a FITS file: {m}"),
            FitsError::Malformed(m) => write!(f, "malformed FITS: {m}"),
            FitsError::BadHdu(i) => write!(f, "no such HDU: {i}"),
        }
    }
}

impl std::error::Error for FitsError {}

impl From<std::io::Error> for FitsError {
    fn from(e: std::io::Error) -> Self {
        FitsError::Io(e)
    }
}

type Result<T> = std::result::Result<T, FitsError>;

/// A parsed header card value.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", content = "value")]
pub enum Value {
    Str(String),
    Logical(bool),
    Int(i64),
    Float(f64),
    /// Card has `= ` but an empty/undefined value.
    Undefined,
    /// Unparseable value; raw text preserved.
    Raw(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct Card {
    pub key: String,
    pub value: Option<Value>,
    pub comment: Option<String>,
    /// The original 80-char card text, trailing spaces trimmed.
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Header {
    pub cards: Vec<Card>,
}

impl Header {
    fn find(&self, key: &str) -> Option<&Value> {
        self.cards
            .iter()
            .find(|c| c.key == key)
            .and_then(|c| c.value.as_ref())
    }

    pub fn get_i64(&self, key: &str) -> Option<i64> {
        match self.find(key)? {
            Value::Int(v) => Some(*v),
            Value::Float(v) => Some(*v as i64),
            _ => None,
        }
    }

    pub fn get_f64(&self, key: &str) -> Option<f64> {
        match self.find(key)? {
            Value::Int(v) => Some(*v as f64),
            Value::Float(v) => Some(*v),
            _ => None,
        }
    }

    pub fn get_str(&self, key: &str) -> Option<&str> {
        match self.find(key)? {
            Value::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HduKind {
    Image,
    BinTable,
    AsciiTable,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct HduInfo {
    pub index: usize,
    pub kind: HduKind,
    /// EXTNAME, if present.
    pub name: Option<String>,
    pub bitpix: i64,
    /// NAXISn in FITS order (NAXIS1 first).
    pub shape: Vec<i64>,
    pub header_offset: u64,
    pub data_offset: u64,
    pub data_len: u64,
    pub ncards: usize,
    /// For tables: NAXIS2 (rows) and TFIELDS (columns).
    pub nrows: Option<i64>,
    pub ncols: Option<i64>,
    #[serde(skip)]
    pub header: Header,
}

pub struct FitsFile {
    pub path: std::path::PathBuf,
    pub size: u64,
    pub hdus: Vec<HduInfo>,
    mmap: Mmap,
}

/// Parse the value+comment portion (bytes 10..80) of a card.
fn parse_value(text: &str) -> (Option<Value>, Option<String>) {
    let t = text.trim_start();
    if t.is_empty() {
        return (Some(Value::Undefined), None);
    }
    if let Some(rest) = t.strip_prefix('\'') {
        // Quoted string; '' is an escaped quote.
        let mut s = String::new();
        let mut chars = rest.chars().peekable();
        let mut closed = false;
        while let Some(c) = chars.next() {
            if c == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    s.push('\'');
                } else {
                    closed = true;
                    break;
                }
            } else {
                s.push(c);
            }
        }
        if !closed {
            return (Some(Value::Raw(text.trim().to_string())), None);
        }
        let remainder: String = chars.collect();
        let comment = remainder
            .trim_start()
            .strip_prefix('/')
            .map(|c| c.trim().to_string());
        // Trailing spaces in FITS strings are not significant.
        return (Some(Value::Str(s.trim_end().to_string())), comment);
    }

    let (value_part, comment) = match t.split_once('/') {
        Some((v, c)) => (v.trim(), Some(c.trim().to_string())),
        None => (t.trim(), None),
    };
    let value = match value_part {
        "" => Value::Undefined,
        "T" => Value::Logical(true),
        "F" => Value::Logical(false),
        v => {
            if let Ok(i) = v.parse::<i64>() {
                Value::Int(i)
            } else {
                // FITS allows Fortran 'D' exponents (1.0D3).
                let norm = v.replace(['D', 'd'], "E");
                match norm.parse::<f64>() {
                    Ok(f) => Value::Float(f),
                    Err(_) => Value::Raw(v.to_string()),
                }
            }
        }
    };
    (Some(value), comment)
}

fn parse_card(bytes: &[u8]) -> Card {
    let raw: String = bytes.iter().map(|&b| b as char).collect();
    let key = raw[..8].trim_end().to_string();
    let is_commentary = matches!(key.as_str(), "COMMENT" | "HISTORY" | "END" | "");
    if !is_commentary && raw.len() >= 10 && &raw[8..10] == "= " {
        let (value, comment) = parse_value(&raw[10..]);
        Card {
            key,
            value,
            comment,
            raw: raw.trim_end().to_string(),
        }
    } else {
        let comment = raw[8.min(raw.len())..].trim().to_string();
        Card {
            key,
            value: None,
            comment: if comment.is_empty() { None } else { Some(comment) },
            raw: raw.trim_end().to_string(),
        }
    }
}

/// Parse one header starting at `offset`. Returns (header, bytes consumed).
fn parse_header(data: &[u8], offset: usize) -> Result<(Header, usize)> {
    let mut cards = Vec::new();
    let mut block = 0usize;
    loop {
        if block >= MAX_HEADER_BLOCKS {
            return Err(FitsError::Malformed(format!(
                "header at offset {offset} exceeds {MAX_HEADER_BLOCKS} blocks"
            )));
        }
        let start = offset + block * BLOCK;
        let end = start + BLOCK;
        if end > data.len() {
            return Err(FitsError::Malformed(format!(
                "truncated header block at offset {start}"
            )));
        }
        for i in 0..CARDS_PER_BLOCK {
            let card_bytes = &data[start + i * CARD..start + (i + 1) * CARD];
            if card_bytes[..8] == *b"END     " {
                return Ok((Header { cards }, (block + 1) * BLOCK));
            }
            // Skip fully blank cards but keep everything else verbatim.
            if card_bytes.iter().all(|&b| b == b' ') {
                continue;
            }
            cards.push(parse_card(card_bytes));
        }
        block += 1;
    }
}

/// Size in bytes of the data unit following a header (before block padding).
fn data_len(header: &Header, is_primary: bool) -> u64 {
    let bitpix = header.get_i64("BITPIX").unwrap_or(0).unsigned_abs();
    let naxis = header.get_i64("NAXIS").unwrap_or(0);
    if naxis == 0 {
        return 0;
    }
    let mut prod: u64 = 1;
    for i in 1..=naxis {
        prod = prod.saturating_mul(header.get_i64(&format!("NAXIS{i}")).unwrap_or(0).max(0) as u64);
    }
    let (pcount, gcount) = if is_primary {
        (0, 1)
    } else {
        (
            header.get_i64("PCOUNT").unwrap_or(0).max(0) as u64,
            header.get_i64("GCOUNT").unwrap_or(1).max(1) as u64,
        )
    };
    (bitpix / 8) * gcount * (pcount + prod)
}

fn pad_to_block(n: u64) -> u64 {
    n.div_ceil(BLOCK as u64) * (BLOCK as u64)
}

impl FitsFile {
    pub fn open(path: &Path) -> Result<FitsFile> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        if size < BLOCK as u64 {
            return Err(FitsError::NotFits("file smaller than one FITS block".into()));
        }
        // Safety: the map is read-only; concurrent truncation by another
        // process could fault, which we accept for a local viewer.
        let mmap = unsafe { Mmap::map(&file)? };
        if &mmap[..6] != b"SIMPLE" && &mmap[..8] != b"XTENSION" {
            return Err(FitsError::NotFits(
                "does not start with SIMPLE or XTENSION".into(),
            ));
        }

        let mut hdus = Vec::new();
        let mut offset = 0u64;
        while offset < size {
            // Trailing garbage/padding that can't hold a header block: stop.
            if size - offset < BLOCK as u64 {
                break;
            }
            let (header, header_bytes) = parse_header(&mmap, offset as usize)?;
            let index = hdus.len();
            let is_primary = index == 0;
            let dlen = data_len(&header, is_primary);
            let data_offset = offset + header_bytes as u64;

            let kind = if is_primary {
                HduKind::Image
            } else {
                match header.get_str("XTENSION").map(str::trim) {
                    Some("IMAGE") => HduKind::Image,
                    Some("BINTABLE") => HduKind::BinTable,
                    Some("TABLE") => HduKind::AsciiTable,
                    _ => HduKind::Unknown,
                }
            };
            let naxis = header.get_i64("NAXIS").unwrap_or(0);
            let shape: Vec<i64> = (1..=naxis)
                .map(|i| header.get_i64(&format!("NAXIS{i}")).unwrap_or(0))
                .collect();
            let (nrows, ncols) = match kind {
                HduKind::BinTable | HduKind::AsciiTable => (
                    header.get_i64("NAXIS2"),
                    header.get_i64("TFIELDS"),
                ),
                _ => (None, None),
            };

            hdus.push(HduInfo {
                index,
                kind,
                name: header.get_str("EXTNAME").map(|s| s.trim().to_string()),
                bitpix: header.get_i64("BITPIX").unwrap_or(0),
                shape,
                header_offset: offset,
                data_offset,
                data_len: dlen,
                ncards: header.cards.len(),
                nrows,
                ncols,
                header,
            });

            offset = data_offset + pad_to_block(dlen);
        }

        if hdus.is_empty() {
            return Err(FitsError::NotFits("no HDUs found".into()));
        }
        Ok(FitsFile {
            path: path.to_path_buf(),
            size,
            hdus,
            mmap,
        })
    }

    pub fn hdu(&self, index: usize) -> Result<&HduInfo> {
        self.hdus.get(index).ok_or(FitsError::BadHdu(index))
    }

    /// The whole file as a byte slice (mmap-backed; reads fault pages in on
    /// demand). Used by the tiles module for data-unit access.
    pub fn data(&self) -> &[u8] {
        &self.mmap
    }

    /// Raw big-endian pixel at FITS 0-based pixel index (x, y) of a 2-D image
    /// HDU, with BSCALE/BZERO applied. Used for readout and fixture tests.
    pub fn pixel_value(&self, hdu_index: usize, x: u64, y: u64) -> Result<f64> {
        let hdu = self.hdu(hdu_index)?;
        if hdu.kind != HduKind::Image || hdu.shape.len() < 2 {
            return Err(FitsError::Malformed("not a 2-D image HDU".into()));
        }
        let (nx, ny) = (hdu.shape[0] as u64, hdu.shape[1] as u64);
        if x >= nx || y >= ny {
            return Err(FitsError::Malformed(format!(
                "pixel ({x},{y}) outside {nx}x{ny}"
            )));
        }
        let bpp = (hdu.bitpix.unsigned_abs() / 8) as u64;
        let pos = (hdu.data_offset + (y * nx + x) * bpp) as usize;
        let end = pos + bpp as usize;
        if end > self.mmap.len() {
            return Err(FitsError::Malformed("pixel offset beyond file end".into()));
        }
        let b = &self.mmap[pos..end];
        let raw = match hdu.bitpix {
            8 => b[0] as f64,
            16 => i16::from_be_bytes([b[0], b[1]]) as f64,
            32 => i32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64,
            64 => i64::from_be_bytes(b.try_into().unwrap()) as f64,
            -32 => f32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64,
            -64 => f64::from_be_bytes(b.try_into().unwrap()),
            other => return Err(FitsError::Malformed(format!("unsupported BITPIX {other}"))),
        };
        let bscale = hdu.header.get_f64("BSCALE").unwrap_or(1.0);
        let bzero = hdu.header.get_f64("BZERO").unwrap_or(0.0);
        Ok(raw * bscale + bzero)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(s: &str) -> Card {
        let mut padded = s.to_string();
        padded.push_str(&" ".repeat(CARD - s.len()));
        parse_card(padded.as_bytes())
    }

    #[test]
    fn parses_string_value() {
        let c = card("EXTNAME = 'SCI     '           / extension name");
        assert_eq!(c.value, Some(Value::Str("SCI".into())));
        assert_eq!(c.comment.as_deref(), Some("extension name"));
    }

    #[test]
    fn parses_escaped_quote() {
        let c = card("OBJECT  = 'O''NEILL'");
        assert_eq!(c.value, Some(Value::Str("O'NEILL".into())));
    }

    #[test]
    fn parses_int_float_logical() {
        assert_eq!(card("NAXIS   =                    2").value, Some(Value::Int(2)));
        assert_eq!(
            card("CRVAL1  =        150.1163213 / RA").value,
            Some(Value::Float(150.1163213))
        );
        assert_eq!(card("SIMPLE  =                    T").value, Some(Value::Logical(true)));
    }

    #[test]
    fn parses_fortran_double_exponent() {
        assert_eq!(card("SCALE   = 1.5D3").value, Some(Value::Float(1500.0)));
    }

    #[test]
    fn commentary_cards_have_no_value() {
        let c = card("COMMENT   FITS (Flexible Image Transport System)");
        assert_eq!(c.value, None);
        assert!(c.comment.is_some());
    }
}
