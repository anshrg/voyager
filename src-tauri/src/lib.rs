pub mod fits;
pub mod regions;
pub mod table;
pub mod tiles;
pub mod wcs;

use fits::FitsFile;
use serde::Serialize;
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
#[tauri::command]
fn table_columns(
    path: String,
    hdu: usize,
    state: State<'_, AppState>,
) -> Result<Vec<table::Column>, String> {
    let file = lookup(&state, &path)?;
    let t = table::Table::open(&file, hdu)?;
    Ok(t.columns)
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
    let file = lookup(&state, &path)?;
    let sort = sort.map(|s| table::SortSpec { col: s.col, desc: s.desc });
    let filter = filter
        .filter(|f| !f.query.trim().is_empty())
        .map(|f| table::FilterSpec { col: f.col, query: f.query });

    let path2 = path.clone();
    let t0 = Instant::now();
    let (order, nrows) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(Option<Vec<u64>>, u64), String> {
            let t = table::Table::open(&file, hdu)?;
            let order = t.build_view(sort, filter);
            let nrows = order.as_ref().map(|v| v.len() as u64).unwrap_or(t.nrows);
            Ok((order, nrows))
        })
        .await
        .map_err(|e| e.to_string())??;
    eprintln!(
        "[voyager] table_view hdu {hdu} → {nrows} rows in {:.1} ms",
        t0.elapsed().as_secs_f64() * 1e3
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
    let file = lookup(&state, &path)?;
    let t = table::Table::open(&file, hdu)?;
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
    let file = lookup(&state, &path)?;
    let t0 = Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Vec<f64>>, String> {
        let t = table::Table::open(&file, hdu)?;
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
struct HeaderCard {
    key: String,
    value: Option<fits::Value>,
    comment: Option<String>,
    raw: String,
}

#[tauri::command]
fn get_header(path: String, hdu: usize, state: State<'_, AppState>) -> Result<Vec<HeaderCard>, String> {
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

#[tauri::command]
fn close_fits(path: String, state: State<'_, AppState>) {
    state.files.lock().unwrap().remove(&path);
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
