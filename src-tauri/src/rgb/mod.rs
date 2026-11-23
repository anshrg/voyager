//! RGB composite support: per-band trilogy statistics and filter/band
//! detection. Pure — no Tauri types — so it unit/fixture-tests standalone.
//!
//! The composite itself is rendered on the GPU (src/render/gl.ts); the
//! backend's job is only what needs pixels or headers:
//!   - `trilogy_stats`: robust sky level, noise and bright-tail percentiles of
//!     a band, from which the frontend derives trilogy levels live as the user
//!     moves sliders (no rescan).
//!   - `detect_band`: which filter a band is and its pivot wavelength, so the
//!     default weights run blue → red.
//!
//! Both are ported from fitsgl-py (`fitsgl/stats.py::trilogy_stats_dict`,
//! `fitsgl/bands.py`), MIT, H. Akins — used with permission. Fixture-gated
//! against numpy in tests/rgb_fixtures.rs.

use serde::Serialize;

use crate::fits::Header;

/// Robust global stats for the trilogy stretch (fitsgl `trilogy_stats_dict`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct TrilogyStats {
    /// Median of the finite sample (the robust sky level; fitsgl calls it "mean").
    pub mean: f64,
    /// 1.4826 · MAD about the median.
    pub sigma: f64,
    pub p99: f64,
    pub p99_9: f64,
    pub p99_99: f64,
    pub p99_999: f64,
}

/// numpy `percentile(sorted, q)` with the default "linear" method: the value at
/// fractional rank q/100·(n−1), linearly interpolated. `sorted` must be
/// ascending and non-empty.
pub fn percentile_sorted(sorted: &[f64], q: f64) -> f64 {
    let n = sorted.len();
    if n == 1 {
        return sorted[0];
    }
    let rank = (q / 100.0) * (n - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = (lo + 1).min(n - 1);
    let frac = rank - lo as f64;
    // numpy's lerp form; exact at frac == 0.
    sorted[lo] + (sorted[hi] - sorted[lo]) * frac
}

/// Trilogy stats from a pixel sample. Non-finite values are ignored. None when
/// there are no finite values or the sample is degenerate (MAD == 0, e.g. a
/// constant band) — mirroring fitsgl, so a flat band never yields sigma == 0.
pub fn trilogy_stats(values: &[f64]) -> Option<TrilogyStats> {
    let mut v: Vec<f64> = values.iter().copied().filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_unstable_by(|a, b| a.total_cmp(b));
    let p50 = percentile_sorted(&v, 50.0);
    let mut dev: Vec<f64> = v.iter().map(|x| (x - p50).abs()).collect();
    dev.sort_unstable_by(|a, b| a.total_cmp(b));
    let sigma = 1.4826 * percentile_sorted(&dev, 50.0);
    if !(sigma > 0.0) {
        return None;
    }
    Some(TrilogyStats {
        mean: p50,
        sigma,
        p99: percentile_sorted(&v, 99.0),
        p99_9: percentile_sorted(&v, 99.9),
        p99_99: percentile_sorted(&v, 99.99),
        p99_999: percentile_sorted(&v, 99.999),
    })
}

// ---- band detection (port of fitsgl-py bands.py) ---------------------------

/// One band's identity, derived from an HST/JWST imaging header or filename.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DetectedBand {
    /// Canonical filter token, uppercased, e.g. "F444W".
    pub filter: String,
    /// "NIRCam" | "NIRISS" | "MIRI" | "ACS" | "WFC3" | "" (unknown, filename-only).
    pub instrument: String,
    /// "JWST" | "HST" | "".
    pub telescope: String,
    /// Pivot wavelength (microns) — for blue→red ordering only.
    pub pivot_um: f64,
    pub is_broadband: bool,
}

/// Curated pivot wavelengths (µm), keyed by (lookup key, filter). The lookup
/// key is the instrument, except WFC3 which splits into UVIS and IR. Only the
/// relative order matters.
const PIVOT_UM: &[(&str, &str, f64)] = &[
    // JWST NIRCam (JDox)
    ("NIRCAM", "F070W", 0.704),
    ("NIRCAM", "F090W", 0.902),
    ("NIRCAM", "F115W", 1.154),
    ("NIRCAM", "F140M", 1.404),
    ("NIRCAM", "F150W", 1.501),
    ("NIRCAM", "F150W2", 1.659),
    ("NIRCAM", "F162M", 1.626),
    ("NIRCAM", "F164N", 1.645),
    ("NIRCAM", "F182M", 1.845),
    ("NIRCAM", "F187N", 1.874),
    ("NIRCAM", "F200W", 1.990),
    ("NIRCAM", "F210M", 2.093),
    ("NIRCAM", "F212N", 2.120),
    ("NIRCAM", "F250M", 2.503),
    ("NIRCAM", "F277W", 2.786),
    ("NIRCAM", "F300M", 2.996),
    ("NIRCAM", "F322W2", 3.232),
    ("NIRCAM", "F323N", 3.237),
    ("NIRCAM", "F335M", 3.365),
    ("NIRCAM", "F356W", 3.563),
    ("NIRCAM", "F360M", 3.621),
    ("NIRCAM", "F405N", 4.055),
    ("NIRCAM", "F410M", 4.092),
    ("NIRCAM", "F430M", 4.280),
    ("NIRCAM", "F444W", 4.421),
    ("NIRCAM", "F460M", 4.624),
    ("NIRCAM", "F466N", 4.654),
    ("NIRCAM", "F470N", 4.707),
    ("NIRCAM", "F480M", 4.834),
    // JWST NIRISS
    ("NIRISS", "F090W", 0.901),
    ("NIRISS", "F115W", 1.150),
    ("NIRISS", "F140M", 1.404),
    ("NIRISS", "F150W", 1.493),
    ("NIRISS", "F158M", 1.587),
    ("NIRISS", "F200W", 1.972),
    ("NIRISS", "F277W", 2.776),
    ("NIRISS", "F356W", 3.563),
    ("NIRISS", "F380M", 3.826),
    ("NIRISS", "F430M", 4.286),
    ("NIRISS", "F444W", 4.408),
    ("NIRISS", "F480M", 4.815),
    // JWST MIRI imaging
    ("MIRI", "F560W", 5.6),
    ("MIRI", "F770W", 7.7),
    ("MIRI", "F1000W", 10.0),
    ("MIRI", "F1130W", 11.3),
    ("MIRI", "F1280W", 12.8),
    ("MIRI", "F1500W", 15.0),
    ("MIRI", "F1800W", 18.0),
    ("MIRI", "F2100W", 21.0),
    ("MIRI", "F2550W", 25.5),
    // HST ACS/WFC
    ("ACS", "F435W", 0.4329),
    ("ACS", "F475W", 0.4747),
    ("ACS", "F502N", 0.5023),
    ("ACS", "F550M", 0.5581),
    ("ACS", "F555W", 0.5361),
    ("ACS", "F606W", 0.5907),
    ("ACS", "F625W", 0.6311),
    ("ACS", "F658N", 0.6584),
    ("ACS", "F660N", 0.6599),
    ("ACS", "F775W", 0.7693),
    ("ACS", "F814W", 0.8057),
    ("ACS", "F850LP", 0.9033),
    // HST WFC3/UVIS
    ("WFC3/UVIS", "F218W", 0.2228),
    ("WFC3/UVIS", "F225W", 0.2372),
    ("WFC3/UVIS", "F275W", 0.2710),
    ("WFC3/UVIS", "F336W", 0.3355),
    ("WFC3/UVIS", "F390W", 0.3924),
    ("WFC3/UVIS", "F438W", 0.4326),
    ("WFC3/UVIS", "F475W", 0.4773),
    ("WFC3/UVIS", "F555W", 0.5308),
    ("WFC3/UVIS", "F606W", 0.5887),
    ("WFC3/UVIS", "F625W", 0.6242),
    ("WFC3/UVIS", "F775W", 0.7651),
    ("WFC3/UVIS", "F814W", 0.8039),
    ("WFC3/UVIS", "F850LP", 0.9176),
    // HST WFC3/IR
    ("WFC3/IR", "F098M", 0.9864),
    ("WFC3/IR", "F105W", 1.0552),
    ("WFC3/IR", "F110W", 1.1534),
    ("WFC3/IR", "F125W", 1.2486),
    ("WFC3/IR", "F127M", 1.2740),
    ("WFC3/IR", "F139M", 1.3838),
    ("WFC3/IR", "F140W", 1.3923),
    ("WFC3/IR", "F153M", 1.5322),
    ("WFC3/IR", "F160W", 1.5369),
];

fn pivot_lookup(key: &str, filt: &str) -> Option<f64> {
    PIVOT_UM
        .iter()
        .find(|(k, f, _)| *k == key && *f == filt)
        .map(|(_, _, p)| *p)
}

/// `F` + 3–4 digits + optional width suffix (W, M, N, X, W2, LP).
fn is_filter_token(tok: &str) -> bool {
    let b = tok.as_bytes();
    if b.first() != Some(&b'F') {
        return false;
    }
    let digits = b[1..].iter().take_while(|c| c.is_ascii_digit()).count();
    if !(3..=4).contains(&digits) {
        return false;
    }
    matches!(&tok[1 + digits..], "" | "W" | "M" | "N" | "X" | "W2" | "LP")
}

fn is_broadband(filt: &str) -> bool {
    filt.ends_with('W') || filt.ends_with("W2")
}

/// Ordering-only pivot estimate from the filter number. JWST and WFC3/IR use
/// 0.01-µm units (F444W → 4.44, F160W → 1.60); ACS and WFC3/UVIS use nm
/// (F606W → 0.606). Only used for filters missing from the table.
fn parse_pivot(key: &str, filt: &str) -> f64 {
    let digits: String = filt.chars().skip(1).take_while(|c| c.is_ascii_digit()).collect();
    let Ok(num) = digits.parse::<u32>() else {
        return 0.0;
    };
    if key == "ACS" || key == "WFC3/UVIS" {
        num as f64 / 1000.0
    } else {
        num as f64 * 0.01
    }
}

/// Uppercased, trimmed string value of `key`, looked up in the extension
/// header first and then the primary (JWST i2d keeps FILTER in the primary).
fn get(headers: &[&Header], key: &str) -> String {
    headers
        .iter()
        .find_map(|h| h.get_str(key))
        .map(|s| s.trim().to_ascii_uppercase())
        .unwrap_or_default()
}

/// Identify the science band from HST/JWST headers (extension first, then
/// primary). None when the telescope/instrument is unrecognized or no science
/// filter resolves — the caller then tries `detect_band_from_filename`.
pub fn detect_band(headers: &[&Header]) -> Option<DetectedBand> {
    let telescope = get(headers, "TELESCOP");
    let instrume = get(headers, "INSTRUME");
    let jwst = |i: &str| match i {
        "NIRCAM" => Some("NIRCam"),
        "NIRISS" => Some("NIRISS"),
        "MIRI" => Some("MIRI"),
        _ => None,
    };
    let hst = |i: &str| match i {
        "ACS" => Some("ACS"),
        "WFC3" => Some("WFC3"),
        _ => None,
    };
    let (tel, inst) = if telescope == "JWST" || jwst(&instrume).is_some() {
        ("JWST", jwst(&instrume)?)
    } else if telescope == "HST" || hst(&instrume).is_some() {
        ("HST", hst(&instrume)?)
    } else {
        return None;
    };

    let (filt, key): (String, String) = if tel == "JWST" {
        let filter = get(headers, "FILTER");
        let f = if inst == "MIRI" {
            is_filter_token(&filter).then_some(filter)?
        } else {
            // NIRCam/NIRISS: a real filter in the PUPIL wheel (narrow/medium
            // behind a wide blocker) is the intended bandpass, so it wins.
            let pupil = get(headers, "PUPIL");
            if is_filter_token(&pupil) {
                pupil
            } else if is_filter_token(&filter) {
                filter
            } else {
                return None;
            }
        };
        (f, inst.to_ascii_uppercase())
    } else if inst == "WFC3" {
        let f = get(headers, "FILTER");
        if !is_filter_token(&f) {
            return None;
        }
        let key = if get(headers, "DETECTOR") == "IR" { "WFC3/IR" } else { "WFC3/UVIS" };
        (f, key.to_string())
    } else {
        // ACS: the single non-CLEAR filter token across FILTER1/FILTER2.
        let cands: Vec<String> = [get(headers, "FILTER1"), get(headers, "FILTER2")]
            .into_iter()
            .filter(|t| !t.is_empty() && !t.starts_with("CLEAR") && is_filter_token(t))
            .collect();
        if cands.len() != 1 {
            return None;
        }
        (cands[0].clone(), "ACS".to_string())
    };

    let pivot = pivot_lookup(&key, &filt).unwrap_or_else(|| parse_pivot(&key, &filt));
    Some(DetectedBand {
        is_broadband: is_broadband(&filt),
        filter: filt,
        instrument: inst.to_string(),
        telescope: tel.to_string(),
        pivot_um: pivot,
    })
}

/// Standalone tokens of a filename (split on anything non-alphanumeric).
fn name_tokens(name: &str) -> impl Iterator<Item = String> + '_ {
    name.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_ascii_uppercase())
}

/// Lower-confidence fallback for mosaics whose headers carry only WCS: a single
/// standalone filter token in the filename (`..._f090w_...`), plus an
/// instrument token if present. None if zero or several distinct filters
/// appear (e.g. a PSF-matched `f200w_to_f444w` product).
pub fn detect_band_from_filename(filename: &str) -> Option<DetectedBand> {
    let mut filts: Vec<String> = name_tokens(filename).filter(|t| is_filter_token(t)).collect();
    filts.sort();
    filts.dedup();
    if filts.len() != 1 {
        return None;
    }
    let filt = filts.remove(0);

    let mut instrs: Vec<String> = name_tokens(filename)
        .filter(|t| matches!(t.as_str(), "NIRCAM" | "NIRISS" | "MIRI" | "ACS" | "WFC3"))
        .collect();
    instrs.sort();
    instrs.dedup();

    let (tel, inst, pivot) = if instrs.len() == 1 {
        let i = instrs[0].as_str();
        let (tel, inst) = match i {
            "NIRCAM" => ("JWST", "NIRCam"),
            "NIRISS" => ("JWST", "NIRISS"),
            "MIRI" => ("JWST", "MIRI"),
            "ACS" => ("HST", "ACS"),
            _ => ("HST", "WFC3"),
        };
        let key = if inst == "WFC3" {
            if pivot_lookup("WFC3/IR", &filt).is_some() { "WFC3/IR" } else { "WFC3/UVIS" }
        } else {
            i
        };
        let p = pivot_lookup(key, &filt).unwrap_or_else(|| parse_pivot(key, &filt));
        (tel, inst, p)
    } else {
        // Adopt the first table holding the filter (modern JWST first).
        const PREF: &[(&str, &str, &str)] = &[
            ("NIRCAM", "JWST", "NIRCam"),
            ("NIRISS", "JWST", "NIRISS"),
            ("MIRI", "JWST", "MIRI"),
            ("WFC3/IR", "HST", "WFC3"),
            ("ACS", "HST", "ACS"),
            ("WFC3/UVIS", "HST", "WFC3"),
        ];
        PREF.iter()
            .find_map(|(k, t, i)| pivot_lookup(k, &filt).map(|p| (*t, *i, p)))
            .unwrap_or(("", "", parse_pivot("NIRCAM", &filt)))
    };
    Some(DetectedBand {
        is_broadband: is_broadband(&filt),
        filter: filt,
        instrument: inst.to_string(),
        telescope: tel.to_string(),
        pivot_um: pivot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fits::{Card, Value};

    fn header(kv: &[(&str, &str)]) -> Header {
        Header {
            cards: kv
                .iter()
                .map(|(k, v)| Card {
                    key: k.to_string(),
                    value: Some(Value::Str(v.to_string())),
                    comment: None,
                    raw: String::new(),
                })
                .collect(),
        }
    }

    #[test]
    fn percentile_matches_numpy_linear() {
        let v = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(percentile_sorted(&v, 50.0), 2.5);
        assert_eq!(percentile_sorted(&v, 0.0), 1.0);
        assert_eq!(percentile_sorted(&v, 100.0), 4.0);
        assert!((percentile_sorted(&v, 99.0) - 3.97).abs() < 1e-12);
    }

    #[test]
    fn constant_band_has_no_stats() {
        assert!(trilogy_stats(&[5.0; 100]).is_none());
        assert!(trilogy_stats(&[f64::NAN; 10]).is_none());
    }

    #[test]
    fn jwst_nircam_from_primary_with_pupil_priority() {
        let prim = header(&[("TELESCOP", "JWST"), ("INSTRUME", "NIRCAM"), ("FILTER", "F322W2"), ("PUPIL", "F323N")]);
        let ext = header(&[("EXTNAME", "SCI")]);
        let b = detect_band(&[&ext, &prim]).unwrap();
        assert_eq!(b.filter, "F323N");
        assert_eq!(b.pivot_um, 3.237);
        assert!(!b.is_broadband);
        let prim = header(&[("TELESCOP", "JWST"), ("INSTRUME", "NIRCAM"), ("FILTER", "F444W"), ("PUPIL", "CLEAR")]);
        let b = detect_band(&[&prim]).unwrap();
        assert_eq!((b.filter.as_str(), b.pivot_um, b.is_broadband), ("F444W", 4.421, true));
    }

    #[test]
    fn hst_conventions() {
        let acs = header(&[("TELESCOP", "HST"), ("INSTRUME", "ACS"), ("FILTER1", "CLEAR1L"), ("FILTER2", "F814W")]);
        assert_eq!(detect_band(&[&acs]).unwrap().pivot_um, 0.8057);
        let ir = header(&[("INSTRUME", "WFC3"), ("DETECTOR", "IR"), ("FILTER", "F999W")]);
        // Not in the table: 0.01-µm units on WFC3/IR.
        assert!((detect_band(&[&ir]).unwrap().pivot_um - 9.99).abs() < 1e-12);
        let uvis = header(&[("INSTRUME", "WFC3"), ("DETECTOR", "UVIS"), ("FILTER", "F999W")]);
        assert!((detect_band(&[&uvis]).unwrap().pivot_um - 0.999).abs() < 1e-12);
    }

    #[test]
    fn filename_fallback() {
        let b = detect_band_from_filename("hlsp_ceers_jwst_nircam_nircam6_f277w_v0.5_i2d.fits").unwrap();
        assert_eq!((b.filter.as_str(), b.instrument.as_str(), b.pivot_um), ("F277W", "NIRCam", 2.786));
        assert!(detect_band_from_filename("psf_f200w_to_f444w.fits").is_none());
        let b = detect_band_from_filename("mosaic_f160w.fits").unwrap();
        assert_eq!((b.telescope.as_str(), b.pivot_um), ("HST", 1.5369));
        assert!(detect_band_from_filename("image.fits").is_none());
    }
}
