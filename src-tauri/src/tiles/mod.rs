//! Tile extraction for image display.
//!
//! The viewer requests fixed-size tiles of f32 pixels at a downsample
//! *level*: level 0 is full resolution, level L samples every 2^L-th pixel
//! (block *sampling*, matching DS9's zoomed-out behavior — not averaging).
//! Sampling keeps coarse levels cheap on mmap'd multi-GB files: only the
//! touched pages are faulted in, never the whole data unit.
//!
//! No Tauri types here; this module is pure and unit-testable.

pub mod zscale;

use crate::fits::{FitsError, FitsFile, HduInfo, HduKind};

pub const TILE: u32 = 256;

type Result<T> = std::result::Result<T, FitsError>;

/// A tile of scaled (BSCALE/BZERO applied) f32 pixels, row-major, row 0 =
/// lowest FITS row. Edge tiles are smaller than TILE; w/h give actual size.
pub struct Tile {
    pub w: u32,
    pub h: u32,
    pub data: Vec<f32>,
}

/// Image geometry the viewer needs. For cubes (NAXIS > 2) we expose the
/// first plane only (M1 scope).
pub struct ImageGeom {
    pub nx: u64,
    pub ny: u64,
    pub max_level: u32,
}

pub fn image_geom(hdu: &HduInfo) -> Result<ImageGeom> {
    if hdu.kind != HduKind::Image || hdu.shape.len() < 2 {
        return Err(FitsError::Malformed("not a 2-D image HDU".into()));
    }
    let nx = hdu.shape[0].max(0) as u64;
    let ny = hdu.shape[1].max(0) as u64;
    if nx == 0 || ny == 0 {
        return Err(FitsError::Malformed("image HDU has no data".into()));
    }
    Ok(ImageGeom {
        nx,
        ny,
        max_level: max_level(nx, ny),
    })
}

/// Smallest level at which the whole image fits in one tile per axis.
pub fn max_level(nx: u64, ny: u64) -> u32 {
    let mut level = 0u32;
    while level_dim(nx.max(ny), level) > TILE as u64 {
        level += 1;
    }
    level
}

/// Size of an axis at a given level: ceil(n / 2^level).
pub fn level_dim(n: u64, level: u32) -> u64 {
    let s = 1u64 << level;
    n.div_ceil(s)
}

/// Read one big-endian pixel at byte offset `off` as f64.
fn reader_for(bitpix: i64) -> Option<fn(&[u8]) -> f64> {
    Some(match bitpix {
        8 => |b: &[u8]| b[0] as f64,
        16 => |b: &[u8]| i16::from_be_bytes([b[0], b[1]]) as f64,
        32 => |b: &[u8]| i32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64,
        64 => |b: &[u8]| i64::from_be_bytes(b[..8].try_into().unwrap()) as f64,
        -32 => |b: &[u8]| f32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64,
        -64 => |b: &[u8]| f64::from_be_bytes(b[..8].try_into().unwrap()),
        _ => return None,
    })
}

struct PixelSource<'a> {
    data: &'a [u8],
    data_offset: u64,
    nx: u64,
    bpp: u64,
    read: fn(&[u8]) -> f64,
    bscale: f64,
    bzero: f64,
    /// BLANK for integer BITPIX: raw values equal to it become NaN.
    blank: Option<f64>,
}

impl<'a> PixelSource<'a> {
    fn new(file: &'a FitsFile, hdu: &HduInfo) -> Result<(PixelSource<'a>, ImageGeom)> {
        let geom = image_geom(hdu)?;
        let read = reader_for(hdu.bitpix)
            .ok_or_else(|| FitsError::Malformed(format!("unsupported BITPIX {}", hdu.bitpix)))?;
        let bpp = hdu.bitpix.unsigned_abs() / 8;
        let last = hdu.data_offset + (geom.ny * geom.nx) * bpp;
        if last > file.data().len() as u64 {
            return Err(FitsError::Malformed("data unit beyond file end".into()));
        }
        let blank = if hdu.bitpix > 0 {
            hdu.header.get_i64("BLANK").map(|v| v as f64)
        } else {
            None
        };
        Ok((
            PixelSource {
                data: file.data(),
                data_offset: hdu.data_offset,
                nx: geom.nx,
                bpp,
                read,
                bscale: hdu.header.get_f64("BSCALE").unwrap_or(1.0),
                bzero: hdu.header.get_f64("BZERO").unwrap_or(0.0),
                blank,
            },
            geom,
        ))
    }

    #[inline]
    fn get(&self, x: u64, y: u64) -> f64 {
        let off = (self.data_offset + (y * self.nx + x) * self.bpp) as usize;
        let raw = (self.read)(&self.data[off..off + self.bpp as usize]);
        if self.blank == Some(raw) {
            return f64::NAN;
        }
        raw * self.bscale + self.bzero
    }
}

/// Extract tile (tx, ty) of `hdu_index` at `level`. Tile (0,0) starts at
/// image pixel (0,0); level pixel (lx, ly) samples image pixel
/// (lx << level, ly << level).
pub fn extract_tile(
    file: &FitsFile,
    hdu_index: usize,
    level: u32,
    tx: u32,
    ty: u32,
) -> Result<Tile> {
    let hdu = file.hdu(hdu_index)?;
    let (src, geom) = PixelSource::new(file, hdu)?;
    let (lw, lh) = (level_dim(geom.nx, level), level_dim(geom.ny, level));
    let (x0, y0) = ((tx as u64) * TILE as u64, (ty as u64) * TILE as u64);
    if x0 >= lw || y0 >= lh {
        return Err(FitsError::Malformed(format!(
            "tile ({tx},{ty}) outside level {level} grid {lw}x{lh}"
        )));
    }
    let w = (lw - x0).min(TILE as u64) as u32;
    let h = (lh - y0).min(TILE as u64) as u32;
    let stride = 1u64 << level;

    let mut data = Vec::with_capacity((w as usize) * (h as usize));
    for j in 0..h as u64 {
        let sy = (y0 + j) * stride;
        for i in 0..w as u64 {
            let sx = (x0 + i) * stride;
            data.push(src.get(sx, sy) as f32);
        }
    }
    Ok(Tile { w, h, data })
}

/// Gather pixel values for scale-limit estimation, in row-major order.
///
/// Small images are read in full (matching astropy, which flattens the whole
/// array). Large images are sampled on a uniform grid of ~`target` pixels so
/// only sparse pages fault in — limits may differ marginally from astropy's
/// full-array answer there, which is fine for display scaling.
pub fn gather_values(file: &FitsFile, hdu_index: usize, target: usize) -> Result<Vec<f64>> {
    let hdu = file.hdu(hdu_index)?;
    let (src, geom) = PixelSource::new(file, hdu)?;
    let total = geom.nx * geom.ny;
    let mut out;
    if total <= target as u64 {
        out = Vec::with_capacity(total as usize);
        for y in 0..geom.ny {
            for x in 0..geom.nx {
                out.push(src.get(x, y));
            }
        }
    } else {
        // Uniform grid: same fractional stride on both axes.
        let ratio = ((total as f64) / (target as f64)).sqrt();
        let sx = ratio.max(1.0) as u64;
        let sy = ratio.max(1.0) as u64;
        out = Vec::with_capacity(((geom.ny / sy + 1) * (geom.nx / sx + 1)) as usize);
        let mut y = 0;
        while y < geom.ny {
            let mut x = 0;
            while x < geom.nx {
                out.push(src.get(x, y));
                x += sx;
            }
            y += sy;
        }
    }
    Ok(out)
}

/// Single-pixel readout with BSCALE/BZERO applied (NaN for BLANK).
pub fn pixel_at(file: &FitsFile, hdu_index: usize, x: u64, y: u64) -> Result<f64> {
    let hdu = file.hdu(hdu_index)?;
    let (src, geom) = PixelSource::new(file, hdu)?;
    if x >= geom.nx || y >= geom.ny {
        return Err(FitsError::Malformed(format!(
            "pixel ({x},{y}) outside {}x{}",
            geom.nx, geom.ny
        )));
    }
    Ok(src.get(x, y))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_dims_and_max_level() {
        assert_eq!(level_dim(1000, 0), 1000);
        assert_eq!(level_dim(1000, 2), 250);
        assert_eq!(level_dim(1001, 2), 251);
        assert_eq!(max_level(256, 256), 0);
        assert_eq!(max_level(257, 100), 1);
        assert_eq!(max_level(41800, 32000), 8); // 41800 / 2^8 = 163.3
    }
}
