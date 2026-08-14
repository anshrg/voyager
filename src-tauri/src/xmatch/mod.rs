//! Sky crossmatching: k-d tree over unit vectors, best/all pair matching
//! within an angular radius, and single-point cone queries. Pure logic (no
//! Tauri types), unit-tested and gated on astropy fixtures
//! (`tests/xmatch_fixtures.rs` vs `scripts/gen_xmatch_fixtures.py`).
//!
//! Design (issue #10 + docs/CROSSMATCH_PLAN.md):
//! - Positions become 3-D unit vectors; an angular radius θ becomes a chord
//!   radius `2·sin(θ/2)`, so a plain Euclidean k-d tree is exact on the
//!   sphere — RA wrap and pole proximity need no special cases.
//! - Rows with a non-finite RA or Dec are skipped and counted; callers
//!   surface the count as a warning (like region parse warnings).
//! - Inclusive radius (`sep <= radius`), matching astropy's
//!   `search_around_sky`.

/// One matched pair: row indices into the two input position arrays plus the
/// angular separation in degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pair {
    pub a: u64,
    pub b: u64,
    pub sep_deg: f64,
}

/// Match semantics. `Best`: each A row pairs with its nearest B row within
/// the radius (a B row may appear multiple times) — TOPCAT "Best match for
/// each Table 1 row". `All`: every A–B pair within the radius.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchMode {
    Best,
    All,
}

#[derive(Debug)]
pub struct MatchResult {
    /// Matched pairs, ordered by A row (Best) or (A row, separation) (All).
    pub pairs: Vec<Pair>,
    /// Rows skipped for non-finite coordinates, per side.
    pub skipped_a: usize,
    pub skipped_b: usize,
}

/// Crossmatch catalog A against catalog B within `radius_deg`.
/// `ra`/`dec` are degrees; rows where either is non-finite are skipped.
pub fn crossmatch(
    ra_a: &[f64],
    dec_a: &[f64],
    ra_b: &[f64],
    dec_b: &[f64],
    radius_deg: f64,
    mode: MatchMode,
) -> MatchResult {
    let index = SkyIndex::build(ra_b, dec_b);
    let n_a = ra_a.len().min(dec_a.len());
    let mut pairs = Vec::new();
    let mut skipped_a = 0usize;
    for i in 0..n_a {
        let (ra, dec) = (ra_a[i], dec_a[i]);
        if !ra.is_finite() || !dec.is_finite() {
            skipped_a += 1;
            continue;
        }
        match mode {
            MatchMode::Best => {
                if let Some((j, sep_deg)) = index.nearest_within(ra, dec, radius_deg) {
                    pairs.push(Pair { a: i as u64, b: j, sep_deg });
                }
            }
            MatchMode::All => {
                for (j, sep_deg) in index.within(ra, dec, radius_deg) {
                    pairs.push(Pair { a: i as u64, b: j, sep_deg });
                }
            }
        }
    }
    MatchResult { pairs, skipped_a, skipped_b: index.skipped }
}

/// A k-d tree over one catalog's positions, reusable across queries (the
/// single-coordinate probe is one `within` call on a prebuilt index).
pub struct SkyIndex {
    nodes: Vec<Node>,
    root: u32,
    /// Rows skipped at build for non-finite coordinates.
    pub skipped: usize,
}

const NONE: u32 = u32::MAX;

struct Node {
    p: [f64; 3],
    /// Original row index in the input arrays.
    orig: u32,
    axis: u8,
    left: u32,
    right: u32,
}

impl SkyIndex {
    /// Build from RA/Dec in degrees, skipping non-finite rows. Row indices
    /// reported by queries refer to the original arrays.
    pub fn build(ra_deg: &[f64], dec_deg: &[f64]) -> SkyIndex {
        let n = ra_deg.len().min(dec_deg.len());
        let mut pts: Vec<([f64; 3], u32)> = Vec::with_capacity(n);
        for i in 0..n {
            if ra_deg[i].is_finite() && dec_deg[i].is_finite() {
                pts.push((unit_vector(ra_deg[i], dec_deg[i]), i as u32));
            }
        }
        let skipped = n - pts.len();
        let mut nodes = Vec::with_capacity(pts.len());
        let root = build_range(&mut pts, &mut nodes);
        SkyIndex { nodes, root, skipped }
    }

    /// Number of indexed (valid) positions.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Nearest indexed row within `radius_deg` of (ra, dec), as
    /// `(original row, separation deg)`. Ties break to the lowest row index.
    pub fn nearest_within(&self, ra_deg: f64, dec_deg: f64, radius_deg: f64) -> Option<(u64, f64)> {
        if self.nodes.is_empty() || !radius_deg.is_finite() {
            return None;
        }
        let q = unit_vector(ra_deg, dec_deg);
        let mut best: Option<(f64, u32)> = None; // (chord², orig)
        let r2 = chord2_from_deg(radius_deg);
        self.nearest_rec(self.root, &q, r2, &mut best);
        best.map(|(d2, orig)| (orig as u64, sep_deg_from_chord2(d2)))
    }

    fn nearest_rec(&self, node: u32, q: &[f64; 3], limit2: f64, best: &mut Option<(f64, u32)>) {
        if node == NONE {
            return;
        }
        let n = &self.nodes[node as usize];
        let d2 = dist2(&n.p, q);
        if d2 <= limit2 {
            let better = match *best {
                None => true,
                Some((bd2, borig)) => d2 < bd2 || (d2 == bd2 && n.orig < borig),
            };
            if better {
                *best = Some((d2, n.orig));
            }
        }
        let dx = q[n.axis as usize] - n.p[n.axis as usize];
        let (near, far) = if dx <= 0.0 { (n.left, n.right) } else { (n.right, n.left) };
        self.nearest_rec(near, q, limit2, best);
        // Visit the far side only if the splitting plane lies within the
        // current search bound (`best` may have shrunk during the near visit;
        // `<=` keeps exact-distance ties reachable for the index tie-break).
        let bound2 = best.map(|(b, _)| b.min(limit2)).unwrap_or(limit2);
        if dx * dx <= bound2 {
            self.nearest_rec(far, q, limit2, best);
        }
    }

    /// All indexed rows within `radius_deg` of (ra, dec), sorted by
    /// separation (ties by row index), as `(original row, separation deg)`.
    pub fn within(&self, ra_deg: f64, dec_deg: f64, radius_deg: f64) -> Vec<(u64, f64)> {
        let mut out = Vec::new();
        if self.nodes.is_empty() || !radius_deg.is_finite() {
            return out;
        }
        let q = unit_vector(ra_deg, dec_deg);
        let r2 = chord2_from_deg(radius_deg);
        self.within_rec(self.root, &q, r2, &mut out);
        out.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        out
    }

    fn within_rec(&self, node: u32, q: &[f64; 3], r2: f64, out: &mut Vec<(u64, f64)>) {
        if node == NONE {
            return;
        }
        let n = &self.nodes[node as usize];
        let d2 = dist2(&n.p, q);
        if d2 <= r2 {
            out.push((n.orig as u64, sep_deg_from_chord2(d2)));
        }
        let dx = q[n.axis as usize] - n.p[n.axis as usize];
        let (near, far) = if dx <= 0.0 { (n.left, n.right) } else { (n.right, n.left) };
        self.within_rec(near, q, r2, out);
        if dx * dx <= r2 {
            self.within_rec(far, q, r2, out);
        }
    }
}

/// Recursively build a balanced subtree over `pts`; returns the node index.
fn build_range(pts: &mut [([f64; 3], u32)], nodes: &mut Vec<Node>) -> u32 {
    if pts.is_empty() {
        return NONE;
    }
    // Split on the axis with the widest spread for better-balanced cells.
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for (p, _) in pts.iter() {
        for a in 0..3 {
            lo[a] = lo[a].min(p[a]);
            hi[a] = hi[a].max(p[a]);
        }
    }
    let axis = (0..3).max_by(|&i, &j| (hi[i] - lo[i]).total_cmp(&(hi[j] - lo[j]))).unwrap();
    let mid = pts.len() / 2;
    pts.select_nth_unstable_by(mid, |a, b| a.0[axis].total_cmp(&b.0[axis]));
    let (p, orig) = pts[mid];
    let slot = nodes.len() as u32;
    nodes.push(Node { p, orig, axis: axis as u8, left: NONE, right: NONE });
    let (left_pts, rest) = pts.split_at_mut(mid);
    let left = build_range(left_pts, nodes);
    let right = build_range(&mut rest[1..], nodes);
    let n = &mut nodes[slot as usize];
    n.left = left;
    n.right = right;
    slot
}

// ---- sphere geometry --------------------------------------------------------

fn unit_vector(ra_deg: f64, dec_deg: f64) -> [f64; 3] {
    let (ra, dec) = (ra_deg.to_radians(), dec_deg.to_radians());
    let (sr, cr) = ra.sin_cos();
    let (sd, cd) = dec.sin_cos();
    [cd * cr, cd * sr, sd]
}

fn dist2(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    dx * dx + dy * dy + dz * dz
}

/// Squared chord length for an angular radius in degrees (clamped to the
/// sphere's diameter).
fn chord2_from_deg(radius_deg: f64) -> f64 {
    let theta = radius_deg.to_radians().clamp(0.0, std::f64::consts::PI);
    let c = 2.0 * (theta / 2.0).sin();
    c * c
}

/// Angular separation in degrees from a squared chord length. `asin` of the
/// half-chord is numerically stable for the small angles that matter.
fn sep_deg_from_chord2(d2: f64) -> f64 {
    let half = (d2.max(0.0).sqrt() / 2.0).min(1.0);
    (2.0 * half.asin()).to_degrees()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic xorshift so tests don't need a rand dependency.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            (x >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    fn brute_within(
        q: (f64, f64),
        ra: &[f64],
        dec: &[f64],
        radius_deg: f64,
    ) -> Vec<(u64, f64)> {
        let qv = unit_vector(q.0, q.1);
        let r2 = chord2_from_deg(radius_deg);
        let mut out: Vec<(u64, f64)> = (0..ra.len())
            .filter(|&i| ra[i].is_finite() && dec[i].is_finite())
            .filter_map(|i| {
                let d2 = dist2(&qv, &unit_vector(ra[i], dec[i]));
                (d2 <= r2).then(|| (i as u64, sep_deg_from_chord2(d2)))
            })
            .collect();
        out.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        out
    }

    #[test]
    fn kdtree_matches_brute_force() {
        let mut rng = Rng(0x5eed);
        let n = 500;
        let ra: Vec<f64> = (0..n).map(|_| rng.next() * 360.0).collect();
        let dec: Vec<f64> = (0..n).map(|_| rng.next() * 180.0 - 90.0).collect();
        let index = SkyIndex::build(&ra, &dec);
        for _ in 0..200 {
            let q = (rng.next() * 360.0, rng.next() * 180.0 - 90.0);
            let radius = rng.next() * 10.0; // up to 10 deg on a sparse sphere
            let got = index.within(q.0, q.1, radius);
            let want = brute_within(q, &ra, &dec, radius);
            assert_eq!(got, want, "within({q:?}, {radius})");
            let nearest = index.nearest_within(q.0, q.1, radius);
            assert_eq!(nearest, want.first().copied(), "nearest({q:?}, {radius})");
        }
    }

    #[test]
    fn skips_and_counts_non_finite() {
        let ra = [150.0, f64::NAN, 150.0002];
        let dec = [2.0, 2.0, f64::INFINITY];
        let index = SkyIndex::build(&ra, &dec);
        assert_eq!(index.len(), 1);
        assert_eq!(index.skipped, 2);

        let result = crossmatch(&[150.0, f64::NAN], &[2.0, 2.0], &ra, &dec, 1.0 / 3600.0, MatchMode::Best);
        assert_eq!(result.skipped_a, 1);
        assert_eq!(result.skipped_b, 2);
        assert_eq!(result.pairs.len(), 1);
        assert_eq!((result.pairs[0].a, result.pairs[0].b), (0, 0));
        assert!(result.pairs[0].sep_deg < 1e-12);
    }

    #[test]
    fn empty_inputs_are_fine() {
        let empty: [f64; 0] = [];
        assert!(SkyIndex::build(&empty, &empty).is_empty());
        let r = crossmatch(&empty, &empty, &[1.0], &[1.0], 1.0, MatchMode::All);
        assert!(r.pairs.is_empty());
        assert_eq!(
            SkyIndex::build(&[1.0], &[1.0]).nearest_within(180.0, -45.0, 0.5),
            None
        );
    }

    #[test]
    fn zero_radius_matches_identical_positions() {
        let r = crossmatch(&[10.0], &[5.0], &[10.0, 10.1], &[5.0, 5.0], 0.0, MatchMode::All);
        assert_eq!(r.pairs.len(), 1);
        assert_eq!(r.pairs[0].sep_deg, 0.0);
    }

    #[test]
    fn best_ties_break_to_lowest_row() {
        // Two identical B rows equidistant from the query: lowest index wins.
        let r = crossmatch(&[150.0], &[2.0], &[150.001, 150.001], &[2.0, 2.0], 10.0, MatchMode::Best);
        assert_eq!(r.pairs.len(), 1);
        assert_eq!(r.pairs[0].b, 0);
    }

    #[test]
    fn wrap_and_pole_need_no_special_case() {
        // 359.9995 and 0.0005 are 3.6" apart across the RA wrap (at dec 0).
        let r = crossmatch(&[359.9995], &[0.0], &[0.0005], &[0.0], 5.0 / 3600.0, MatchMode::Best);
        assert_eq!(r.pairs.len(), 1);
        assert!((r.pairs[0].sep_deg - 3.6 / 3600.0).abs() < 1e-9);

        // Near the pole, RA 0 and RA 180 at dec 89.999 are ~7.2" apart.
        let r = crossmatch(&[0.0], &[89.999], &[180.0], &[89.999], 10.0 / 3600.0, MatchMode::Best);
        assert_eq!(r.pairs.len(), 1);
        assert!((r.pairs[0].sep_deg - 2.0 * 0.001).abs() < 1e-9);
    }
}
