import "./styles.css";
import { rearrangePages, type PageItem } from "./edit";
import { openExportDialog } from "./exportpng";
import { openMergeDialog } from "./merge";
import { Organizer } from "./organize";
import { loadPdf, pdfjs, ThumbCache, type PDFDocumentProxy } from "./pdf";
import {
  baseName,
  confirmDialog,
  isTauri,
  onFilesDropped,
  openFile,
  pickPdfs,
  pickSavePath,
  setTitle,
  startupFile,
  writeFile,
} from "./platform";
import { Presentation } from "./present";
import { busy, button, errorMessage, h, icon, modal, toast } from "./ui";
import { CSS_UNITS, Viewer, type ZoomMode } from "./viewer";

interface OpenDoc {
  path: string;
  name: string;
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  thumbs: ThumbCache;
}

let current: OpenDoc | null = null;
let organizer: Organizer | null = null;
let presentation: Presentation | null = null;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ikke kritisk */
    }
  },
};

// ---------- Oppsett av grensesnittet ----------

const viewer = new Viewer();
const app = document.getElementById("app")!;

const pageInput = h("input", { type: "text", class: "page-input", inputmode: "numeric", "aria-label": "Sidenummer", title: "Gå til side (Ctrl+G)" });
const pageTotal = h("span", { class: "page-total" });
const zoomLabel = h("span", { class: "zoom-label" }, "–");

const docButtons: HTMLButtonElement[] = [];
const docBtn = (b: HTMLButtonElement) => (docButtons.push(b), b);

// Sidenavigasjon og zoom vises bare når et dokument er åpent.
const viewControls = h(
  "span",
  { class: "view-controls" },
  docBtn(button("", "sidebar", () => toggleSidebar(), { title: "Vis/skjul miniatyrer (Ctrl+B)", className: "ghost" })),
  h("span", { class: "page-nav" }, pageInput, pageTotal),
  h("span", { class: "sep" }),
  docBtn(button("", "minus", () => viewer.zoomOut(), { title: "Zoom ut (Ctrl+−)", className: "ghost" })),
  zoomLabel,
  docBtn(button("", "plus", () => viewer.zoomIn(), { title: "Zoom inn (Ctrl++)", className: "ghost" })),
  docBtn(button("", "fitWidth", () => setZoom("width"), { title: "Tilpass bredde (Ctrl+3)", className: "ghost" })),
  docBtn(button("", "fitPage", () => setZoom("page"), { title: "Hel side (Ctrl+2)", className: "ghost" })),
  h("span", { class: "sep" }),
);

const toolbar = h(
  "header",
  { class: "toolbar" },
  button("Åpne", "open", () => void openDialog(), { title: "Åpne PDF (Ctrl+O)" }),
  button("Slå sammen", "merge", () => startMerge(), { title: "Slå sammen flere PDF-er (Ctrl+M)" }),
  docBtn(button("Sorter sider", "organize", () => startOrganize(), { title: "Endre rekkefølge, roter eller slett sider (Ctrl+K)" })),
  docBtn(button("Til PNG", "image", () => startExport(), { title: "Eksporter sider som PNG-bilder (Ctrl+E)" })),
  h("span", { class: "spacer" }),
  viewControls,
  docBtn(button("Presenter", "present", () => void startPresentation(), { title: "Fullskjerm-presentasjon (Ctrl+L)", primary: true })),
);

const sidebarList = h("div", { class: "thumb-list" });
const sidebar = h("aside", { class: "sidebar", "aria-label": "Miniatyrer" }, sidebarList);
const content = h("section", { class: "content" });
const dropOverlay = h("div", { class: "drop-overlay" }, h("div", {}, "Slipp PDF-en her"));
app.append(toolbar, h("main", {}, sidebar, content), dropOverlay);

function emptyState(): HTMLElement {
  const shortcuts: Array<[string, string]> = [
    ["Ctrl+O", "Åpne"],
    ["Ctrl+L", "Presenter i fullskjerm"],
    ["Ctrl+M", "Slå sammen PDF-er"],
    ["Ctrl+K", "Sorter sider"],
    ["Ctrl+E", "Eksporter til PNG"],
  ];
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty-icon", html: icon("file") }),
    h("h1", {}, "Blad"),
    h("p", { class: "muted" }, "Åpne en PDF, eller dra en fil inn i vinduet."),
    button("Åpne PDF…", "open", () => void openDialog(), { primary: true, className: "big" }),
    h("dl", { class: "shortcuts" }, ...shortcuts.flatMap(([k, v]) => [h("dt", {}, h("kbd", {}, k)), h("dd", {}, v)])),
  );
}

// ---------- Oppdatering av tilstand ----------

let sidebarVisible = store.get("sidebar") !== "0";

function toggleSidebar(): void {
  sidebarVisible = !sidebarVisible;
  store.set("sidebar", sidebarVisible ? "1" : "0");
  refresh();
}

function setZoom(mode: ZoomMode): void {
  viewer.setZoom(mode);
  store.set("zoom", typeof mode === "string" ? mode : "auto");
}

function refresh(): void {
  const hasDoc = !!current;
  for (const b of docButtons) b.disabled = !hasDoc || !!organizer;
  pageInput.disabled = !hasDoc || !!organizer;
  sidebar.hidden = !hasDoc || !sidebarVisible || !!organizer;
  viewControls.hidden = !hasDoc || !!organizer;
  if (hasDoc) {
    if (document.activeElement !== pageInput) pageInput.value = String(viewer.current + 1);
    pageTotal.textContent = `av ${viewer.pageCount}`;
    zoomLabel.textContent = `${viewer.zoomPercent} %`;
  } else {
    pageInput.value = "";
    pageTotal.textContent = "";
    zoomLabel.textContent = "–";
  }
  highlightThumb();
}

viewer.onChange = refresh;

pageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const n = parseInt(pageInput.value, 10);
    if (!Number.isNaN(n)) viewer.goToPage(n - 1);
    viewer.el.focus();
  } else if (e.key === "Escape") {
    pageInput.value = String(viewer.current + 1);
    viewer.el.focus();
  }
});
pageInput.addEventListener("focus", () => pageInput.select());
pageInput.addEventListener("blur", () => refresh());

// ---------- Miniatyrer i sidepanelet ----------

let thumbObserver: IntersectionObserver | null = null;
let thumbEls: HTMLElement[] = [];
let highlighted = -1;

function buildSidebar(): void {
  thumbObserver?.disconnect();
  thumbEls = [];
  highlighted = -1;
  sidebarList.replaceChildren();
  if (!current) return;
  const { doc, thumbs } = current;
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        thumbObserver!.unobserve(el);
        const i = Number(el.dataset.index);
        void thumbs.get(i).then((u) => (el.querySelector("img")!.src = u));
      }
    },
    { root: sidebar, rootMargin: "300px 0px" },
  );
  const frag = document.createDocumentFragment();
  for (let i = 0; i < doc.numPages; i++) {
    const item = h("button", { class: "thumb-item", "data-index": String(i), type: "button", title: `Side ${i + 1}` }, h("span", { class: "thumb-img" }, h("img", { alt: "" })), h("span", { class: "thumb-num" }, String(i + 1)));
    item.addEventListener("click", () => {
      viewer.goToPage(i);
      viewer.el.focus();
    });
    thumbEls.push(item);
    thumbObserver.observe(item);
    frag.append(item);
  }
  sidebarList.append(frag);
}

function highlightThumb(): void {
  const i = current ? viewer.current : -1;
  if (i === highlighted) return;
  thumbEls[highlighted]?.classList.remove("active");
  highlighted = i;
  const el = thumbEls[i];
  if (el) {
    el.classList.add("active");
    if (!sidebar.hidden) el.scrollIntoView({ block: "center" });
  }
}

// ---------- Åpne dokumenter ----------

async function askPassword(name: string, wrong: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h("input", { type: "password", "aria-label": "Passord" });
    const ok = () => {
      result = input.value;
      close();
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && ok());
    const body = h("div", { class: "form" }, h("p", {}, wrong ? "Feil passord. Prøv igjen:" : `«${name}» er passordbeskyttet.`), h("label", { class: "field" }, h("span", {}, "Passord"), input));
    const close = modal("Passord", body, [button("Avbryt", null, () => close()), button("Åpne", null, ok, { primary: true })], () => resolve(result));
  });
}

async function loadWithPassword(bytes: Uint8Array, name: string): Promise<PDFDocumentProxy | null> {
  let password: string | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      return await loadPdf(bytes, password);
    } catch (e) {
      if (!(e instanceof pdfjs.PasswordException)) throw e;
      const p = await askPassword(name, attempt > 0);
      if (p === null) return null;
      password = p;
    }
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (!organizer?.dirty) return true;
  return confirmDialog("Du har endringer i siderekkefølgen som ikke er lagret. Forkaste dem?");
}

async function openDialog(): Promise<void> {
  const [path] = await pickPdfs(false);
  if (path) await openPath(path);
}

async function openPath(path: string, startPage = 0, preloaded?: Uint8Array): Promise<void> {
  if (!(await confirmDiscard())) return;
  closeOrganizer();
  const loading = h("div", { class: "loading" }, h("div", { class: "spinner" }), `Åpner ${baseName(path)}…`);
  content.replaceChildren(loading);
  try {
    const file = preloaded ? { path, name: baseName(path), bytes: preloaded } : await openFile(path);
    const doc = await loadWithPassword(file.bytes, file.name);
    if (!doc) {
      showCurrent();
      return;
    }
    const old = current;
    current = { ...file, doc, thumbs: new ThumbCache(doc) };
    if (old) {
      old.thumbs.dispose();
      void old.doc.loadingTask.destroy();
    }
    await setTitle(`${file.name} – Blad`);
    showCurrent(startPage);
  } catch (e) {
    toast(`Kunne ikke åpne ${baseName(path)}: ${errorMessage(e)}`, "error");
    showCurrent();
  }
}

/** Viser gjeldende dokument (eller startsiden) i innholdsfeltet. */
function showCurrent(startPage = 0): void {
  if (!current) {
    content.replaceChildren(emptyState());
    refresh();
    return;
  }
  content.replaceChildren(viewer.el);
  if (viewer.document !== current.doc) {
    const z = store.get("zoom");
    viewer.setZoom(z === "width" || z === "page" ? z : "auto");
    void viewer.setDocument(current.doc, startPage).then(() => viewer.el.focus());
    buildSidebar();
  }
  refresh();
}

// ---------- Presentasjon ----------

async function startPresentation(): Promise<void> {
  if (!current || organizer) return;
  if (presentation?.active) return presentation.stop();
  presentation = new Presentation(current.doc);
  presentation.onExit = (page) => {
    viewer.goToPage(page);
    viewer.el.focus();
  };
  await presentation.start(viewer.current);
}

// ---------- Sorter sider ----------

function startOrganize(): void {
  if (!current || organizer) return;
  const doc = current;
  const save = async (items: PageItem[], target: string) => {
    const b = busy("Lagrer…");
    try {
      const out = await rearrangePages(doc.bytes, items, doc.name);
      await writeFile(target, out);
      toast(`Lagret ${baseName(target)}`, "success");
      organizer = null;
      await openPath(target, 0, out);
    } catch (e) {
      toast(`Kunne ikke lagre: ${errorMessage(e)}`, "error");
    } finally {
      b.done();
    }
  };
  organizer = new Organizer(doc.doc.numPages, doc.thumbs, {
    save: (items) => save(items, doc.path),
    saveAs: async (items) => {
      const target = await pickSavePath(doc.path.replace(/\.pdf$/i, " (sortert).pdf"));
      if (target) await save(items, target);
    },
    close: async () => {
      if (!(await confirmDiscard())) return;
      closeOrganizer();
      showCurrent();
    },
  });
  content.replaceChildren(organizer.el);
  refresh();
  (organizer.el.querySelector(".grid") as HTMLElement).focus();
}

function closeOrganizer(): void {
  organizer = null;
}

// ---------- Slå sammen og eksport ----------

function startMerge(): void {
  if (organizer) return;
  openMergeDialog(current && isTauri ? [current.path] : [], (path) => void openPath(path));
}

function startExport(): void {
  if (!current || organizer) return;
  openExportDialog(current.doc, current.path, viewer.current);
}

// ---------- Tastatur ----------

const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;

window.addEventListener("keydown", (e) => {
  if (presentation?.active || document.querySelector(".backdrop")) return;
  if (organizer) {
    if (organizer.handleKey(e)) e.preventDefault();
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  let handled = true;
  if (ctrl && k === "o") void openDialog();
  else if (ctrl && k === "m") startMerge();
  else if ((ctrl && k === "l") || e.key === "F5") void startPresentation();
  else if (!current) handled = false;
  else if (ctrl && k === "k") startOrganize();
  else if (ctrl && k === "e") startExport();
  else if (ctrl && k === "b") toggleSidebar();
  else if (ctrl && k === "g") pageInput.focus();
  else if (ctrl && (k === "+" || k === "=" || e.code === "NumpadAdd")) viewer.zoomIn();
  else if (ctrl && (k === "-" || e.code === "NumpadSubtract")) viewer.zoomOut();
  else if (ctrl && k === "0") setZoom("auto");
  else if (ctrl && k === "3") setZoom("width");
  else if (ctrl && k === "1") setZoom(CSS_UNITS);
  else if (ctrl && k === "2") setZoom("page");
  else if (typing(e.target) || ctrl || e.altKey) handled = false;
  else if (e.key === "Home") viewer.goToPage(0);
  else if (e.key === "End") viewer.goToPage(viewer.pageCount - 1);
  else if (e.key === "ArrowRight") viewer.goToPage(viewer.current + 1);
  else if (e.key === "ArrowLeft") viewer.goToPage(viewer.current - 1);
  else handled = false;
  if (handled) e.preventDefault();
});

// Hindre nettleserens egen kontekstmeny og utskriftsdialog i appen.
if (isTauri) {
  window.addEventListener("contextmenu", (e) => {
    if (!typing(e.target) && !window.getSelection()?.toString()) e.preventDefault();
  });
}

// ---------- Dra og slipp ----------

onFilesDropped(
  (paths) => {
    if (paths.length === 1 && !document.querySelector(".backdrop")) void openPath(paths[0]);
    else openMergeDialog(paths, (p) => void openPath(p));
  },
  (on) => dropOverlay.classList.toggle("show", on),
);

// ---------- Oppstart ----------

showCurrent();
void startupFile().then((p) => {
  if (p) void openPath(p);
});
