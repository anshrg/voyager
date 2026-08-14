//! LRU cache of materialized table columns, keyed by (path, hdu, column).
//!
//! Why (docs/CROSSMATCH_PLAN.md decision 1): FITS tables are row-major, so
//! reading one column's values means scanning essentially the whole file —
//! unavoidable on first touch, but `build_view` used to re-pay that scan on
//! *every* sort/filter change (an 11 GB catalog re-read from disk per click).
//! Caching the extracted column makes every subsequent sort/filter on it a
//! memory-speed operation.
//!
//! Cells are cached as `Vec<Cell>` (not compacted key arrays) so sort/filter
//! semantics are *identical* to the per-cell path — the same `as_f64` /
//! `as_display` code runs, and the astropy table fixtures keep gating them.
//! Compaction to typed arrays is a later optimization if memory bites.
//!
//! Pure logic (no Tauri types); `lib.rs` wraps one instance in a Mutex.

use super::Cell;
use std::collections::HashMap;
use std::sync::Arc;

/// (file path, HDU index, column index)
pub type ColKey = (String, usize, usize);

struct Entry {
    cells: Arc<Vec<Cell>>,
    bytes: usize,
    last_used: u64,
}

pub struct ColCache {
    map: HashMap<ColKey, Entry>,
    budget_bytes: usize,
    bytes: usize,
    tick: u64,
}

/// Default budget: ~512 MB ≈ a dozen 1M-row columns — generous for real
/// sessions while bounded on catalogs with hundreds of columns.
pub const DEFAULT_BUDGET_BYTES: usize = 512 << 20;

impl Default for ColCache {
    fn default() -> Self {
        ColCache::new(DEFAULT_BUDGET_BYTES)
    }
}

impl ColCache {
    pub fn new(budget_bytes: usize) -> ColCache {
        ColCache { map: HashMap::new(), budget_bytes, bytes: 0, tick: 0 }
    }

    /// Cached column, bumping its recency.
    pub fn get(&mut self, key: &ColKey) -> Option<Arc<Vec<Cell>>> {
        self.tick += 1;
        let tick = self.tick;
        self.map.get_mut(key).map(|e| {
            e.last_used = tick;
            e.cells.clone()
        })
    }

    /// Insert a column, evicting least-recently-used entries while over
    /// budget. The just-inserted column is never evicted, so a single
    /// column larger than the whole budget still caches (it would otherwise
    /// be re-extracted on every view change — the exact problem this solves).
    pub fn insert(&mut self, key: ColKey, cells: Arc<Vec<Cell>>) {
        self.tick += 1;
        let bytes = cells.iter().map(cell_bytes).sum();
        if let Some(old) = self.map.insert(
            key.clone(),
            Entry { cells, bytes, last_used: self.tick },
        ) {
            self.bytes -= old.bytes;
        }
        self.bytes += bytes;
        while self.bytes > self.budget_bytes && self.map.len() > 1 {
            let victim = self
                .map
                .iter()
                .filter(|(k, _)| **k != key)
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| k.clone());
            match victim {
                Some(k) => {
                    let e = self.map.remove(&k).unwrap();
                    self.bytes -= e.bytes;
                }
                None => break,
            }
        }
    }

    /// Drop every cached column belonging to a file (called on close).
    pub fn purge_path(&mut self, path: &str) {
        self.map.retain(|k, e| {
            let keep = k.0 != path;
            if !keep {
                self.bytes -= e.bytes;
            }
            keep
        });
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

fn cell_bytes(c: &Cell) -> usize {
    std::mem::size_of::<Cell>()
        + match c {
            Cell::Str(s) => s.len(),
            _ => 0,
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(n: usize, v: f64) -> Arc<Vec<Cell>> {
        Arc::new(vec![Cell::Float(v); n])
    }

    fn key(path: &str, col: usize) -> ColKey {
        (path.to_string(), 1, col)
    }

    #[test]
    fn get_insert_roundtrip() {
        let mut c = ColCache::new(1 << 20);
        assert!(c.get(&key("a.fits", 0)).is_none());
        c.insert(key("a.fits", 0), col(10, 1.0));
        assert_eq!(c.get(&key("a.fits", 0)).unwrap().len(), 10);
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn evicts_least_recently_used_over_budget() {
        let per_col = 100 * std::mem::size_of::<Cell>();
        let mut c = ColCache::new(per_col * 2 + per_col / 2); // fits 2 columns
        c.insert(key("a.fits", 0), col(100, 0.0));
        c.insert(key("a.fits", 1), col(100, 1.0));
        c.get(&key("a.fits", 0)); // 0 now more recent than 1
        c.insert(key("a.fits", 2), col(100, 2.0));
        assert!(c.get(&key("a.fits", 1)).is_none(), "LRU col 1 evicted");
        assert!(c.get(&key("a.fits", 0)).is_some());
        assert!(c.get(&key("a.fits", 2)).is_some());
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn oversized_single_column_still_caches() {
        let mut c = ColCache::new(8); // absurdly small budget
        c.insert(key("a.fits", 0), col(100, 0.0));
        assert!(c.get(&key("a.fits", 0)).is_some());
        // A second insert evicts the first (it becomes the LRU non-new entry).
        c.insert(key("a.fits", 1), col(100, 1.0));
        assert!(c.get(&key("a.fits", 0)).is_none());
        assert!(c.get(&key("a.fits", 1)).is_some());
    }

    #[test]
    fn reinsert_replaces_and_keeps_accounting() {
        let mut c = ColCache::new(1 << 20);
        c.insert(key("a.fits", 0), col(100, 0.0));
        let b1 = c.bytes();
        c.insert(key("a.fits", 0), col(50, 0.0));
        assert_eq!(c.len(), 1);
        assert!(c.bytes() < b1);
    }

    #[test]
    fn purge_path_drops_only_that_file() {
        let mut c = ColCache::new(1 << 20);
        c.insert(key("a.fits", 0), col(10, 0.0));
        c.insert(key("b.fits", 0), col(10, 0.0));
        c.purge_path("a.fits");
        assert!(c.get(&key("a.fits", 0)).is_none());
        assert!(c.get(&key("b.fits", 0)).is_some());
        assert_eq!(c.len(), 1);
        c.purge_path("b.fits");
        assert!(c.is_empty());
        assert_eq!(c.bytes(), 0);
    }

    #[test]
    fn string_cells_count_heap_bytes() {
        let mut c = ColCache::new(1 << 20);
        c.insert(
            key("a.fits", 0),
            Arc::new(vec![Cell::Str("x".repeat(100)); 10]),
        );
        assert!(c.bytes() >= 10 * (std::mem::size_of::<Cell>() + 100));
    }
}
