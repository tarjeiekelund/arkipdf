use std::fs;
use std::path::PathBuf;

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};

/// Leser en fil og sender bytene rått til webvisningen (ingen JSON-omvei).
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Kunne ikke lese {path}: {e}"))
}

/// Skriver rå bytes til filen i `path`-headeren. Skriver først til en
/// midlertidig fil ved siden av og bytter den inn, så originalen aldri står
/// halvskrevet om noe går galt underveis.
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode_str(v).decode_utf8_lossy().into_owned())
        .ok_or("Mangler filsti")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Forventet rå bytes".into());
    };

    let target = PathBuf::from(&path);
    let mut tmp = target.clone().into_os_string();
    tmp.push(".blad-tmp");
    let tmp = PathBuf::from(tmp);

    fs::write(&tmp, bytes).map_err(|e| format!("Kunne ikke skrive {path}: {e}"))?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Kunne ikke lagre {path}: {e}")
    })
}

/// PDF-ene i en kommandolinje (uten programnavnet) fra dobbeltklikk, «Åpne
/// med» eller flere markerte filer via «Send til». Første verdi er `true`
/// når ArkiPDF ble startet med `--merge` for å slå sammen.
fn launch_files(args: impl Iterator<Item = String>) -> (bool, Vec<String>) {
    let args: Vec<String> = args.collect();
    let merge = args.iter().any(|a| a == "--merge");
    let files = args
        .into_iter()
        .filter(|a| !a.starts_with('-') && a.to_lowercase().ends_with(".pdf"))
        .collect();
    (merge, files)
}

/// Filene programmet ble startet med.
#[tauri::command]
fn startup_files() -> (bool, Vec<String>) {
    launch_files(std::env::args().skip(1))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Ett vindu: åpnes ArkiPDF på nytt (f.eks. dobbeltklikk på en PDF),
        // sendes filene til vinduet som er åpent, som åpner dem i faner.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let _ = app.emit("open-files", launch_files(argv.into_iter().skip(1)));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_file, write_file, startup_files])
        .run(tauri::generate_context!())
        .expect("ArkiPDF kunne ikke starte");
}
