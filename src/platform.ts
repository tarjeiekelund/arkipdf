// Tynt lag over Tauri, med nettleser-reserve slik at grensesnittet kan
// utvikles og testes med `npm run dev` uten Windows.
import { invoke } from "@tauri-apps/api/core";
import * as dialog from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export const isTauri = "__TAURI_INTERNALS__" in window;

/** En fil vi har åpnet: full sti i Tauri, bare navnet i nettleseren. */
export interface OpenedFile {
  path: string;
  name: string;
  bytes: Uint8Array;
}

const pdfFilter = [{ name: "PDF-dokumenter", extensions: ["pdf"] }];

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

function pickBrowserFiles(multiple: boolean): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
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

export async function startupFile(): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>("startup_file");
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

export async function isFullscreen(): Promise<boolean> {
  if (isTauri) return getCurrentWindow().isFullscreen();
  return !!document.fullscreenElement;
}

export async function confirmDialog(message: string, title = "Blad"): Promise<boolean> {
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
        const pdfs = p.paths.filter((x) => x.toLowerCase().endsWith(".pdf"));
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
      if (!f.name.toLowerCase().endsWith(".pdf")) continue;
      browserFiles.set(f.name, new Uint8Array(await f.arrayBuffer()));
      paths.push(f.name);
    }
    if (paths.length) handler(paths);
  });
}
