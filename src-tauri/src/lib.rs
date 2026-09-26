use std::fs;
use std::path::PathBuf;

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};

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

/// Filen programmet ble startet med (dobbeltklikk på en PDF, «Åpne med»).
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && a.to_lowercase().ends_with(".pdf"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_file, write_file, startup_file])
        .run(tauri::generate_context!())
        .expect("Blad kunne ikke starte");
}
