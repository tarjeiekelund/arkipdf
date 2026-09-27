use std::fs;
use std::path::{Path, PathBuf};

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
fn launch_files(args: impl Iterator<Item = String>) -> (bool, Vec<String>) {
    let args: Vec<String> = args.collect();
    let merge = args.iter().any(|a| a == "--merge");
    let files = args
        .into_iter()
        .filter(|a| !a.starts_with('-') && office::openable(a))
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
        .invoke_handler(tauri::generate_handler![read_file, write_file, startup_files, read_font, convert_office])
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
