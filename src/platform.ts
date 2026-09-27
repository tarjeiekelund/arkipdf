// Tynt lag over Tauri, med nettleser-reserve slik at grensesnittet kan
// utvikles og testes med `npm run dev` uten Windows.
import { invoke } from "@tauri-apps/api/core";
import * as dialog from "@tauri-apps/plugin-dialog";
import { availableMonitors, currentMonitor, getCurrentWindow, type Monitor } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";

export const isTauri = "__TAURI_INTERNALS__" in window;

/** En fil vi har åpnet: full sti i Tauri, bare navnet i nettleseren. */
export interface OpenedFile {
  path: string;
  name: string;
  bytes: Uint8Array;
}

const pdfFilter = [{ name: "PDF-dokumenter", extensions: ["pdf"] }];
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
const openFilter = [
  { name: "PDF og bilder", extensions: ["pdf", ...IMAGE_EXTENSIONS] },
  { name: "PDF-dokumenter", extensions: ["pdf"] },
  { name: "Bilder", extensions: IMAGE_EXTENSIONS },
];
/** Filer ArkiPDF kan åpne: PDF, og bilder som gjøres om til PDF. */
const openable = (name: string) => /\.(pdf|jpe?g|png|webp|gif|bmp)$/i.test(name);

// Nettleserreserve: filer valgt via <input> huskes på «sti» (= navn).
const browserFiles = new Map<string, Uint8Array>();

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(0, i) : "";
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function pickBrowserFiles(multiple: boolean, images = false): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = images ? `application/pdf,.pdf,${IMAGE_EXTENSIONS.map((e) => `.${e}`).join(",")}` : "application/pdf,.pdf";
    input.multiple = multiple;
    input.onchange = async () => {
      const paths: string[] = [];
      for (const f of Array.from(input.files ?? [])) {
        browserFiles.set(f.name, new Uint8Array(await f.arrayBuffer()));
        paths.push(f.name);
      }
      resolve(paths);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function pickPdfs(multiple: boolean): Promise<string[]> {
  if (!isTauri) return pickBrowserFiles(multiple);
  const res = await dialog.open({ multiple, directory: false, filters: pdfFilter, title: multiple ? "Velg PDF-filer" : "Åpne PDF" });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

/** Velg PDF-er eller bilder (bilder gjøres om til PDF). */
export async function pickDocuments(multiple: boolean): Promise<string[]> {
  if (!isTauri) return pickBrowserFiles(multiple, true);
  const res = await dialog.open({ multiple, directory: false, filters: openFilter, title: multiple ? "Velg PDF-er eller bilder" : "Åpne PDF eller bilde" });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

export async function pickSavePath(defaultPath: string, title = "Lagre som"): Promise<string | null> {
  if (!isTauri) return baseName(defaultPath);
  return dialog.save({ defaultPath, filters: pdfFilter, title });
}

export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  if (!isTauri) return "";
  const res = await dialog.open({ directory: true, multiple: false, title, defaultPath });
  return typeof res === "string" ? res : null;
}

export async function readFile(path: string): Promise<Uint8Array> {
  if (!isTauri) {
    const b = browserFiles.get(path);
    if (!b) throw new Error(`Fant ikke ${path}`);
    return b;
  }
  const buf = await invoke<ArrayBuffer>("read_file", { path });
  return new Uint8Array(buf);
}

export async function writeFile(path: string, bytes: Uint8Array): Promise<void> {
  if (!isTauri) {
    browserFiles.set(path, bytes);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart]));
    a.download = baseName(path);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    return;
  }
  await invoke("write_file", bytes, { headers: { path: encodeURIComponent(path) } });
}

export async function openFile(path: string): Promise<OpenedFile> {
  return { path, name: baseName(path), bytes: await readFile(path) };
}

/**
 * PDF-ene programmet ble startet med (dobbeltklikk, «Åpne med», eller flere
 * filer via «Send til»). `merge` er satt når ArkiPDF ble startet for å slå sammen.
 */
export async function startupFiles(): Promise<{ files: string[]; merge: boolean }> {
  if (!isTauri) return { files: [], merge: false };
  const [merge, files] = await invoke<[boolean, string[]]>("startup_files");
  return { files, merge };
}

/**
 * Filer som åpnes mens ArkiPDF allerede kjører (dobbeltklikk, «Send til»):
 * den nye oppstarten sender dem hit i stedet for å åpne et nytt vindu.
 */
export function onLaunchFiles(handler: (launch: { files: string[]; merge: boolean }) => void): void {
  if (!isTauri) return;
  void listen<[boolean, string[]]>("open-files", (e) => handler({ merge: e.payload[0], files: e.payload[1] }));
}

/** `confirm` avgjør om vinduet får lukkes (f.eks. når noe ikke er lagret). */
export function onCloseRequested(confirm: () => Promise<boolean>): void {
  if (!isTauri) return;
  void getCurrentWindow().onCloseRequested(async (e) => {
    if (!(await confirm())) e.preventDefault();
  });
}

export async function setTitle(title: string): Promise<void> {
  document.title = title;
  if (isTauri) await getCurrentWindow().setTitle(title);
}

export async function setFullscreen(on: boolean): Promise<void> {
  if (isTauri) {
    await getCurrentWindow().setFullscreen(on);
    return;
  }
  if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen().catch(() => {});
  if (!on && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
}

/** Åpner en nettadresse i standardnettleseren. */
export async function openUrl(url: string): Promise<void> {
  if (isTauri) await tauriOpenUrl(url);
  else window.open(url, "_blank", "noopener");
}

export interface ScreenInfo {
  /** Stabil nøkkel for å huske valget. */
  id: string;
  label: string;
  current: boolean;
}

function monitorId(m: Monitor): string {
  return `${m.name ?? "skjerm"}@${m.position.x},${m.position.y}`;
}

/** Skjermene som er koblet til (tom liste i nettleseren). */
export async function listScreens(): Promise<ScreenInfo[]> {
  if (!isTauri) return [];
  const [all, cur] = await Promise.all([availableMonitors(), currentMonitor()]);
  const curId = cur ? monitorId(cur) : "";
  return all.map((m, i) => ({
    id: monitorId(m),
    label: `Skjerm ${i + 1} (${m.size.width}×${m.size.height})`,
    current: monitorId(m) === curId,
  }));
}

/**
 * Flytter vinduet til valgt skjerm og går i fullskjerm. Returnerer en
 * funksjon som setter vinduet tilbake slik det var.
 */
export async function enterPresentationScreen(screenId: string | null): Promise<() => Promise<void>> {
  if (!isTauri) {
    const was = !!document.fullscreenElement;
    if (!was) await document.documentElement.requestFullscreen().catch(() => {});
    return async () => {
      if (!was && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    };
  }
  const win = getCurrentWindow();
  const wasFullscreen = await win.isFullscreen();
  if (wasFullscreen) return async () => {};

  const monitors = await availableMonitors();
  const target = screenId ? monitors.find((m) => monitorId(m) === screenId) : null;
  const cur = await currentMonitor();
  if (!target || (cur && monitorId(cur) === monitorId(target))) {
    await win.setFullscreen(true);
    return async () => {
      await win.setFullscreen(false);
    };
  }

  // Husk plassering og størrelse, flytt til den andre skjermen og fyll den.
  const [pos, size, maximized] = await Promise.all([win.outerPosition(), win.outerSize(), win.isMaximized()]);
  if (maximized) await win.unmaximize();
  await win.setPosition(new PhysicalPosition(target.position.x + 40, target.position.y + 40));
  await win.setFullscreen(true);
  return async () => {
    await win.setFullscreen(false);
    await win.setPosition(new PhysicalPosition(pos.x, pos.y));
    await win.setSize(new PhysicalSize(size.width, size.height));
    if (maximized) await win.maximize();
  };
}

export async function isFullscreen(): Promise<boolean> {
  if (isTauri) return getCurrentWindow().isFullscreen();
  return !!document.fullscreenElement;
}

export async function confirmDialog(message: string, title = "ArkiPDF"): Promise<boolean> {
  if (!isTauri) return window.confirm(message);
  return dialog.ask(message, { title, kind: "warning", okLabel: "Ja", cancelLabel: "Nei" });
}

/** Filer dratt inn i vinduet. I nettleseren håndteres dette via DOM-hendelser. */
export function onFilesDropped(handler: (paths: string[]) => void, setHover: (on: boolean) => void): void {
  if (isTauri) {
    void getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setHover(true);
      else if (p.type === "leave") setHover(false);
      else if (p.type === "drop") {
        setHover(false);
        const pdfs = p.paths.filter(openable);
        if (pdfs.length) handler(pdfs);
      }
    });
    return;
  }
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      setHover(true);
    }
  });
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) setHover(false);
  });
  window.addEventListener("drop", async (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    setHover(false);
    const paths: string[] = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      if (!openable(f.name)) continue;
      browserFiles.set(f.name, new Uint8Array(await f.arrayBuffer()));
      paths.push(f.name);
    }
    if (paths.length) handler(paths);
  });
}
