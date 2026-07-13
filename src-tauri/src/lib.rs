pub mod fits;
pub mod regions;
pub mod table;
pub mod tiles;
pub mod wcs;
pub mod xmatch;

use fits::FitsFile;
use serde::Serialize;
use table::RowSource;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{Emitter, Manager, State};

/// Open files stay in state so their mmaps remain valid across commands.
/// Arc lets tile extraction run outside the map lock (parallel requests).
#[derive(Default)]
struct AppState {
    files: Mutex<HashMap<String, Arc<FitsFile>>>,
    /// Paths received (via file association or argv) before the frontend
    /// was ready to handle them.
    pending_opens: Mutex<Vec<String>>,
    /// Last-built table sort/filter view (see `table_view`/`table_rows`).
    table_view: Mutex<Option<TableView>>,
    /// Materialized-column LRU (see `table::cache`): extracting a column is
    /// a full-file scan on row-major FITS, so it must happen once per column,
    /// not on every sort/filter change. Arc so `table_view`'s blocking task
    /// can use it without borrowing app state.
    col_cache: Arc<Mutex<table::cache::ColCache>>,
    /// Derived (crossmatch) tables, keyed by their synthetic
    /// `voyager-derived://N` path. Parents are pinned by Arc so a derived
    /// table keeps working even if its source file is closed.
    derived: Mutex<HashMap<String, Arc<DerivedDef>>>,
    derived_seq: std::sync::atomic::AtomicU64,
}

/// A crossmatch result: the two parent tables plus the join row list —
/// ~24 bytes per matched row, never the data (cells are answered through the
/// parents' mmaps by `table::join::Joined`).
struct DerivedDef {
    name: String,
    left: (Arc<FitsFile>, usize),
    right: (Arc<FitsFile>, usize),
    rows: Vec<table::join::JoinRow>,
}

const DERIVED_SCHEME: &str = "voyager-derived://";

/// Address a table by (path, hdu): a real FITS HDU, or a derived table by
/// its synthetic path (hdu ignored). Send-able into blocking tasks.
enum TableHandle {
    Fits(Arc<FitsFile>, usize),
    Derived(Arc<DerivedDef>),
}

impl TableHandle {
    fn open(&self) -> Result<OpenTable<'_>, String> {
        match self {
            TableHandle::Fits(file, hdu) => Ok(OpenTable::Fits(table::Table::open(file, *hdu)?)),
            TableHandle::Derived(d) => {
                let left = table::Table::open(&d.left.0, d.left.1)?;
                let right = table::Table::open(&d.right.0, d.right.1)?;
                Ok(OpenTable::Joined(table::join::Joined::new(left, right, &d.rows)))
            }
        }
    }
}

/// A live table view borrowing from its handle; commands use it uniformly
/// through the `RowSource` trait.
enum OpenTable<'h> {
    Fits(table::Table<'h>),
    Joined(table::join::Joined<'h, 'h, 'h>),
}

impl<'h> RowSource for OpenTable<'h> {
    fn columns(&self) -> &[table::Column] {
        match self {
            OpenTable::Fits(t) => t.columns(),
            OpenTable::Joined(j) => j.columns(),
        }
    }

    fn nrows(&self) -> u64 {
        match self {
            OpenTable::Fits(t) => RowSource::nrows(t),
            OpenTable::Joined(j) => RowSource::nrows(j),
        }
    }

    fn cell(&self, col: usize, row: u64) -> table::Cell {
        match self {
            OpenTable::Fits(t) => RowSource::cell(t, col, row),
            OpenTable::Joined(j) => RowSource::cell(j, col, row),
        }
    }
}

fn resolve_table(
    state: &State<'_, AppState>,
    path: &str,
    hdu: usize,
) -> Result<TableHandle, String> {
    if path.starts_with(DERIVED_SCHEME) {
        let d = state
            .derived
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or("derived table not open")?;
        Ok(TableHandle::Derived(d))
    } else {
        Ok(TableHandle::Fits(lookup(state, path)?, hdu))
    }
}

/// A cached table row-order permutation, keyed by the file+HDU it belongs to.
/// `order` is `None` for the identity view (unsorted, unfiltered).
struct TableView {
    path: String,
    hdu: usize,
    order: Option<Vec<u64>>,
}

#[derive(Serialize)]
struct FileSummary {
    path: String,
    size: u64,
    hdus: Vec<fits::HduInfo>,
    /// Time spent in FitsFile::open, milliseconds.
    open_ms: f64,
}

#[tauri::command]
fn open_fits(path: String, state: State<'_, AppState>) -> Result<FileSummary, String> {
    let t0 = Instant::now();
    let file = FitsFile::open(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    let open_ms = t0.elapsed().as_secs_f64() * 1e3;
    eprintln!(
        "[voyager] open_fits {} — {} HDUs in {:.1} ms",
        path,
        file.hdus.len(),
        open_ms
    );
    let summary = FileSummary {
        path: path.clone(),
        size: file.size,
        hdus: file.hdus.clone(),
        open_ms,
    };
    state.files.lock().unwrap().insert(path, Arc::new(file));
    Ok(summary)
}

fn lookup(state: &State<'_, AppState>, path: &str) -> Result<Arc<FitsFile>, String> {
    state
        .files
        .lock()
        .unwrap()
        .get(path)
        .cloned()
        .ok_or_else(|| "file not open".to_string())
}

/// Binary tile fetch: [u32 w, u32 h] little-endian, then w*h f32 LE pixels
/// (row-major, row 0 = lowest FITS row). Async so extraction (which may
/// fault mmap pages in from disk) runs off the main thread.
#[tauri::command]
async fn get_tile(
    path: String,
    hdu: usize,
    level: u32,
    tx: u32,
    ty: u32,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let file = lookup(&state, &path)?;
    let t0 = Instant::now();
    let tile = tauri::async_runtime::spawn_blocking(move || {
        tiles::extract_tile(&file, hdu, level, tx, ty)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    eprintln!(
        "[voyager] tile L{level} ({tx},{ty}) {}x{} in {:.1} ms",
        tile.w,
        tile.h,
        t0.elapsed().as_secs_f64() * 1e3
    );

    let mut buf = Vec::with_capacity(8 + tile.data.len() * 4);
    buf.extend_from_slice(&tile.w.to_le_bytes());
    buf.extend_from_slice(&tile.h.to_le_bytes());
    for v in &tile.data {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(buf))
}

#[derive(Serialize)]
struct ScaleLimits {
    lo: f64,
    hi: f64,
}

/// Display scale limits. `mode` is "zscale" or "minmax"; large images are
/// sampled (see tiles::gather_values) so this stays fast on multi-GB files.
#[tauri::command]
async fn get_scale_limits(
    path: String,
    hdu: usize,
    mode: String,
    state: State<'_, AppState>,
) -> Result<ScaleLimits, String> {
    let file = lookup(&state, &path)?;
    let t0 = Instant::now();
    let mode_label = mode.clone();
    let limits = tauri::async_runtime::spawn_blocking(move || -> Result<(f64, f64), String> {
        // ~200k samples: two orders more than zscale's nsamples=1000 keeps
        // limits stable, while touching few enough pages that a cold 5 GiB
        // mosaic stays well inside the 1 s first-render budget.
        let values =
            tiles::gather_values(&file, hdu, 200_000).map_err(|e| e.to_string())?;
        let result = match mode.as_str() {
            "zscale" => tiles::zscale::zscale(&values, &tiles::zscale::ZScaleParams::default()),
            "minmax" => tiles::zscale::minmax(&values),
            other => return Err(format!("unknown scale mode: {other}")),
        };
        result.ok_or_else(|| "image has no finite pixels".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    eprintln!(
        "[voyager] scale_limits {mode_label} = ({:.6}, {:.6}) in {:.1} ms",
        limits.0,
        limits.1,
        t0.elapsed().as_secs_f64() * 1e3
    );
    Ok(ScaleLimits {
        lo: limits.0,
        hi: limits.1,
    })
}

#[derive(Serialize)]
struct Readout {
    /// Pixel value; None = NaN/BLANK (JSON has no NaN).
    value: Option<f64>,
    /// Sky position in degrees, when the HDU has a usable WCS.
    ra: Option<f64>,
    dec: Option<f64>,
    /// Pre-formatted sexagesimal "hh:mm:ss.sss ±dd:mm:ss.ss".
    sky: Option<String>,
}

/// Pixel readout at FITS 0-based (x, y), with sky coordinates when the HDU
/// carries a supported WCS (integer pixel coordinate = pixel center).
#[tauri::command]
fn get_readout(
    path: String,
    hdu: usize,
    x: u64,
    y: u64,
    state: State<'_, AppState>,
) -> Result<Readout, String> {
    let file = lookup(&state, &path)?;
    let v = tiles::pixel_at(&file, hdu, x, y).map_err(|e| e.to_string())?;
    let info = file.hdu(hdu).map_err(|e| e.to_string())?;
    let sky = wcs::Wcs::from_header(&info.header).map(|w| w.pix_to_world(x as f64, y as f64));
    Ok(Readout {
        value: if v.is_nan() { None } else { Some(v) },
        ra: sky.map(|(ra, _)| ra),
        dec: sky.map(|(_, dec)| dec),
        sky: sky.map(|(ra, dec)| {
            format!("{} {}", wcs::coords::fmt_ra_hms(ra), wcs::coords::fmt_dec_dms(dec))
        }),
    })
}

#[derive(Serialize)]
struct GotoResult {
    /// FITS 0-based fractional pixel of the requested sky position.
    x: f64,
    y: f64,
    ra: f64,
    dec: f64,
}

/// Parse a coordinate query ("150.116 2.206", "10:00:27.9 +02:12:20", …)
/// and locate it on the image. Errors are user-facing messages.
#[tauri::command]
fn resolve_coord(
    path: String,
    hdu: usize,
    query: String,
    state: State<'_, AppState>,
) -> Result<GotoResult, String> {
    let file = lookup(&state, &path)?;
    let info = file.hdu(hdu).map_err(|e| e.to_string())?;
    let (ra, dec) = wcs::coords::parse_coord(&query)?;
    let w = wcs::Wcs::from_header(&info.header)
        .ok_or_else(|| "this HDU has no supported WCS (TAN)".to_string())?;
    let (x, y) = w
        .world_to_pix(ra, dec)
        .ok_or_else(|| "coordinate is on the far side of the sky".to_string())?;
    Ok(GotoResult { x, y, ra, dec })
}

#[derive(Serialize)]
struct ParsedCoord {
    ra: f64,
    dec: f64,
}

/// Parse a coordinate string (sexagesimal or decimal degrees) without
/// touching any WCS — the table probe box works on catalogs that have no
/// image, where `resolve_coord`'s pixel mapping is impossible.
#[tauri::command]
fn parse_coord(query: String) -> Result<ParsedCoord, String> {
    let (ra, dec) = wcs::coords::parse_coord(&query)?;
    Ok(ParsedCoord { ra, dec })
}

/// The HDU's TAN WCS parameters for the frontend to run pix↔world locally
/// (multi-frame WCS-lock, catalog overlay projection). None = no supported
/// WCS on this HDU (the frontend then falls back to pixel-space behavior).
#[tauri::command]
fn get_wcs(
    path: String,
    hdu: usize,
    state: State<'_, AppState>,
) -> Result<Option<wcs::WcsParams>, String> {
    let file = lookup(&state, &path)?;
    let info = file.hdu(hdu).map_err(|e| e.to_string())?;
    Ok(wcs::Wcs::from_header(&info.header).map(|w| w.params()))
}

#[derive(Serialize)]
struct Histogram {
    lo: f64,
    hi: f64,
    counts: Vec<u32>,
}

/// Pixel-distribution histogram over the same spatial sample used for scale
/// limits; range = finite min..max of the sample.
#[tauri::command]
async fn get_histogram(
    path: String,
    hdu: usize,
    bins: usize,
    state: State<'_, AppState>,
) -> Result<Histogram, String> {
    let file = lookup(&state, &path)?;
    let t0 = Instant::now();
    let hist = tauri::async_runtime::spawn_blocking(move || -> Result<Histogram, String> {
        let values = tiles::gather_values(&file, hdu, 200_000).map_err(|e| e.to_string())?;
        let (lo, hi) =
            tiles::zscale::minmax(&values).ok_or_else(|| "image has no finite pixels".to_string())?;
        let counts = tiles::histogram(&values, bins, lo, hi);
        Ok(Histogram { lo, hi, counts })
    })
    .await
    .map_err(|e| e.to_string())??;
    eprintln!(
        "[voyager] histogram {bins} bins in {:.1} ms",
        t0.elapsed().as_secs_f64() * 1e3
    );
    Ok(hist)
}

#[derive(Serialize)]
struct RegionLoadResult {
    regions: Vec<regions::PixelRegion>,
    warnings: Vec<String>,
}

/// Parse a DS9 .reg file and resolve it to pixel space for one HDU (sky
/// regions go through the HDU's WCS). Unsupported content comes back as
/// warnings, not errors — partial loads are normal for DS9 files.
#[tauri::command]
fn load_region_file(
    path: String,
    hdu: usize,
    region_path: String,
    state: State<'_, AppState>,
) -> Result<RegionLoadResult, String> {
    let file = lookup(&state, &path)?;
    let info = file.hdu(hdu).map_err(|e| e.to_string())?;
    let wcs = wcs::Wcs::from_header(&info.header);
    let text = std::fs::read_to_string(&region_path)
        .map_err(|e| format!("cannot read {region_path}: {e}"))?;
    let parsed = regions::parse::parse(&text);
    let mut warnings = parsed.warnings;
    let mut out = Vec::new();
    for (i, region) in parsed.regions.iter().enumerate() {
        match region.to_pixel(wcs.as_ref()) {
            Ok(pix) => out.push(pix),
            Err(e) => warnings.push(format!("region {}: {e}", i + 1)),
        }
    }
    eprintln!(
        "[voyager] regions {} — {} loaded, {} warnings",
        region_path,
        out.len(),
        warnings.len()
    );
    Ok(RegionLoadResult { regions: out, warnings })
}

#[derive(Serialize)]
struct RegionSaveResult {
    count: usize,
    warnings: Vec<String>,
}

/// Serialize the viewer's current (edited/created) pixel regions to a .reg
/// file in the chosen frame. Unlike `save_region_file` this does not re-parse
/// the source file — it writes the in-memory regions, so edits are preserved.
/// Sky frame needs the HDU's WCS; per-region failures come back as warnings.
#[tauri::command]
fn save_pixel_regions(
    path: String,
    hdu: usize,
    regions: Vec<regions::PixelRegion>,
    frame: String,
    out_path: String,
    state: State<'_, AppState>,
) -> Result<RegionSaveResult, String> {
    let file = lookup(&state, &path)?;
    let info = file.hdu(hdu).map_err(|e| e.to_string())?;
    let wcs = wcs::Wcs::from_header(&info.header);
    let (text, warnings) =
        regions::write::write_pixel_regions(&regions, &frame, wcs.as_ref())?;
    std::fs::write(&out_path, text).map_err(|e| format!("cannot write {out_path}: {e}"))?;
    let count = regions.len() - warnings.len();
    eprintln!(
        "[voyager] regions saved (edited) → {} ({} in {} frame, {} warnings)",
        out_path,
        count,
        frame,
        warnings.len()
    );
    Ok(RegionSaveResult { count, warnings })
}

/// Column metadata for a table HDU (names, units, kinds, sortability).
/// Serves derived (crossmatch) tables too, like every table command.
#[tauri::command]
fn table_columns(
    path: String,
    hdu: usize,
    state: State<'_, AppState>,
) -> Result<Vec<table::Column>, String> {
    let handle = resolve_table(&state, &path, hdu)?;
    let t = handle.open()?;
    Ok(t.columns().to_vec())
}

#[derive(serde::Deserialize)]
struct SortReq {
    col: usize,
    desc: bool,
}

#[derive(serde::Deserialize)]
struct FilterReq {
    col: usize,
    query: String,
}

#[derive(Serialize)]
struct ViewResult {
    /// Number of rows in the resulting view (post-filter).
    nrows: u64,
}

/// Build (and cache) a sort/filter view over a table HDU. The row-order
/// permutation is stored in app state; `table_rows` then reads windows of it.
/// Runs off-thread since sorting/filtering a large catalog touches the mmap.
#[tauri::command]
async fn table_view(
    path: String,
    hdu: usize,
    sort: Option<SortReq>,
    filter: Option<FilterReq>,
    state: State<'_, AppState>,
) -> Result<ViewResult, String> {
    let handle = resolve_table(&state, &path, hdu)?;
    let sort = sort.map(|s| table::SortSpec { col: s.col, desc: s.desc });
    let filter = filter
        .filter(|f| !f.query.trim().is_empty())
        .map(|f| table::FilterSpec { col: f.col, query: f.query });

    let path2 = path.clone();
    let cache = state.col_cache.clone();
    let t0 = Instant::now();
    let (order, nrows, hits) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(Option<Vec<u64>>, u64, String), String> {
            let t = handle.open()?;
            // Sort/filter keys come from the materialized-column cache; a
            // miss pays the one-time full-column scan (outside the lock so
            // concurrent views on other files aren't blocked behind it).
            let mut hits: Vec<&str> = Vec::new();
            let fetch = |col: usize, hits: &mut Vec<&str>| -> Arc<Vec<table::Cell>> {
                let key = (path.clone(), hdu, col);
                if let Some(cells) = cache.lock().unwrap().get(&key) {
                    hits.push("hit");
                    return cells;
                }
                hits.push("miss");
                let cells = Arc::new(t.extract_column(col));
                cache.lock().unwrap().insert(key, cells.clone());
                cells
            };
            let sort_cells = sort.map(|s| fetch(s.col, &mut hits));
            let filter_cells = filter.as_ref().map(|f| fetch(f.col, &mut hits));
            let order = table::build_view_from(
                sort,
                filter,
                t.columns(),
                sort_cells.as_deref().map(|v| v.as_slice()),
                filter_cells.as_deref().map(|v| v.as_slice()),
                t.nrows(),
            );
            let nrows = order.as_ref().map(|v| v.len() as u64).unwrap_or_else(|| t.nrows());
            Ok((order, nrows, hits.join("+")))
        })
        .await
        .map_err(|e| e.to_string())??;
    eprintln!(
        "[voyager] table_view hdu {hdu} → {nrows} rows in {:.1} ms (cols: {})",
        t0.elapsed().as_secs_f64() * 1e3,
        if hits.is_empty() { "none" } else { &hits },
    );

    *state.table_view.lock().unwrap() = Some(TableView { path: path2, hdu, order });
    Ok(ViewResult { nrows })
}

#[derive(Serialize)]
struct TablePage {
    rows: Vec<Vec<table::Cell>>,
}

/// A window of table rows (`start`..start+count`) mapped through the cached
/// view. If no matching view is cached, the identity order is used.
#[tauri::command]
fn table_rows(
    path: String,
    hdu: usize,
    start: u64,
    count: u64,
    state: State<'_, AppState>,
) -> Result<TablePage, String> {
    let handle = resolve_table(&state, &path, hdu)?;
    let t = handle.open()?;
    let guard = state.table_view.lock().unwrap();
    let view = guard.as_ref().filter(|v| v.path == path && v.hdu == hdu);
    let order = view.and_then(|v| v.order.as_deref());
    let rows = t.page(order, start, count);
    Ok(TablePage { rows })
}

#[derive(Serialize)]
struct ViewPos {
    /// The native row's position in the currently cached sort/filter view, or
    /// `None` if it isn't present there (e.g. filtered out).
    pos: Option<u64>,
}

/// Map a native table row index to its position in the currently cached
/// sort/filter view (see `table_view`), without disturbing that view. Lets
/// the image→row reverse link scroll/highlight the right row while keeping
/// the user's current sort/filter, instead of resetting to identity order.
#[tauri::command]
fn table_view_pos(
    path: String,
    hdu: usize,
    native_row: u64,
    state: State<'_, AppState>,
) -> Result<ViewPos, String> {
    let guard = state.table_view.lock().unwrap();
    let view = guard.as_ref().filter(|v| v.path == path && v.hdu == hdu);
    let pos = match view.map(|v| &v.order) {
        None | Some(None) => Some(native_row), // no cached view, or cached identity view
        Some(Some(order)) => order.iter().position(|&r| r == native_row).map(|p| p as u64),
    };
    Ok(ViewPos { pos })
}

/// Read whole numeric columns as f64 arrays (Null/non-numeric → NaN), in
/// native row order. Used by the cross-file catalog overlay to bulk-project a
/// catalog's RA/Dec columns onto an image frame. Off-thread: touches every row.
#[tauri::command]
async fn table_columns_f64(
    path: String,
    hdu: usize,
    cols: Vec<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<Vec<f64>>, String> {
    let handle = resolve_table(&state, &path, hdu)?;
    let t0 = Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Vec<f64>>, String> {
        let t = handle.open()?;
        Ok(cols.iter().map(|&c| t.column_f64(c)).collect())
    })
    .await
    .map_err(|e| e.to_string())??;
    eprintln!(
        "[voyager] table_columns_f64 hdu {hdu} × {} cols in {:.1} ms",
        out.len(),
        t0.elapsed().as_secs_f64() * 1e3
    );
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct XmatchSummary {
    /// Synthetic path addressing the result in every table command.
    path: String,
    name: String,
    /// Rows in the result (matched pairs, plus unmatched A rows for all1).
    nrows: u64,
    matched: u64,
    total_a: u64,
    skipped_a: u64,
    skipped_b: u64,
    median_sep_arcsec: Option<f64>,
    columns: Vec<table::Column>,
}

/// Crossmatch two open catalogs by sky position (issue #10 mode 1): Best
/// match within `radius_arcsec`, joined as `1and2` (matched pairs only) or
/// `all1` (every A row, unmatched right sides null). The result is a derived
/// table addressed by the returned synthetic path; all table commands serve
/// it. Off-thread: reads two whole position columns per side + builds the
/// k-d tree.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn xmatch_tables(
    path_a: String,
    hdu_a: usize,
    ra_col_a: usize,
    dec_col_a: usize,
    path_b: String,
    hdu_b: usize,
    ra_col_b: usize,
    dec_col_b: usize,
    radius_arcsec: f64,
    join: String,
    state: State<'_, AppState>,
) -> Result<XmatchSummary, String> {
    if path_a.starts_with(DERIVED_SCHEME) || path_b.starts_with(DERIVED_SCHEME) {
        return Err("crossmatching a derived table isn't supported yet — export it first".into());
    }
    if !(radius_arcsec.is_finite() && radius_arcsec > 0.0) {
        return Err("match radius must be a positive number of arcsec".into());
    }
    let all1 = match join.as_str() {
        "1and2" => false,
        "all1" => true,
        other => return Err(format!("unknown join type {other:?} (use 1and2 or all1)")),
    };
    let file_a = lookup(&state, &path_a)?;
    let file_b = lookup(&state, &path_b)?;
    // Pin the parents for the DerivedDef (the closure consumes the others).
    let (parent_a, parent_b) = (file_a.clone(), file_b.clone());
    let cache = state.col_cache.clone();

    let t0 = Instant::now();
    let (rows, matched, total_a, skipped_a, skipped_b, median) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let ta = table::Table::open(&file_a, hdu_a)?;
            let tb = table::Table::open(&file_b, hdu_b)?;
            // Positions through the column cache: warm for later sorts and
            // overlays, and re-runs with a different radius are instant.
            let fetch = |t: &table::Table, path: &str, hdu: usize, col: usize| -> Vec<f64> {
                let key = (path.to_string(), hdu, col);
                let cells = match cache.lock().unwrap().get(&key) {
                    Some(c) => c,
                    None => {
                        let c = Arc::new(t.extract_column(col));
                        cache.lock().unwrap().insert(key, c.clone());
                        c
                    }
                };
                cells.iter().map(|c| c.as_f64()).collect()
            };
            let ra_a = fetch(&ta, &path_a, hdu_a, ra_col_a);
            let dec_a = fetch(&ta, &path_a, hdu_a, dec_col_a);
            let ra_b = fetch(&tb, &path_b, hdu_b, ra_col_b);
            let dec_b = fetch(&tb, &path_b, hdu_b, dec_col_b);

            let result = xmatch::crossmatch(
                &ra_a,
                &dec_a,
                &ra_b,
                &dec_b,
                radius_arcsec / 3600.0,
                xmatch::MatchMode::Best,
            );
            let matched = result.pairs.len() as u64;
            let mut seps: Vec<f64> = result.pairs.iter().map(|p| p.sep_deg).collect();
            seps.sort_by(f64::total_cmp);
            let median = (!seps.is_empty()).then(|| seps[seps.len() / 2] * 3600.0);

            let rows: Vec<table::join::JoinRow> = if all1 {
                // Every A row in native order; Best gives ≤1 pair per A row.
                let mut by_a: Vec<Option<(u64, f64)>> = vec![None; ta.nrows as usize];
                for p in &result.pairs {
                    by_a[p.a as usize] = Some((p.b, p.sep_deg));
                }
                (0..ta.nrows)
                    .map(|a| match by_a[a as usize] {
                        Some((b, s)) => table::join::JoinRow { a, b: Some(b), sep_deg: Some(s) },
                        None => table::join::JoinRow { a, b: None, sep_deg: None },
                    })
                    .collect()
            } else {
                result
                    .pairs
                    .iter()
                    .map(|p| table::join::JoinRow { a: p.a, b: Some(p.b), sep_deg: Some(p.sep_deg) })
                    .collect()
            };
            Ok((rows, matched, ta.nrows, result.skipped_a as u64, result.skipped_b as u64, median))
        })
        .await
        .map_err(|e| e.to_string())??;

    let seq = state
        .derived_seq
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        + 1;
    let path = format!("{DERIVED_SCHEME}{seq}");
    let name = format!("XMATCH_{seq}");
    let def = Arc::new(DerivedDef {
        name: name.clone(),
        left: (parent_a, hdu_a),
        right: (parent_b, hdu_b),
        rows,
    });
    let nrows = def.rows.len() as u64;
    let columns = TableHandle::Derived(def.clone()).open()?.columns().to_vec();
    state.derived.lock().unwrap().insert(path.clone(), def);
    eprintln!(
        "[voyager] xmatch {} rows ({} matched of {}) in {:.1} ms → {}",
        nrows,
        matched,
        total_a,
        t0.elapsed().as_secs_f64() * 1e3,
        path
    );
    Ok(XmatchSummary {
        path,
        name,
        nrows,
        matched,
        total_a,
        skipped_a,
        skipped_b,
        median_sep_arcsec: median,
        columns,
    })
}

/// Export a table — real or derived, mapped through the currently cached
/// sort/filter view when `use_view` — as a standalone FITS BINTABLE.
#[tauri::command]
async fn export_table(
    path: String,
    hdu: usize,
    out_path: String,
    use_view: bool,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let handle = resolve_table(&state, &path, hdu)?;
    let extname = match &handle {
        TableHandle::Derived(d) => Some(d.name.clone()),
        TableHandle::Fits(f, h) => f.hdu(*h).ok().and_then(|i| i.name.clone()),
    };
    let view: Option<Vec<u64>> = if use_view {
        let guard = state.table_view.lock().unwrap();
        guard
            .as_ref()
            .filter(|v| v.path == path && v.hdu == hdu)
            .and_then(|v| v.order.clone())
    } else {
        None
    };

    let t0 = Instant::now();
    let out2 = out_path.clone();
    let written = tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let out = std::path::Path::new(&out_path);
        match handle.open()? {
            OpenTable::Fits(t) => table::write::export_view(&t, view.as_deref(), extname.as_deref(), out),
            OpenTable::Joined(j) => j.export(view.as_deref(), extname.as_deref(), out),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    eprintln!(
        "[voyager] export_table → {} ({} rows in {:.1} ms)",
        out2,
        written,
        t0.elapsed().as_secs_f64() * 1e3
    );
    Ok(written)
}

#[derive(Serialize)]
struct HeaderCard {
    key: String,
    value: Option<fits::Value>,
    comment: Option<String>,
    raw: String,
}

#[tauri::command]
fn get_header(path: String, hdu: usize, state: State<'_, AppState>) -> Result<Vec<HeaderCard>, String> {
    if path.starts_with(DERIVED_SCHEME) {
        return derived_header(&state, &path);
    }
    let files = state.files.lock().unwrap();
    let file = files.get(&path).ok_or("file not open")?;
    let info = file.hdu(hdu).map_err(|e| e.to_string())?;
    Ok(info
        .header
        .cards
        .iter()
        .map(|c| HeaderCard {
            key: c.key.clone(),
            value: c.value.clone(),
            comment: c.comment.clone(),
            raw: c.raw.clone(),
        })
        .collect())
}

/// Synthesized header cards for a derived (crossmatch) table — the essential
/// BINTABLE-shaped facts plus provenance, so the header tab shows something
/// truthful rather than erroring.
fn derived_header(state: &State<'_, AppState>, path: &str) -> Result<Vec<HeaderCard>, String> {
    let handle = resolve_table(state, path, 0)?;
    let TableHandle::Derived(def) = &handle else {
        return Err("not a derived table".to_string());
    };
    let t = handle.open()?;
    let mut cards: Vec<HeaderCard> = Vec::new();
    let mut push = |key: &str, value: fits::Value, comment: &str| {
        cards.push(HeaderCard {
            key: key.to_string(),
            value: Some(value),
            comment: (!comment.is_empty()).then(|| comment.to_string()),
            raw: String::new(),
        });
    };
    use fits::Value as V;
    push("XTENSION", V::Str("BINTABLE".into()), "derived (crossmatch) table");
    push("EXTNAME", V::Str(def.name.clone()), "");
    push("NAXIS2", V::Int(t.nrows() as i64), "number of rows");
    push("TFIELDS", V::Int(t.columns().len() as i64), "");
    push(
        "XMATCHA",
        V::Str(format!("{}[{}]", def.left.0.path.display(), def.left.1)),
        "left input table",
    );
    push(
        "XMATCHB",
        V::Str(format!("{}[{}]", def.right.0.path.display(), def.right.1)),
        "right input table",
    );
    for (i, c) in t.columns().iter().enumerate() {
        let j = i + 1;
        push(&format!("TTYPE{j}"), V::Str(c.name.clone()), "");
        push(&format!("TFORM{j}"), V::Str(c.tform.clone()), "");
        if let Some(u) = &c.unit {
            push(&format!("TUNIT{j}"), V::Str(u.clone()), "");
        }
    }
    Ok(cards)
}

#[tauri::command]
fn close_fits(path: String, state: State<'_, AppState>) {
    state.files.lock().unwrap().remove(&path);
    state.derived.lock().unwrap().remove(&path);
    state.col_cache.lock().unwrap().purge_path(&path);
}

/// Frontend calls this once on startup to collect files that arrived via
/// double-click/argv before its event listener existed.
#[tauri::command]
fn take_pending_opens(state: State<'_, AppState>) -> Vec<String> {
    std::mem::take(&mut *state.pending_opens.lock().unwrap())
}

/// Paths currently open in backend state. Lets a reloaded frontend (vite
/// hot-reload in dev, or a future window respawn) recover its session.
#[tauri::command]
fn list_open_files(state: State<'_, AppState>) -> Vec<String> {
    state.files.lock().unwrap().keys().cloned().collect()
}

fn looks_like_fits(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".fits", ".fit", ".fts", ".fits.gz", ".fits.fz"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

fn dispatch_open(app: &tauri::AppHandle, path: String) {
    // Emit for a live frontend; also queue in case it isn't listening yet.
    // The frontend drains the queue exactly once and dedupes.
    let state = app.state::<AppState>();
    state.pending_opens.lock().unwrap().push(path.clone());
    let _ = app.emit("voyager://open-request", path);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_fits,
            get_header,
            get_tile,
            get_scale_limits,
            get_readout,
            resolve_coord,
            get_wcs,
            get_histogram,
            load_region_file,
            save_pixel_regions,
            table_columns,
            table_view,
            table_rows,
            table_view_pos,
            table_columns_f64,
            xmatch_tables,
            export_table,
            parse_coord,
            close_fits,
            take_pending_opens,
            list_open_files
        ])
        .setup(|app| {
            // Files passed on the command line (dev workflow / Linux later).
            for arg in std::env::args().skip(1) {
                if looks_like_fits(&arg) {
                    let abs = std::fs::canonicalize(&arg)
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or(arg);
                    dispatch_open(app.handle(), abs);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS delivers double-clicked files as Apple Events, surfaced
            // by Tauri as RunEvent::Opened (both at launch and while running).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        dispatch_open(app, path.to_string_lossy().into_owned());
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
