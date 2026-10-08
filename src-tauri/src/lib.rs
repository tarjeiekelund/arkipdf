use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

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

/// Leser en fontfil fra Windows' fontmapper (for redigering av tekst med samme
/// font som i PDF-en). Bare filnavn godtas, ikke stier.
#[tauri::command]
fn read_font(file: String) -> Result<Response, String> {
    let valid = !file.is_empty()
        && !file.contains(['/', '\\', ':'])
        && !file.contains("..")
        && [".ttf", ".otf"].iter().any(|e| file.to_lowercase().ends_with(e));
    if !valid {
        return Err("Ugyldig fontnavn".into());
    }
    let mut dirs = Vec::new();
    if let Ok(w) = std::env::var("WINDIR") {
        dirs.push(PathBuf::from(w).join("Fonts"));
    }
    if let Ok(l) = std::env::var("LOCALAPPDATA") {
        dirs.push(PathBuf::from(l).join("Microsoft").join("Windows").join("Fonts"));
    }
    for d in dirs {
        if let Ok(bytes) = fs::read(d.join(&file)) {
            return Ok(Response::new(bytes));
        }
    }
    Err(format!("Fant ikke {file}"))
}

/// Gjør et Word-, Excel- eller PowerPoint-dokument om til PDF med Office som
/// er installert (i bakgrunnen, uten vindu), eller LibreOffice som reserve.
#[tauri::command]
async fn convert_office(path: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || office::to_pdf(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
        .map(Response::new)
}

/// PDF-ene i en kommandolinje (uten programnavnet) fra dobbeltklikk, «Åpne
/// med» eller flere markerte filer via «Send til». Første verdi er `true`
/// når ArkiPDF ble startet med `--merge` for å slå sammen.
fn launch_files(args: &[String]) -> (bool, Vec<String>) {
    let merge = args.iter().any(|a| a == "--merge");
    let files = args
        .iter()
        .filter(|a| !a.starts_with('-') && office::openable(a))
        .cloned()
        .collect();
    (merge, files)
}

/// Vinduene: filene hvert nytt vindu skal åpne, og hvilket vindu som sist
/// hadde fokus (dit går filer som åpnes mens ArkiPDF kjører).
#[derive(Default)]
struct Windows {
    pending: Mutex<HashMap<String, (bool, Vec<String>)>>,
    focused: Mutex<String>,
    count: AtomicUsize,
}

/// Filene vinduet skal åpne når det starter (bare første gang det spør).
#[tauri::command]
fn startup_files(window: WebviewWindow, state: tauri::State<'_, Windows>) -> (bool, Vec<String>) {
    state.pending.lock().unwrap().remove(window.label()).unwrap_or_default()
}

/// Åpner filene i et nytt ArkiPDF-vindu i samme prosess.
fn new_window(app: &AppHandle, launch: (bool, Vec<String>)) -> tauri::Result<()> {
    let state = app.state::<Windows>();
    let label = format!("vindu-{}", state.count.fetch_add(1, Ordering::Relaxed) + 1);
    state.pending.lock().unwrap().insert(label.clone(), launch);
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("ArkiPDF")
        .inner_size(1200.0, 850.0)
        .min_inner_size(640.0, 420.0)
        .build();
    if built.is_err() {
        state.pending.lock().unwrap().remove(&label);
    }
    built.map(|_| ())
}

/// Høyreklikk på en fane → «Åpne i nytt vindu».
#[tauri::command]
async fn open_window(app: AppHandle, files: Vec<String>) -> Result<(), String> {
    new_window(&app, (false, files)).map_err(|e| e.to_string())
}

/// Et nytt oppstart av ArkiPDF mens det allerede kjører: med `--new-window`
/// («Åpne i nytt ArkiPDF-vindu» i Utforsker) får filene et eget vindu,
/// ellers åpnes de i faner i vinduet som sist hadde fokus.
fn relaunched(app: &AppHandle, argv: Vec<String>) {
    let args = &argv[argv.len().min(1)..];
    let launch = launch_files(args);
    if args.iter().any(|a| a == "--new-window") {
        // Vinduer kan ikke lages direkte herfra i Windows (vranglås), så det gjøres i bakgrunnen.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = new_window(&app, launch);
        });
        return;
    }
    let focused = app.state::<Windows>().focused.lock().unwrap().clone();
    let windows = app.webview_windows();
    let Some(w) = windows.get(&focused).or_else(|| windows.get("main")).or_else(|| windows.values().next()) else {
        return;
    };
    let _ = app.emit_to(EventTarget::webview_window(w.label()), "open-files", launch);
    let _ = w.unminimize();
    let _ = w.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let first: Vec<String> = std::env::args().skip(1).collect();
    let windows = Windows::default();
    windows.pending.lock().unwrap().insert("main".into(), launch_files(&first));
    *windows.focused.lock().unwrap() = "main".into();

    tauri::Builder::default()
        // Én prosess: åpnes ArkiPDF på nytt (f.eks. dobbeltklikk på en PDF),
        // sendes filene hit, som åpner dem i faner eller i et nytt vindu.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| relaunched(app, argv)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(windows)
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                *window.state::<Windows>().focused.lock().unwrap() = window.label().to_string();
            }
        })
        .invoke_handler(tauri::generate_handler![read_file, write_file, startup_files, open_window, read_font, convert_office])
        .run(tauri::generate_context!())
        .expect("ArkiPDF kunne ikke starte");
}

mod office {
    use std::path::Path;
    #[cfg(windows)]
    use std::path::PathBuf;
    #[cfg(windows)]
    use std::time::{Duration, Instant};

    /// Filer ArkiPDF kan åpne: PDF, bilder og Office-dokumenter.
    pub fn openable(name: &str) -> bool {
        let lower = name.to_lowercase();
        [
            ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".doc", ".docx", ".docm", ".rtf", ".odt", ".xls", ".xlsx", ".xlsm", ".ods",
            ".ppt", ".pptx", ".pptm", ".odp",
        ]
        .iter()
        .any(|e| lower.ends_with(e))
    }

    #[cfg(windows)]
    const WORD: &str = r#"
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject Word.Application
try {
  $app.Visible = $false
  $app.DisplayAlerts = 0
  $doc = $app.Documents.Open($env:ARKIPDF_IN, $false, $true, $false)
  try { $doc.ExportAsFixedFormat($env:ARKIPDF_OUT, 17) } finally { $doc.Close(0) }
} finally { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
"#;

    #[cfg(windows)]
    const EXCEL: &str = r#"
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject Excel.Application
try {
  $app.Visible = $false
  $app.DisplayAlerts = $false
  $wb = $app.Workbooks.Open($env:ARKIPDF_IN, 0, $true)
  try { $wb.ExportAsFixedFormat(0, $env:ARKIPDF_OUT) } finally { $wb.Close($false) }
} finally { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
"#;

    #[cfg(windows)]
    const POWERPOINT: &str = r#"
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject PowerPoint.Application
try {
  $p = $app.Presentations.Open($env:ARKIPDF_IN, -1, 0, 0)
  try { $p.SaveAs($env:ARKIPDF_OUT, 32) } finally { $p.Close() }
} finally { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
"#;

    #[cfg(windows)]
    fn run(mut cmd: std::process::Command, limit: Duration) -> Result<String, String> {
        use std::os::windows::process::CommandExt;
        use std::process::Stdio;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut child = cmd
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let start = Instant::now();
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                let mut err = String::new();
                if let Some(mut s) = child.stderr.take() {
                    use std::io::Read;
                    let _ = s.read_to_string(&mut err);
                }
                return if status.success() { Ok(err) } else { Err(err.trim().to_string()) };
            }
            // Venter programmet på et spørsmål (passord, beskyttet visning), gir vi opp.
            if start.elapsed() > limit {
                let _ = child.kill();
                return Err("Tok for lang tid (venter Office kanskje på et spørsmål?)".into());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    #[cfg(windows)]
    fn libreoffice() -> Option<PathBuf> {
        ["ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|v| std::env::var(v).ok())
            .map(|d| PathBuf::from(d).join("LibreOffice").join("program").join("soffice.exe"))
            .find(|p| p.exists())
    }

    #[cfg(windows)]
    pub fn to_pdf(input: &Path) -> Result<Vec<u8>, String> {
        use std::process::Command;
        let ext = input.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let script = match ext.as_str() {
            "doc" | "docx" | "docm" | "rtf" | "odt" => WORD,
            "xls" | "xlsx" | "xlsm" | "ods" => EXCEL,
            "ppt" | "pptx" | "pptm" | "odp" => POWERPOINT,
            _ => return Err("Ukjent filtype".into()),
        };
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("arkipdf-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = dir.join("resultat.pdf");
        let result = (|| {
            let mut ps = Command::new("powershell.exe");
            ps.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
                .env("ARKIPDF_IN", input)
                .env("ARKIPDF_OUT", &out);
            let office = run(ps, Duration::from_secs(180));
            if let Ok(bytes) = std::fs::read(&out) {
                return Ok(bytes);
            }
            // Reserve: LibreOffice, hvis det er installert.
            if let Some(soffice) = libreoffice() {
                let mut lo = Command::new(soffice);
                lo.args(["--headless", "--norestore", "--convert-to", "pdf", "--outdir"]).arg(&dir).arg(input);
                run(lo, Duration::from_secs(180))?;
                let stem = input.file_stem().map(|s| s.to_os_string()).unwrap_or_default();
                let mut name = stem;
                name.push(".pdf");
                return std::fs::read(dir.join(name)).map_err(|e| e.to_string());
            }
            Err(match office {
                Err(e) if !e.is_empty() => format!("Office kunne ikke gjøre om fila: {e}"),
                _ => "Fant verken Microsoft Office eller LibreOffice på PC-en.".to_string(),
            })
        })();
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    #[cfg(not(windows))]
    pub fn to_pdf(_input: &Path) -> Result<Vec<u8>, String> {
        Err("Omgjøring av Office-dokumenter krever Windows.".into())
    }
}
