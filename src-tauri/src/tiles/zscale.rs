//! zscale display-limit algorithm, matching astropy's `ZScaleInterval`
//! (which follows IRAF/DS9): iterative sigma-clipped linear fit to the
//! sorted sample values; limits from the fitted slope divided by contrast.
//!
//! Fixture-tested against astropy output (tests/fixtures.rs). The input is
//! the flattened pixel array (or a spatial sample of it for huge images —
//! see tiles::gather_values); this function reproduces astropy's own
//! finite-filter → stride → sort → fit pipeline from there.

pub struct ZScaleParams {
    pub nsamples: usize,
    pub contrast: f64,
    pub max_reject: f64,
    pub min_npixels: usize,
    pub krej: f64,
    pub max_iterations: usize,
}

impl Default for ZScaleParams {
    fn default() -> Self {
        ZScaleParams {
            nsamples: 1000,
            contrast: 0.25,
            max_reject: 0.5,
            min_npixels: 5,
            krej: 2.5,
            max_iterations: 5,
        }
    }
}

/// Least-squares line fit y = slope*x + intercept over points where
/// `good[i]`, with x = i as f64. Returns None if < 2 good points.
fn fit_line(values: &[f64], good: &[bool]) -> Option<(f64, f64)> {
    let mut n = 0f64;
    let (mut sx, mut sy) = (0f64, 0f64);
    for (i, v) in values.iter().enumerate() {
        if good[i] {
            n += 1.0;
            sx += i as f64;
            sy += v;
        }
    }
    if n < 2.0 {
        return None;
    }
    let (mx, my) = (sx / n, sy / n);
    let (mut sxx, mut sxy) = (0f64, 0f64);
    for (i, v) in values.iter().enumerate() {
        if good[i] {
            let dx = i as f64 - mx;
            sxx += dx * dx;
            sxy += dx * (v - my);
        }
    }
    if sxx == 0.0 {
        return None;
    }
    let slope = sxy / sxx;
    Some((slope, my - slope * mx))
}

/// Grow the bad-pixel mask like astropy's
/// `np.convolve(badpix, np.ones(ngrow), mode="same") > 0`:
/// out[i] = any(bad[j]) for j in [i - ngrow + 1 + (ngrow-1)/2, i + (ngrow-1)/2].
fn grow_mask(bad: &[bool], ngrow: usize) -> Vec<bool> {
    let n = bad.len();
    let half = (ngrow - 1) / 2;
    let mut out = vec![false; n];
    for (i, o) in out.iter_mut().enumerate() {
        let center = i + half;
        let lo = center.saturating_sub(ngrow - 1);
        let hi = center.min(n - 1);
        *o = bad[lo..=hi].iter().any(|&b| b);
    }
    out
}

/// Compute (vmin, vmax) display limits. `values` is the flattened pixel
/// array in row-major order (may contain NaN/inf). Returns None when there
/// are no finite pixels at all.
pub fn zscale(values: &[f64], p: &ZScaleParams) -> Option<(f64, f64)> {
    // astropy: filter non-finite, stride to nsamples, sort.
    let finite: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if finite.is_empty() {
        return None;
    }
    let stride = ((finite.len() as f64) / (p.nsamples as f64)).max(1.0) as usize;
    let mut samples: Vec<f64> = finite
        .iter()
        .step_by(stride)
        .take(p.nsamples)
        .copied()
        .collect();
    samples.sort_by(f64::total_cmp);

    let npix = samples.len();
    let vmin = samples[0];
    let vmax = samples[npix - 1];
    if npix == 1 {
        return Some((vmin, vmax));
    }

    let minpix = p.min_npixels.max((npix as f64 * p.max_reject) as usize);
    let ngrow = ((npix as f64 * 0.01) as usize).max(1);
    let mut bad = vec![false; npix];
    let mut ngood = npix;
    let mut last_ngood = npix + 1;
    let mut fit: Option<(f64, f64)> = None;

    for _ in 0..p.max_iterations {
        if ngood >= last_ngood || ngood < minpix {
            break;
        }
        let good: Vec<bool> = bad.iter().map(|&b| !b).collect();
        let Some(line) = fit_line(&samples, &good) else {
            break;
        };
        fit = Some(line);
        let (slope, intercept) = line;

        // k-sigma of residuals over currently-good pixels (population std).
        let residual = |i: usize| samples[i] - (slope * i as f64 + intercept);
        let mut n = 0f64;
        let (mut s, mut s2) = (0f64, 0f64);
        for i in 0..npix {
            if good[i] {
                let r = residual(i);
                n += 1.0;
                s += r;
                s2 += r * r;
            }
        }
        let mean = s / n;
        let std = (s2 / n - mean * mean).max(0.0).sqrt();
        let threshold = p.krej * std;

        for (i, b) in bad.iter_mut().enumerate() {
            if residual(i).abs() > threshold {
                *b = true;
            }
        }
        bad = grow_mask(&bad, ngrow);
        last_ngood = ngood;
        ngood = bad.iter().filter(|&&b| !b).count();
    }

    let (mut lo, mut hi) = (vmin, vmax);
    if ngood >= minpix {
        if let Some((mut slope, _)) = fit {
            if p.contrast > 0.0 {
                slope /= p.contrast;
            }
            let center = (npix - 1) / 2;
            let median = if npix % 2 == 1 {
                samples[npix / 2]
            } else {
                0.5 * (samples[npix / 2 - 1] + samples[npix / 2])
            };
            lo = vmin.max(median - (center as f64 - 1.0) * slope);
            hi = vmax.min(median + (npix - center) as f64 * slope);
        }
    }
    Some((lo, hi))
}

/// Min/max of the finite values (None if none are finite).
pub fn minmax(values: &[f64]) -> Option<(f64, f64)> {
    let mut it = values.iter().copied().filter(|v| v.is_finite());
    let first = it.next()?;
    let (mut lo, mut hi) = (first, first);
    for v in it {
        if v < lo {
            lo = v;
        }
        if v > hi {
            hi = v;
        }
    }
    Some((lo, hi))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_ramp_recovers_full_range() {
        // A pure linear ramp has no outliers: the fitted slope over
        // npix samples spans the whole range, so limits ≈ min/max.
        let values: Vec<f64> = (0..2000).map(|i| i as f64).collect();
        let (lo, hi) = zscale(&values, &ZScaleParams::default()).unwrap();
        assert!(lo <= 10.0, "lo = {lo}");
        assert!(hi >= 1990.0, "hi = {hi}");
    }

    #[test]
    fn ignores_nan() {
        let mut values: Vec<f64> = (0..1000).map(|i| i as f64).collect();
        values.extend([f64::NAN; 500]);
        assert!(zscale(&values, &ZScaleParams::default()).is_some());
        assert_eq!(minmax(&values), Some((0.0, 999.0)));
    }

    #[test]
    fn all_nan_is_none() {
        let values = [f64::NAN; 100];
        assert!(zscale(&values, &ZScaleParams::default()).is_none());
        assert!(minmax(&values).is_none());
    }
}
