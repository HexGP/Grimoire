use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

// ── Data model ────────────────────────────────────────────────────────────────
// variants is a fully open map: any generator key → any JSON value.
// This means we never need to touch Rust when adding new generators.
// The JS side owns the variant schema.

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Prompt {
    id: String,
    #[serde(default = "default_category")]
    category: String,
    title: String,
    #[serde(alias = "text", default)]
    master_prompt: String,
    #[serde(default)]
    supported_generators: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
    /// Open map: generatorKey → { text?, positive?, negative?, status, settings }
    #[serde(default)]
    variants: HashMap<String, serde_json::Value>,
    /// Per-generator default settings: { midjourney: {version,ar,style}, stable_diffusion: {model}, ... }
    #[serde(default)]
    generator_settings: HashMap<String, serde_json::Value>,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default)]
    notes: String,
    created_at: u64,
    updated_at: u64,
}

fn default_category() -> String {
    "image".to_string()
}

// ── Storage ───────────────────────────────────────────────────────────────────

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("no app data dir");
    fs::create_dir_all(&dir).ok();
    dir
}

fn data_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("prompts.json")
}

fn backup_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("prompts-backup.json")
}

/// Load prompts as raw JSON. Returns Ok(empty array) if the file does not exist yet,
/// or Err(msg) on read/parse failure. We intentionally avoid silently swallowing
/// parse errors here — losing the user's data is worse than showing a clear error.
#[tauri::command]
fn load_prompts(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = data_path(&app);
    if !path.exists() {
        return Ok(serde_json::Value::Array(vec![]));
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read prompts file at {}: {}", path.display(), e))?;
    if content.trim().is_empty() {
        return Ok(serde_json::Value::Array(vec![]));
    }
    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse prompts file: {}", e))?;
    if !parsed.is_array() {
        return Err("Prompts file is not a JSON array".to_string());
    }
    Ok(parsed)
}

/// Save prompts to disk. Writes atomically via a `.tmp` file + rename so a crash
/// mid-write cannot corrupt the canonical file. Also keeps the previous good
/// copy at `prompts.json.bak` for one-step recovery if a future save goes wrong.
#[tauri::command]
fn save_prompts(app: tauri::AppHandle, prompts: serde_json::Value) -> Result<(), String> {
    if !prompts.is_array() {
        return Err("Refusing to save: prompts payload is not an array".to_string());
    }
    let path = data_path(&app);
    let tmp_path = path.with_extension("json.tmp");
    let bak_path = backup_path(&app);

    let content = serde_json::to_string(&prompts).map_err(|e| e.to_string())?;
    fs::write(&tmp_path, &content).map_err(|e| format!("Write tmp failed: {}", e))?;

    // Rolling backup: before overwriting primary, copy previous good file to backup.
    // Single file — overwrites the previous backup each time.
    if path.exists() {
        let _ = fs::copy(&path, &bak_path);
    }
    fs::rename(&tmp_path, &path).map_err(|e| format!("Atomic rename failed: {}", e))?;
    Ok(())
}

/// Returns info about the rolling backup file if it exists, or null otherwise.
/// Used by the recovery flow to decide whether to offer "Restore from backup".
#[tauri::command]
fn backup_info(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let bak = backup_path(&app);
    if !bak.exists() { return None; }
    let meta = fs::metadata(&bak).ok()?;
    let modified_ms = meta.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(serde_json::json!({
        "path":  bak.to_string_lossy(),
        "size":  meta.len(),
        "modified": modified_ms,
    }))
}

/// Restore primary data from the rolling backup. Validates the backup first
/// (must be a JSON array) before clobbering the primary file.
#[tauri::command]
fn restore_from_backup(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let bak = backup_path(&app);
    if !bak.exists() {
        return Err("No backup file found".to_string());
    }
    let content = fs::read_to_string(&bak).map_err(|e| format!("Failed to read backup: {}", e))?;
    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Backup is corrupted: {}", e))?;
    if !parsed.is_array() {
        return Err("Backup is not a JSON array".to_string());
    }
    // Atomic-write-and-replace into the primary path.
    let path = data_path(&app);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &content).map_err(|e| format!("Failed to write restored data: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Atomic rename failed: {}", e))?;
    Ok(parsed)
}

/// Opens the data directory in the OS file browser.
#[tauri::command]
fn open_data_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = data_dir(&app);
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return the on-disk path of the canonical prompts file. Useful for debugging
/// and for the user to know where their data lives.
#[tauri::command]
fn get_data_path(app: tauri::AppHandle) -> String {
    data_path(&app).to_string_lossy().into_owned()
}

// ── Tag database ──────────────────────────────────────────────────────────────

struct TagDb(Mutex<Option<Vec<String>>>);

fn resolve_tags_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("danbooru-tags.txt");
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("danbooru-tags.txt")
}

fn load_tag_db(app: &tauri::AppHandle) -> Vec<String> {
    let content = fs::read_to_string(resolve_tags_path(app)).unwrap_or_default();
    content
        .lines()
        .filter_map(|line| line.split(',').next().map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

#[tauri::command]
fn read_prompts_file(path: String) -> Result<serde_json::Value, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {e}"))?;
    if !parsed.is_array() {
        return Err("Backup file must contain a JSON array of prompts".to_string());
    }
    Ok(parsed)
}

#[tauri::command]
fn write_prompts_file(path: String, prompts: serde_json::Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(&prompts).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_downloads_path(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .download_dir()
        .map_err(|e| e.to_string())?
        .to_str()
        .ok_or_else(|| "Invalid download path".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
fn search_tags(
    query: String,
    app: tauri::AppHandle,
    db: tauri::State<TagDb>,
) -> Vec<String> {
    let q = query.trim().to_lowercase().replace(' ', "_");
    if q.len() < 2 {
        return vec![];
    }
    let mut cache = db.0.lock().unwrap();
    if cache.is_none() {
        *cache = Some(load_tag_db(&app));
    }
    cache
        .as_ref()
        .unwrap()
        .iter()
        .filter(|tag| tag.contains(&q))
        .take(20)
        .cloned()
        .collect()
}

// ── System tray helpers ───────────────────────────────────────────────────────

/// Show + focus the main window. Safe to call even if the window is currently hidden.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Frontend-callable exit. The frontend should flush any pending autosave
/// BEFORE invoking this (it awaits `save_prompts`, then calls this).
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(TagDb(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![load_prompts, save_prompts, search_tags, read_prompts_file, write_prompts_file, get_downloads_path, get_data_path, backup_info, restore_from_backup, open_data_folder, quit_app])
        .on_window_event(|window, event| {
            // Close-to-tray: intercept the X click at the native level, prevent the
            // window from being destroyed, hide it instead. Quit only happens via
            // the tray menu "Quit" item (which calls quit_app() after save flushes).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    // Tell the frontend to flush any pending autosave. This is
                    // fire-and-forget — the window is already gone visually.
                    let _ = window.app_handle().emit("window-hidden-to-tray", ());
                }
            }
        })
        .setup(|app| {
            // Build the tray menu: Show Grimoire / Quit
            let show_item = MenuItem::with_id(app, "tray_show", "Show Grimoire", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Grimoire — click to open")
                .menu(&menu)
                .show_menu_on_left_click(false) // left-click = open window; right-click = menu
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray_show" => show_main_window(app),
                    "tray_quit" => {
                        // Ask the frontend to flush any pending autosave, then exit.
                        // The frontend listens for this event, awaits flushPersistNow(),
                        // and invokes the `quit_app` command. If the frontend is unresponsive
                        // for >1.5s, we exit anyway so the user never gets stuck.
                        let app_for_fallback = app.clone();
                        let _ = app.emit("tray-quit-requested", ());
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(1500));
                            app_for_fallback.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click on tray icon: show + focus the window.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
