//! World Coordinate System: pixel ↔ sky transforms for TAN (gnomonic)
//! images, the projection used by essentially all modern imaging mosaics.
//!
//! Design constraints (same as `fits`):
//! - No Tauri types; pure and unit-testable.
//! - Correctness gated on astropy fixtures (`wcs_checks` in expected.json):
//!   pix→world and world→pix must match astropy's `WCS.wcs_pix2world` /
//!   `wcs_world2pix` to 1e-6.
//!
//! Scope (M2): 2-D celestial TAN, CD matrix or PC+CDELT or legacy
//! CDELT+CROTA2, either axis order (RA/lon on axis 1 or 2), LONPOLE
//! honored. `RA---TAN-SIP` is accepted with the SIP distortion IGNORED
//! (fine for drizzled mosaics whose residuals are tiny; full SIP is in
//! the backlog). Other projections → `Wcs::from_header` returns None and
//! the UI simply shows pixel coordinates only.

pub mod coords;

use crate::fits::Header;
use serde::Serialize;

const D2R: f64 = std::f64::consts::PI / 180.0;
const R2D: f64 = 180.0 / std::f64::consts::PI;

#[derive(Debug, Clone)]
pub struct Wcs {
    /// Reference pixel, FITS 1-based, in axis order (CRPIX1, CRPIX2).
    crpix: [f64; 2],
    /// Celestial (lon, lat) of the fiducial point in degrees.
    lon0: f64,
    lat0: f64,
    /// Linearized CD matrix (deg/pixel): intermediate_i = Σ_j cd[i][j]·Δp_j.
    cd: [[f64; 2]; 2],
    cd_inv: [[f64; 2]; 2],
    /// Native longitude of the celestial pole, degrees (LONPOLE).
    lonpole: f64,
    /// True when axis 1 is the latitude axis (CTYPE1 = DEC--TAN).
    swapped: bool,
    /// True when CTYPE carried a -SIP suffix we are ignoring.
    pub sip_ignored: bool,
}

/// Serializable snapshot of a WCS's linear + TAN parameters, so the frontend
/// can run pix↔world synchronously — multi-frame WCS-lock broadcasts a camera
/// on every pan frame, and catalog overlay projects thousands of sources, both
/// of which would stutter with a per-point IPC round-trip. The TS mirror of
/// `pix_to_world`/`world_to_pix` (in `src/render/wcs.ts`) reads these fields.
#[derive(Debug, Clone, Serialize)]
pub struct WcsParams {
    pub crpix: [f64; 2],
    pub lon0: f64,
    pub lat0: f64,
    pub cd: [[f64; 2]; 2],
    pub cd_inv: [[f64; 2]; 2],
    pub lonpole: f64,
    pub swapped: bool,
}

/// Axis classification from the first 4 chars of CTYPEn.
fn axis_class(ctype: &str) -> Option<bool> {
    // Some(true) = longitude-like, Some(false) = latitude-like.
    let code = ctype.get(..4).unwrap_or(ctype).trim_end_matches('-');
    if code == "RA" || code.ends_with("LON") {
        Some(true)
    } else if code == "DEC" || code.ends_with("LAT") {
        Some(false)
    } else {
        None
    }
}

/// Projection code (chars 5..8 of CTYPEn) and whether -SIP follows.
fn projection(ctype: &str) -> (Option<&str>, bool) {
    let proj = ctype.get(5..8);
    let sip = ctype.get(8..).is_some_and(|rest| rest.starts_with("-SIP"));
    (proj, sip)
}

impl Wcs {
    /// Build from a FITS header; None when there is no supported celestial
    /// TAN WCS (the viewer then falls back to pixel-only readout).
    pub fn from_header(h: &Header) -> Option<Wcs> {
        let ctype1 = h.get_str("CTYPE1")?.trim().to_string();
        let ctype2 = h.get_str("CTYPE2")?.trim().to_string();
        let (proj1, sip1) = projection(&ctype1);
        let (proj2, sip2) = projection(&ctype2);
        if proj1 != Some("TAN") || proj2 != Some("TAN") {
            return None;
        }
        let lon_first = match (axis_class(&ctype1), axis_class(&ctype2)) {
            (Some(true), Some(false)) => true,
            (Some(false), Some(true)) => false,
            _ => return None,
        };

        let crpix = [h.get_f64("CRPIX1")?, h.get_f64("CRPIX2")?];
        let crval = [h.get_f64("CRVAL1")?, h.get_f64("CRVAL2")?];
        let (lon0, lat0) = if lon_first {
            (crval[0], crval[1])
        } else {
            (crval[1], crval[0])
        };

        // Linear part: CD beats PC+CDELT beats CDELT+CROTA2.
        let cd = if ["CD1_1", "CD1_2", "CD2_1", "CD2_2"]
            .iter()
            .any(|k| h.get_f64(k).is_some())
        {
            [
                [h.get_f64("CD1_1").unwrap_or(0.0), h.get_f64("CD1_2").unwrap_or(0.0)],
                [h.get_f64("CD2_1").unwrap_or(0.0), h.get_f64("CD2_2").unwrap_or(0.0)],
            ]
        } else {
            let cdelt = [h.get_f64("CDELT1").unwrap_or(1.0), h.get_f64("CDELT2").unwrap_or(1.0)];
            if ["PC1_1", "PC1_2", "PC2_1", "PC2_2"]
                .iter()
                .any(|k| h.get_f64(k).is_some())
            {
                let pc = [
                    [h.get_f64("PC1_1").unwrap_or(1.0), h.get_f64("PC1_2").unwrap_or(0.0)],
                    [h.get_f64("PC2_1").unwrap_or(0.0), h.get_f64("PC2_2").unwrap_or(1.0)],
                ];
                [
                    [cdelt[0] * pc[0][0], cdelt[0] * pc[0][1]],
                    [cdelt[1] * pc[1][0], cdelt[1] * pc[1][1]],
                ]
            } else {
                let rho = h.get_f64("CROTA2").unwrap_or(0.0) * D2R;
                [
                    [cdelt[0] * rho.cos(), -cdelt[1] * rho.sin()],
                    [cdelt[0] * rho.sin(), cdelt[1] * rho.cos()],
                ]
            }
        };

        let det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
        if det == 0.0 || !det.is_finite() {
            return None;
        }
        let cd_inv = [
            [cd[1][1] / det, -cd[0][1] / det],
            [-cd[1][0] / det, cd[0][0] / det],
        ];

        Some(Wcs {
            crpix,
            lon0,
            lat0,
            cd,
            cd_inv,
            lonpole: h.get_f64("LONPOLE").unwrap_or(180.0),
            swapped: !lon_first,
            sip_ignored: sip1 || sip2,
        })
    }

    /// FITS 0-based pixel (astropy origin=0 convention: integer coordinate =
    /// pixel center) → (lon, lat) in degrees, lon normalized to [0, 360).
    pub fn pix_to_world(&self, x: f64, y: f64) -> (f64, f64) {
        let dp = [x + 1.0 - self.crpix[0], y + 1.0 - self.crpix[1]];
        let u = self.cd[0][0] * dp[0] + self.cd[0][1] * dp[1];
        let v = self.cd[1][0] * dp[0] + self.cd[1][1] * dp[1];
        // Projection-plane coords: x along native lon axis, y along lat axis.
        let (px, py) = if self.swapped { (v, u) } else { (u, v) };

        // TAN: native spherical coords from the tangent plane.
        let r = px.hypot(py);
        let phi = if r == 0.0 { 0.0 } else { px.atan2(-py) };
        let theta = if r == 0.0 {
            std::f64::consts::FRAC_PI_2
        } else {
            (R2D / r).atan()
        };

        // Rotate native → celestial. For zenithal projections the native
        // pole is the fiducial point, so (α_p, δ_p) = CRVAL, φ_p = LONPOLE.
        let (sin_t, cos_t) = theta.sin_cos();
        let (sin_dp, cos_dp) = (self.lat0 * D2R).sin_cos();
        let dphi = phi - self.lonpole * D2R;
        let (sin_dphi, cos_dphi) = dphi.sin_cos();

        let lat = (sin_t * sin_dp + cos_t * cos_dp * cos_dphi).clamp(-1.0, 1.0).asin();
        let lon = self.lon0 * D2R
            + (-cos_t * sin_dphi).atan2(sin_t * cos_dp - cos_t * sin_dp * cos_dphi);

        ((lon * R2D).rem_euclid(360.0), lat * R2D)
    }

    /// (lon, lat) degrees → FITS 0-based pixel. None when the point is on or
    /// behind the tangent-plane horizon (≥ 90° from the field center).
    pub fn world_to_pix(&self, lon: f64, lat: f64) -> Option<(f64, f64)> {
        let (sin_d, cos_d) = (lat * D2R).sin_cos();
        let (sin_dp, cos_dp) = (self.lat0 * D2R).sin_cos();
        let da = (lon - self.lon0) * D2R;
        let (sin_da, cos_da) = da.sin_cos();

        // Native-frame direction cosines, avoiding asin/tan so the
        // reference point maps back to CRPIX exactly (a = cosθ·sin(φ−φ_p),
        // b = cosθ·cos(φ−φ_p), n = sinθ).
        let a = -cos_d * sin_da;
        let b = sin_d * cos_dp - cos_d * sin_dp * cos_da;
        let n = sin_d * sin_dp + cos_d * cos_dp * cos_da;
        if n <= 0.0 {
            return None;
        }
        let (sin_pp, cos_pp) = (self.lonpole * D2R).sin_cos();
        // TAN: x = (180/π)·cosθ sinφ / sinθ, y = −(180/π)·cosθ cosφ / sinθ.
        let px = R2D * (a * cos_pp + b * sin_pp) / n;
        let py = -R2D * (b * cos_pp - a * sin_pp) / n;
        let (u, v) = if self.swapped { (py, px) } else { (px, py) };

        let dp0 = self.cd_inv[0][0] * u + self.cd_inv[0][1] * v;
        let dp1 = self.cd_inv[1][0] * u + self.cd_inv[1][1] * v;
        Some((dp0 + self.crpix[0] - 1.0, dp1 + self.crpix[1] - 1.0))
    }

    /// Snapshot the parameters for the frontend TAN mirror (WCS-lock, catalog
    /// projection). See `WcsParams`.
    pub fn params(&self) -> WcsParams {
        WcsParams {
            crpix: self.crpix,
            lon0: self.lon0,
            lat0: self.lat0,
            cd: self.cd,
            cd_inv: self.cd_inv,
            lonpole: self.lonpole,
            swapped: self.swapped,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fits::{Header, Card, Value};

    fn header(cards: &[(&str, f64)]) -> Header {
        let mut all = vec![
            Card {
                key: "CTYPE1".into(),
                value: Some(Value::Str("RA---TAN".into())),
                comment: None,
                raw: String::new(),
            },
            Card {
                key: "CTYPE2".into(),
                value: Some(Value::Str("DEC--TAN".into())),
                comment: None,
                raw: String::new(),
            },
        ];
        for (k, v) in cards {
            all.push(Card {
                key: (*k).into(),
                value: Some(Value::Float(*v)),
                comment: None,
                raw: String::new(),
            });
        }
        Header { cards: all }
    }

    #[test]
    fn reference_pixel_maps_to_crval() {
        let h = header(&[
            ("CRPIX1", 100.0),
            ("CRPIX2", 200.0),
            ("CRVAL1", 150.5),
            ("CRVAL2", -30.25),
            ("CD1_1", -1e-4),
            ("CD2_2", 1e-4),
        ]);
        let w = Wcs::from_header(&h).unwrap();
        // 0-based pixel of CRPIX (1-based) is crpix-1.
        let (ra, dec) = w.pix_to_world(99.0, 199.0);
        assert!((ra - 150.5).abs() < 1e-9, "ra {ra}");
        assert!((dec + 30.25).abs() < 1e-9, "dec {dec}");
        let (x, y) = w.world_to_pix(150.5, -30.25).unwrap();
        assert!((x - 99.0).abs() < 1e-6 && (y - 199.0).abs() < 1e-6, "({x},{y})");
    }

    #[test]
    fn roundtrip_across_field() {
        let h = header(&[
            ("CRPIX1", 512.0),
            ("CRPIX2", 512.0),
            ("CRVAL1", 10.0),
            ("CRVAL2", 41.0),
            ("CD1_1", -2.8e-4),
            ("CD1_2", 1.3e-5),
            ("CD2_1", 1.2e-5),
            ("CD2_2", 2.8e-4),
        ]);
        let w = Wcs::from_header(&h).unwrap();
        for &(x, y) in &[(0.0, 0.0), (1023.0, 0.0), (317.5, 811.25), (511.0, 511.0)] {
            let (ra, dec) = w.pix_to_world(x, y);
            let (bx, by) = w.world_to_pix(ra, dec).unwrap();
            assert!((bx - x).abs() < 1e-6 && (by - y).abs() < 1e-6, "({x},{y}) → ({bx},{by})");
        }
    }

    #[test]
    fn behind_tangent_plane_is_none() {
        let h = header(&[
            ("CRPIX1", 1.0),
            ("CRPIX2", 1.0),
            ("CRVAL1", 150.0),
            ("CRVAL2", 2.0),
            ("CD1_1", -1e-4),
            ("CD2_2", 1e-4),
        ]);
        let w = Wcs::from_header(&h).unwrap();
        assert!(w.world_to_pix(330.0, -2.0).is_none()); // antipode
    }

    #[test]
    fn non_tan_is_none() {
        let mut h = header(&[("CRPIX1", 1.0), ("CRPIX2", 1.0), ("CRVAL1", 0.0), ("CRVAL2", 0.0)]);
        h.cards[0].value = Some(Value::Str("RA---SIN".into()));
        assert!(Wcs::from_header(&h).is_none());
    }

    #[test]
    fn sip_suffix_accepted_and_flagged() {
        let mut h = header(&[
            ("CRPIX1", 1.0),
            ("CRPIX2", 1.0),
            ("CRVAL1", 0.0),
            ("CRVAL2", 0.0),
            ("CD1_1", 1e-4),
            ("CD2_2", 1e-4),
        ]);
        h.cards[0].value = Some(Value::Str("RA---TAN-SIP".into()));
        h.cards[1].value = Some(Value::Str("DEC--TAN-SIP".into()));
        let w = Wcs::from_header(&h).unwrap();
        assert!(w.sip_ignored);
    }
}
