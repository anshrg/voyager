pub mod fits;

use fits::FitsFile;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager, State};

/// Open files stay in state so their mmaps remain valid across commands.
#[derive(Default)]
struct AppState {
    files: Mutex<HashMap<String, FitsFile>>,
    /// Paths received (via file association or argv) before the frontend
    /// was ready to handle them.
    pending_opens: Mutex<Vec<String>>,
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
        "[ds10] open_fits {} — {} HDUs in {:.1} ms",
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
    state.files.lock().unwrap().insert(path, file);
    Ok(summary)
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
    let _ = app.emit("ds10://open-request", path);
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
            close_fits,
            take_pending_opens
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
