import "@fontsource-variable/hanken-grotesk";
import "./styles.css";
import { rearrangePages, type PageItem } from "./edit";
import { openExportDialog } from "./exportpng";
import { copyMeasureDoc, Measure, reorderMeasureDoc, type MeasureDoc } from "./measure";
import { openMergeDialog } from "./merge";
import { Organizer } from "./organize";
import { loadPdf, pdfjs, ThumbCache, type PDFDocumentProxy } from "./pdf";
import {
  baseName,
  confirmDialog,
  dirName,
  isTauri,
  listScreens,
  onCloseRequested,
  onFilesDropped,
  onLaunchFiles,
  openFile,
  openUrl,
  pickPdfs,
  pickSavePath,
  setTitle,
  startupFiles,
  writeFile,
} from "./platform";
import { Presentation } from "./present";
import { openPrintDialog } from "./print";
import { Search } from "./search";
import { busy, button, errorMessage, h, icon, logo, modal, toast } from "./ui";
import { CSS_UNITS, Viewer, type Tool, type ZoomMode } from "./viewer";

/** Et åpent dokument, med egen fane. */
interface OpenDoc {
  path: string;
  name: string;
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  /** Miniatyrene; tømmes når fanen ikke vises, og lages igjen ved behov. */
  thumbs: ThumbCache;
  /** Finnes ikke som fil ennå (resultat av «Slå sammen»); `path` er forslaget til filnavn. */
  unsaved: boolean;
  /** Siden, zoomen og rotasjonen fanen hadde sist den ble vist. */
  view: { page: number; zoom: ZoomMode; rotation: number };
  /** Målene i dokumentet (settes første gang fanen vises). */
  measure: MeasureDoc | null;
  /** Sidene er flyttet eller slettet siden fila ble lagret; endringen finnes bare i minnet. */
  modified: boolean;
  /** Tidligere versjoner av dokumentet, for å angre sideendringer (Ctrl+Z). */
  pageHistory: Array<{ bytes: Uint8Array; measure: MeasureDoc | null; modified: boolean }>;
}

/** Fanene, i rekkefølge; `current` er den som vises. */
const tabs: OpenDoc[] = [];
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
const search = new Search(viewer);
const measure = new Measure(viewer);
const app = document.getElementById("app")!;

const pageInput = h("input", { type: "text", class: "page-input", inputmode: "numeric", "aria-label": "Sidenummer", title: "Gå til side (Ctrl+G)" });
const pageTotal = h("span", { class: "page-total" });
const zoomLabel = h("span", { class: "zoom-label" }, "–");

const docButtons: HTMLButtonElement[] = [];
const docBtn = (b: HTMLButtonElement) => (docButtons.push(b), b);

// Markere tekst eller dra tegningen rundt (håndverktøy).
const selectBtn = docBtn(button("", "pointer", () => setTool("select"), { title: "Marker tekst (V)", className: "ghost tool" }));
const handBtn = docBtn(button("", "hand", () => setTool("hand"), { title: "Håndverktøy: dra tegningen rundt (H). Mellomrom eller midtre musetast virker alltid.", className: "ghost tool" }));

// Sidenavigasjon og zoom vises bare når et dokument er åpent.
const viewControls = h(
  "span",
  { class: "view-controls" },
  docBtn(button("", "search", () => search.open(), { title: "Søk i teksten (Ctrl+F)", className: "ghost" })),
  docBtn(button("", "sidebar", () => toggleSidebar(), { title: "Vis/skjul miniatyrer (Ctrl+B)", className: "ghost" })),
  h("span", { class: "page-nav" }, pageInput, pageTotal),
  h("span", { class: "sep" }),
  docBtn(button("", "minus", () => viewer.zoomOut(), { title: "Zoom ut (Ctrl+−)", className: "ghost" })),
  zoomLabel,
  docBtn(button("", "plus", () => viewer.zoomIn(), { title: "Zoom inn (Ctrl++)", className: "ghost" })),
  docBtn(button("", "fitWidth", () => setZoom("width"), { title: "Tilpass bredde (Ctrl+3)", className: "ghost" })),
  docBtn(button("", "fitPage", () => setZoom("page"), { title: "Hel side (Ctrl+2)", className: "ghost" })),
  docBtn(button("", "rotateRight", () => viewer.rotate(90), { title: "Roter visningen (R, Shift+R mot klokka). Fila endres ikke.", className: "ghost" })),
  h("span", { class: "sep" }),
  h("span", { class: "tool-group" }, selectBtn, handBtn),
  h("span", { class: "sep" }),
);

const measureBtn = docBtn(button("Mål", "ruler", () => measure.toggle(), { title: "Mål avstand, lengde og areal (M)", className: "keep-label" }));
measure.onChange = () => refresh();
measure.bytesSource = () => current!.bytes;
// Lagre mål: skriv fila og åpne den på nytt på samme side, med måling fortsatt på.
measure.onSave = async (bytes) => {
  if (!current) return false;
  let { path } = current;
  if (current.unsaved) {
    const target = await pickSavePath(path, "Lagre sammenslått PDF");
    if (!target) return false;
    path = target;
  }
  const page = viewer.current;
  const wasMeasuring = measure.active;
  const b = busy("Lagrer målene…");
  try {
    await writeFile(path, bytes);
    await openPath(path, { page, bytes, replace: true });
    if (wasMeasuring) measure.open();
    toast("Målene er lagret i fila", "success");
    return true;
  } catch (e) {
    toast(`Kunne ikke lagre: ${errorMessage(e)}`, "error");
    return false;
  } finally {
    b.done();
  }
};

// Stripe over et dokument med endringer som bare finnes i minnet: et
// sammenslått dokument som ikke er lagret ennå, eller flyttede/slettede sider.
const barTitle = h("strong", {});
const barHint = h("span", { class: "muted hint" });
const barDiscard = button("Forkast", null, () => void discardChanges());
const barSaveAs = button("Lagre som…", null, () => void saveDoc(true), { title: "Lagre som ny fil (Ctrl+Shift+S)" });
const barSave = button("Lagre", "save", () => void saveDoc(), { primary: true, title: "Lagre (Ctrl+S)" });
const unsavedBar = h("div", { class: "subbar unsaved-bar" }, barTitle, barHint, h("span", { class: "spacer" }), barDiscard, barSaveAs, barSave);

function updateDocBar(): void {
  const t = current;
  unsavedBar.hidden = !t || !(t.unsaved || t.modified);
  if (!t || unsavedBar.hidden) return;
  barTitle.textContent = t.unsaved ? "Ikke lagret" : "Endret";
  barHint.textContent = t.unsaved
    ? "Se over det sammenslåtte dokumentet. Dra sidene i sidepanelet for å endre rekkefølgen før du lagrer."
    : "Sidene er endret. Endringene skrives til fila først når du lagrer. Ctrl+Z angrer.";
  barDiscard.title = t.unsaved ? "Lukk uten å lagre" : "Forkast endringene og last fila på nytt";
  barSaveAs.hidden = t.unsaved;
  barSave.querySelector("span")!.textContent = t.unsaved ? "Lagre…" : "Lagre";
}

const presentBtn = docBtn(button("Presenter", "present", () => void startPresentation(), { title: "Fullskjerm-presentasjon (Ctrl+L)", className: "split-main" }));
const screenBtn = docBtn(button("", "caret", () => void openScreenMenu(), { title: "Velg skjerm for presentasjonen", className: "split-caret" }));

const toolbar = h(
  "header",
  { class: "toolbar" },
  button("Åpne", "open", () => void openDialog(), { title: "Åpne PDF (Ctrl+O)", className: "keep-label" }),
  button("Slå sammen", "merge", () => startMerge(), { title: "Slå sammen flere PDF-er (Ctrl+M)", className: "keep-label" }),
  h("span", { class: "sep" }),
  docBtn(button("Sorter sider", "organize", () => startOrganize(), { title: "Endre rekkefølge, roter eller slett sider (Ctrl+K)" })),
  docBtn(button("Til PNG", "image", () => startExport(), { title: "Eksporter sider som PNG-bilder (Ctrl+E)" })),
  docBtn(button("Skriv ut", "print", () => startPrint(), { title: "Skriv ut (Ctrl+P)" })),
  measureBtn,
  h("span", { class: "spacer" }),
  viewControls,
  h("span", { class: "split" }, presentBtn, screenBtn),
);

const sidebarList = h("div", { class: "thumb-list" });
const outlineList = h("div", { class: "outline", role: "tree", "aria-label": "Bokmerker" });
const tabPages = h("button", { class: "tab", type: "button" }, "Sider");
const tabOutline = h("button", { class: "tab", type: "button" }, "Bokmerker");
const sidebarTabs = h("div", { class: "sidebar-tabs", role: "tablist" }, tabPages, tabOutline);
const sidebar = h("aside", { class: "sidebar", "aria-label": "Sidepanel" }, sidebarTabs, sidebarList, outlineList);
tabPages.addEventListener("click", () => setSidebarTab("pages"));
tabOutline.addEventListener("click", () => setSidebarTab("outline"));
const content = h("section", { class: "content" });
const dropOverlay = h("div", { class: "drop-overlay" }, h("div", {}, "Slipp PDF-en her"));
const tabBar = h("div", { class: "tabbar", role: "tablist", "aria-label": "Åpne dokumenter" });
app.append(tabBar, toolbar, h("main", {}, sidebar, content), dropOverlay);

function emptyState(): HTMLElement {
  const shortcuts: Array<[string, string]> = [
    ["Ctrl+O", "Åpne"],
    ["Ctrl+L", "Presenter i fullskjerm"],
    ["Ctrl+F", "Søk i teksten"],
    ["M", "Mål avstand og areal"],
    ["Ctrl+P", "Skriv ut"],
    ["Ctrl+M", "Slå sammen PDF-er"],
    ["Ctrl+K", "Sorter sider"],
    ["Ctrl+E", "Eksporter til PNG"],
  ];
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty-icon", html: logo() }),
    h("h1", {}, "ArkiPDF"),
    h("p", { class: "muted" }, "Åpne en PDF, eller dra en fil inn i vinduet."),
    button("Åpne PDF…", "open", () => void openDialog(), { primary: true, className: "big" }),
    recentList(),
    h("dl", { class: "shortcuts" }, ...shortcuts.flatMap(([k, v]) => [h("dt", {}, h("kbd", {}, k)), h("dd", {}, v)])),
  );
}

// ---------- Nylige filer og sist leste side ----------

interface Recent {
  path: string;
  name: string;
  page: number;
  time: number;
}

function recentFiles(): Recent[] {
  try {
    const list = JSON.parse(store.get("recent") ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveRecent(list: Recent[]): void {
  store.set("recent", JSON.stringify(list.slice(0, 12)));
}

function rememberFile(path: string, name: string, page: number): void {
  if (!isTauri) return;
  saveRecent([{ path, name, page, time: Date.now() }, ...recentFiles().filter((r) => r.path !== path)]);
}

function forgetFile(path: string): void {
  saveRecent(recentFiles().filter((r) => r.path !== path));
}

let pageSaveTimer = 0;
function rememberPage(): void {
  clearTimeout(pageSaveTimer);
  pageSaveTimer = window.setTimeout(() => {
    if (!current || !isTauri) return;
    const list = recentFiles();
    const r = list.find((x) => x.path === current!.path);
    if (r && r.page !== viewer.current) {
      r.page = viewer.current;
      saveRecent(list);
    }
  }, 400);
}

function recentList(): HTMLElement | null {
  const list = recentFiles().slice(0, 8);
  if (!list.length) return null;
  return h(
    "div",
    { class: "recent" },
    h("h2", {}, "Nylig åpnet"),
    h(
      "ul",
      {},
      ...list.map((r) => {
        const b = h(
          "button",
          { type: "button", class: "recent-item", title: r.path },
          h("span", { class: "file-icon", html: icon("file") }),
          h("span", { class: "recent-name" }, r.name),
          h("span", { class: "recent-dir muted" }, dirName(r.path)),
        );
        b.addEventListener("click", () => void openPath(r.path));
        return h("li", {}, b);
      }),
    ),
  );
}

// ---------- Oppdatering av tilstand ----------

let sidebarVisible = store.get("sidebar") !== "0";

function toggleSidebar(): void {
  sidebarVisible = !sidebarVisible;
  store.set("sidebar", sidebarVisible ? "1" : "0");
  refresh();
}

function setTool(t: Tool): void {
  viewer.tool = t;
  store.set("tool", t);
}
viewer.tool = store.get("tool") === "hand" ? "hand" : "select";

let sidebarTab: "pages" | "outline" = store.get("sidebarTab") === "outline" ? "outline" : "pages";
let hasOutline = false;

function setSidebarTab(tab: "pages" | "outline"): void {
  sidebarTab = tab;
  store.set("sidebarTab", tab);
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
  const tab = hasOutline ? sidebarTab : "pages";
  sidebarTabs.hidden = !hasOutline;
  sidebarList.hidden = tab !== "pages";
  outlineList.hidden = tab !== "outline";
  tabPages.classList.toggle("active", tab === "pages");
  tabOutline.classList.toggle("active", tab === "outline");
  selectBtn.classList.toggle("active", viewer.tool === "select");
  handBtn.classList.toggle("active", viewer.tool === "hand");
  measureBtn.classList.toggle("active", measure.active);
  updateDocBar();
  renderTabs();
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

viewer.onChange = () => {
  refresh();
  rememberPage();
  measure.pageChanged();
};
viewer.onOpenUrl = (url) => {
  void confirmDialog(`Åpne lenken i nettleseren?\n\n${url}`).then((ok) => {
    if (ok) void openUrl(url);
  });
};

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

// Valgte sider i sidepanelet (Ctrl/Shift-klikk), som kan dras eller slettes.
let thumbSel = new Set<number>();
let thumbAnchor = -1;

function paintThumbSelection(): void {
  thumbEls.forEach((el, i) => el.classList.toggle("selected", thumbSel.has(i)));
}

function buildSidebar(): void {
  thumbObserver?.disconnect();
  thumbEls = [];
  highlighted = -1;
  sidebarList.replaceChildren(thumbDrop);
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
    { root: sidebarList, rootMargin: "300px 0px" },
  );
  const frag = document.createDocumentFragment();
  for (let i = 0; i < doc.numPages; i++) {
    const item = h(
      "button",
      { class: "thumb-item", "data-index": String(i), type: "button", title: `Side ${i + 1} · dra for å flytte, Ctrl/Shift-klikk for å velge flere, Delete sletter` },
      h("span", { class: "thumb-img" }, h("img", { alt: "", draggable: "false" })),
      h("span", { class: "thumb-num" }, String(i + 1)),
    );
    item.addEventListener("click", (e) => {
      if (thumbDragged) {
        thumbDragged = false;
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (thumbSel.has(i)) thumbSel.delete(i);
        else thumbSel.add(i);
        thumbAnchor = i;
      } else if (e.shiftKey && thumbAnchor >= 0) {
        thumbSel = new Set();
        for (let j = Math.min(thumbAnchor, i); j <= Math.max(thumbAnchor, i); j++) thumbSel.add(j);
      } else {
        thumbSel = new Set([i]);
        thumbAnchor = i;
        viewer.goToPage(i);
      }
      paintThumbSelection();
    });
    item.addEventListener("pointerdown", (e) => startThumbDrag(e, i));
    thumbEls.push(item);
    thumbObserver.observe(item);
    frag.append(item);
  }
  sidebarList.append(frag);
  paintThumbSelection();
}

// ---------- Dra sider i sidepanelet ----------

const thumbDrop = h("div", { class: "thumb-drop", hidden: true });
let thumbDragged = false;

/** Hvilket mellomrom (0..antall sider) musa er ved: før siden hvis den er over midten. */
function thumbGapAt(y: number): number {
  for (let i = 0; i < thumbEls.length; i++) {
    const r = thumbEls[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return thumbEls.length;
}

function startThumbDrag(e: PointerEvent, index: number): void {
  if (e.button !== 0 || !current || organizer) return;
  thumbDragged = false;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dragging = false;
  let gap = -1;
  let lastY = y0;
  let scroller = 0;
  const move = (ev: PointerEvent) => {
    lastY = ev.clientY;
    if (!dragging) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      dragging = true;
      if (!thumbSel.has(index)) {
        thumbSel = new Set([index]);
        thumbAnchor = index;
        paintThumbSelection();
      }
      sidebar.classList.add("dragging-pages");
      // Rull lista når musa er nær kanten.
      scroller = window.setInterval(() => {
        const r = sidebarList.getBoundingClientRect();
        if (lastY < r.top + 40) sidebarList.scrollTop -= 14;
        else if (lastY > r.bottom - 40) sidebarList.scrollTop += 14;
      }, 30);
    }
    gap = thumbGapAt(ev.clientY);
    const ref = thumbEls[gap] ?? thumbEls[thumbEls.length - 1];
    thumbDrop.style.top = `${gap < thumbEls.length ? ref.offsetTop - 3 : ref.offsetTop + ref.offsetHeight + 1}px`;
    thumbDrop.hidden = false;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    clearInterval(scroller);
    thumbDrop.hidden = true;
    sidebar.classList.remove("dragging-pages");
    if (!dragging || gap < 0 || !current) return;
    thumbDragged = true;
    setTimeout(() => (thumbDragged = false), 0);
    const n = current.doc.numPages;
    const sel = [...thumbSel].sort((a, b) => a - b);
    const rest = Array.from({ length: n }, (_, i) => i).filter((i) => !thumbSel.has(i));
    const at = rest.filter((i) => i < gap).length;
    const order = [...rest.slice(0, at), ...sel, ...rest.slice(at)];
    if (order.every((src, i) => src === i)) return;
    void changePages(
      order.map((src) => ({ src, rot: 0 })),
      at,
      sel.map((_, k) => at + k),
    );
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function highlightThumb(): void {
  const i = current ? viewer.current : -1;
  if (i === highlighted) return;
  thumbEls[highlighted]?.classList.remove("active");
  highlighted = i;
  const el = thumbEls[i];
  if (el) {
    el.classList.add("active");
    if (!sidebar.hidden && !sidebarList.hidden) el.scrollIntoView({ block: "center" });
  }
}

// ---------- Bokmerker ----------

interface OutlineItem {
  title: string;
  dest: unknown;
  url: string | null;
  items: OutlineItem[];
}

async function buildOutline(doc: PDFDocumentProxy): Promise<void> {
  outlineList.replaceChildren();
  hasOutline = false;
  const outline = (await doc.getOutline().catch(() => null)) as OutlineItem[] | null;
  if (current?.doc !== doc) return;
  hasOutline = !!outline?.length;
  if (outline?.length) outlineList.append(outlineBranch(outline, 0));
  refresh();
}

function outlineBranch(items: OutlineItem[], depth: number): HTMLElement {
  const ul = h("ul", { role: depth ? "group" : undefined });
  for (const item of items) {
    const hasChildren = item.items?.length > 0;
    const li = h("li", { role: "treeitem" });
    const toggle = h("button", { type: "button", class: "outline-toggle", "aria-label": "Vis/skjul", html: icon("chevron") });
    toggle.style.visibility = hasChildren ? "visible" : "hidden";
    const link = h("button", { type: "button", class: "outline-link", title: item.title }, item.title);
    link.addEventListener("click", () => {
      if (item.dest) void viewer.navigate(item.dest);
      else if (item.url) viewer.onOpenUrl(item.url);
    });
    li.append(h("div", { class: "outline-row" }, toggle, link));
    if (hasChildren) {
      const child = outlineBranch(item.items, depth + 1);
      // Første nivå vises utfoldet; dypere nivåer brettes sammen.
      const open = depth === 0 && items.length < 40;
      child.hidden = !open;
      li.classList.toggle("open", open);
      li.setAttribute("aria-expanded", String(open));
      toggle.addEventListener("click", () => {
        child.hidden = !child.hidden;
        li.classList.toggle("open", !child.hidden);
        li.setAttribute("aria-expanded", String(!child.hidden));
      });
      li.append(child);
    }
    ul.append(li);
  }
  return ul;
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

/** Hva i fanen som ikke er lagret i fila (tomt: alt er lagret). */
function unsavedReasons(t: OpenDoc): string[] {
  const r: string[] = [];
  if (t.unsaved) r.push("sammenslått dokument som ikke er lagret");
  else if (t.modified) r.push("sidene er endret");
  if (t.measure?.dirty) r.push("mål som ikke er lagret i fila");
  return r;
}

function hasUnsaved(t: OpenDoc): boolean {
  return unsavedReasons(t).length > 0;
}

/** Før vinduet lukkes: spør hvis noen faner har noe som ikke er lagret. */
async function confirmQuit(): Promise<boolean> {
  const names = tabs.filter(hasUnsaved).map((t) => `• ${t.name}: ${unsavedReasons(t).join(" og ")}`);
  if (organizer?.dirty && current && !hasUnsaved(current)) names.push(`• ${current.name} (siderekkefølge)`);
  if (!names.length) return true;
  return confirmDialog(`Dette er ikke lagret:\n\n${names.join("\n")}\n\nLukke ArkiPDF likevel?`);
}

async function openDialog(): Promise<void> {
  await openPaths(await pickPdfs(true));
}

/** Åpner flere filer, hver i sin fane (én om gangen, så den siste vises til slutt). */
async function openPaths(paths: string[]): Promise<void> {
  for (const p of paths) await openPath(p);
}

interface OpenOptions {
  /** Side å starte på (ellers den som er husket). */
  page?: number;
  /** Innholdet, når det allerede er i minnet. */
  bytes?: Uint8Array;
  /** Dokumentet finnes ikke som fil ennå; `path` er forslaget til filnavn. */
  unsaved?: boolean;
  /** Erstatter dokumentet i fanen som vises med en ny versjon av det (etter lagring). */
  replace?: boolean;
}

const samePath = (a: string, b: string) => (isTauri ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Åpner en PDF i en ny fane, eller går til fanen hvis fila allerede er åpen. */
async function openPath(path: string, opts: OpenOptions = {}): Promise<void> {
  const { page: startPage, bytes: preloaded, unsaved = false, replace = false } = opts;
  if (!replace && !unsaved) {
    const open = tabs.find((t) => !t.unsaved && samePath(t.path, path));
    if (open) {
      activate(open);
      if (startPage !== undefined) viewer.goToPage(startPage);
      return;
    }
  }
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
    const remembered = unsaved ? 0 : (recentFiles().find((r) => r.path === path)?.page ?? 0);
    const page = Math.min(startPage ?? remembered, doc.numPages - 1);
    const old = replace ? current : null;
    // En ny versjon av samme dokument beholder zoom og rotasjon; en ny fil får standard zoom.
    const z = store.get("zoom");
    const view = old ? { page, zoom: viewer.zoomMode, rotation: viewer.rotation } : { page, zoom: (z === "width" || z === "page" ? z : "auto") as ZoomMode, rotation: 0 };
    const tab: OpenDoc = { ...file, doc, thumbs: new ThumbCache(doc, 320), unsaved, view, measure: null, modified: false, pageHistory: [] };
    if (old && tabs.includes(old)) {
      tabs[tabs.indexOf(old)] = tab;
      old.thumbs.dispose();
      void old.doc.loadingTask.destroy();
    } else {
      tabs.push(tab);
      leaveCurrent();
    }
    current = tab;
    if (!unsaved) rememberFile(path, file.name, page);
    await updateTitle();
    showCurrent();
  } catch (e) {
    toast(`Kunne ikke åpne ${baseName(path)}: ${errorMessage(e)}`, "error");
    if (!preloaded) forgetFile(path);
    showCurrent();
  }
}

/** Husker hvor man var i fanen som vises, og frigjør miniatyrene før en annen fane vises. */
function leaveCurrent(): void {
  if (!current) return;
  thumbSel.clear();
  if (viewer.document === current.doc) current.view = { page: viewer.current, zoom: viewer.zoomMode, rotation: viewer.rotation };
  current.thumbs.dispose();
  void current.doc.cleanup();
}

/** Viser en annen fane. */
function activate(tab: OpenDoc): void {
  if (tab === current || organizer || presentation?.active) return;
  leaveCurrent();
  current = tab;
  void updateTitle();
  showCurrent();
}

/** Lukker en fane (spør først hvis noe ikke er lagret). */
async function closeTab(tab: OpenDoc): Promise<void> {
  if (organizer) return;
  if ((tab.unsaved || tab.modified) && !(await confirmDialog(`«${tab.name}» ${tab.unsaved ? "er ikke lagret" : "har endringer som ikke er lagret"}. Lukke uten å lagre?\n\n(Velg «Nei» og trykk Ctrl+S for å lagre.)`))) return;
  if (!tab.unsaved && !tab.modified && tab.measure?.dirty && !(await confirmDialog(`«${tab.name}» har mål som ikke er lagret i fila. Lukke likevel?\n\n(Velg «Nei» og trykk Ctrl+S i måleverktøyet for å lagre.)`))) return;
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (tab === current) {
    current = tabs[Math.min(i, tabs.length - 1)] ?? null;
    if (!current) {
      measure.close();
      measure.setDocument(null, null);
      search.setDocument(null);
      void viewer.setDocument(null);
    }
    void updateTitle();
    showCurrent();
  } else refresh();
  tab.thumbs.dispose();
  void tab.doc.loadingTask.destroy();
}

/** Neste (1) eller forrige (-1) fane, med omløp. */
function cycleTab(dir: number): void {
  if (!current || tabs.length < 2) return;
  activate(tabs[(tabs.indexOf(current) + dir + tabs.length) % tabs.length]);
}

let tabsKey = "";
/** Tegner fanelinja på nytt når noe i den er endret. */
function renderTabs(): void {
  const key = [organizer ? 1 : 0, current ? tabs.indexOf(current) : -1, ...tabs.map((t) => `${t.name}|${t.path}|${unsavedReasons(t).join()}`)].join("/");
  if (key === tabsKey) return;
  tabsKey = key;
  tabBar.hidden = tabs.length === 0;
  tabBar.classList.toggle("locked", !!organizer);
  tabBar.replaceChildren(
    ...tabs.map((t) => {
      const reasons = unsavedReasons(t);
      const tip = `${t.unsaved ? t.name : t.path}${reasons.length ? `\nIkke lagret: ${reasons.join(" og ")}` : ""}`;
      const close = h("span", { class: "tab-close", role: "button", "aria-label": `Lukk ${t.name}`, title: "Lukk (Ctrl+W)", html: icon("close") });
      const el = h(
        "div",
        { class: `doc-tab${t === current ? " active" : ""}${reasons.length ? " dirty" : ""}`, role: "tab", "aria-selected": String(t === current), title: tip },
        h("span", { class: "doc-tab-name" }, t.name),
        h("span", { class: "doc-tab-dot" }),
        close,
      );
      el.addEventListener("mousedown", (e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest(".tab-close")) activate(t);
        if (e.button === 1) e.preventDefault();
      });
      el.addEventListener("auxclick", (e) => {
        if (e.button === 1) void closeTab(t);
      });
      close.addEventListener("click", () => void closeTab(t));
      return el;
    }),
    button("", "plus", () => void openDialog(), { title: "Åpne PDF i ny fane (Ctrl+O)", className: "ghost tab-new" }),
  );
  tabBar.querySelector(".doc-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function updateTitle(): Promise<void> {
  if (!current) return setTitle("ArkiPDF");
  return setTitle(`${current.name}${current.unsaved ? " (ikke lagret)" : current.modified ? " (endret)" : ""} – ArkiPDF`);
}

/** Viser fanen som er valgt (eller startsiden) i innholdsfeltet. */
function showCurrent(): void {
  if (!current) {
    content.replaceChildren(emptyState());
    refresh();
    return;
  }
  content.replaceChildren(unsavedBar, measure.bar, viewer.el, search.el, measure.panel);
  if (viewer.document !== current.doc) {
    const tab = current;
    search.setDocument(tab.doc);
    // Mål følger fanen: første gang leses de fra fila, siden brukes de som de var.
    if (tab.measure) measure.useDocument(tab.measure);
    else {
      measure.close();
      measure.setDocument(tab.bytes, tab.doc);
      tab.measure = measure.state;
    }
    viewer.setZoom(tab.view.zoom, null);
    void viewer.setDocument(tab.doc, tab.view.page, tab.view.rotation).then(() => viewer.el.focus());
    buildSidebar();
    void buildOutline(tab.doc);
  }
  refresh();
}

// ---------- Presentasjon ----------

async function startPresentation(): Promise<void> {
  if (!current || organizer) return;
  if (presentation?.active) return presentation.stop();
  presentation = new Presentation(current.doc, viewer.rotation);
  presentation.onExit = (page) => {
    viewer.goToPage(page);
    viewer.el.focus();
  };
  // Husket skjerm (f.eks. projektoren) brukes hvis den fortsatt er tilkoblet.
  const wanted = store.get("presentScreen");
  const screens = wanted ? await listScreens().catch(() => []) : [];
  const screen = screens.find((x) => x.id === wanted) ? wanted : null;
  await presentation.start(viewer.current, screen);
}

/** Liten meny under pilen ved «Presenter»: velg hvilken skjerm det skal vises på. */
async function openScreenMenu(): Promise<void> {
  document.querySelector(".popover")?.remove();
  const screens = await listScreens().catch(() => []);
  const wanted = store.get("presentScreen");
  const chosen = screens.find((x) => x.id === wanted)?.id ?? null;
  const item = (label: string, id: string | null, active: boolean) => {
    const b = h("button", { type: "button", class: `popover-item${active ? " active" : ""}` }, label);
    b.addEventListener("click", () => {
      if (id) store.set("presentScreen", id);
      else store.set("presentScreen", "");
      close();
      void startPresentation();
    });
    return b;
  };
  const menu = h(
    "div",
    { class: "popover", role: "menu" },
    h("div", { class: "popover-title" }, "Presenter på"),
    item("Skjermen ArkiPDF står på", null, !chosen),
    ...screens.filter((x) => !x.current).map((x) => item(x.label, x.id, x.id === chosen)),
    screens.length <= 1 ? h("div", { class: "popover-note muted" }, isTauri ? "Bare én skjerm er tilkoblet. Koble til projektoren som «Utvid skjerm» (Windows+P) for å velge den her." : "Skjermvalg finnes i Windows-appen.") : null,
  );
  const r = screenBtn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${window.innerWidth - r.right}px`;
  document.body.append(menu);
  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", esc, true);
  };
  const outside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("keydown", esc, true);
  (menu.querySelector(".popover-item") as HTMLElement | null)?.focus();
}

// ---------- Sorter sider ----------

function startOrganize(): void {
  if (!current || organizer) return;
  const doc = current;
  // «Bruk» endrer dokumentet i minnet og går tilbake til vanlig visning; det lagres som vanlig etterpå.
  organizer = new Organizer(doc.doc.numPages, doc.thumbs, {
    save: async (items) => {
      await changePages(items, 0);
    },
    saveAs: async (items) => {
      if (await changePages(items, 0)) await saveDoc(true);
    },
    close: async () => {
      if (organizer?.dirty && !(await confirmDialog("Du har endringer i siderekkefølgen som ikke er tatt i bruk. Forkaste dem?"))) return;
      closeOrganizer();
      showCurrent();
    },
  }, true);
  if (search.isOpen) search.close();
  measure.close();
  content.replaceChildren(organizer.el);
  refresh();
  (organizer.el.querySelector(".grid") as HTMLElement).focus();
}

// ---------- Endre sider (sidepanelet og «Sorter sider») ----------

/**
 * Ny siderekkefølge (eller slettede/roterte sider) for dokumentet som vises.
 * Endringen gjøres i minnet og lagres først når man lagrer; målene følger sidene.
 */
async function changePages(items: PageItem[], focus: number, select: number[] = []): Promise<boolean> {
  const tab = current;
  if (!tab) return false;
  const b = busy("Oppdaterer sidene…");
  try {
    const out = await rearrangePages(tab.bytes, items, tab.name);
    const doc = await loadPdf(out);
    tab.pageHistory.push({ bytes: tab.bytes, measure: tab.measure ? copyMeasureDoc(tab.measure) : null, modified: tab.modified });
    if (tab.pageHistory.length > 30) tab.pageHistory.shift();
    if (tab.measure) reorderMeasureDoc(tab.measure, items.map((it) => it.src), doc);
    const old = swapDoc(tab, out, doc, focus);
    tab.modified = !tab.unsaved;
    thumbSel = new Set(select);
    thumbAnchor = select[0] ?? -1;
    organizer = null;
    showCurrent();
    void updateTitle();
    void old.loadingTask.destroy();
    return true;
  } catch (e) {
    toast(`Kunne ikke endre sidene: ${errorMessage(e)}`, "error");
    return false;
  } finally {
    b.done();
  }
}

/** Angrer siste sideendring. */
async function undoPages(): Promise<void> {
  const tab = current;
  const prev = tab?.pageHistory.pop();
  if (!tab || !prev) return;
  try {
    const doc = await loadPdf(prev.bytes);
    if (prev.measure) prev.measure.doc = doc;
    tab.measure = prev.measure;
    const old = swapDoc(tab, prev.bytes, doc, viewer.current);
    tab.modified = prev.modified;
    thumbSel.clear();
    showCurrent();
    void updateTitle();
    void old.loadingTask.destroy();
  } catch (e) {
    toast(`Kunne ikke angre: ${errorMessage(e)}`, "error");
  }
}

/** Bytter innholdet i en fane (siden visningen skal stå på, beholder zoom og rotasjon). Returnerer det gamle dokumentet. */
function swapDoc(tab: OpenDoc, bytes: Uint8Array, doc: PDFDocumentProxy, page: number): PDFDocumentProxy {
  const old = tab.doc;
  tab.view = viewer.document === old ? { page, zoom: viewer.zoomMode, rotation: viewer.rotation } : { ...tab.view, page };
  tab.thumbs.dispose();
  tab.thumbs = new ThumbCache(doc, 320);
  tab.bytes = bytes;
  tab.doc = doc;
  return old;
}

/** Sletter sidene som er valgt i sidepanelet. */
function deleteSelectedPages(): void {
  if (!current || !thumbSel.size) return;
  const n = current.doc.numPages;
  if (thumbSel.size >= n) {
    toast("Dokumentet må ha minst én side.", "error");
    return;
  }
  const keep = Array.from({ length: n }, (_, i) => i).filter((i) => !thumbSel.has(i));
  const first = Math.min(...thumbSel);
  void changePages(
    keep.map((src) => ({ src, rot: 0 })),
    Math.min(first, keep.length - 1),
  );
}

/** Lagrer dokumentet (Ctrl+S), eller som ny fil (Ctrl+Shift+S). Mål som ikke er lagret, blir med. */
async function saveDoc(saveAs = false): Promise<void> {
  const tab = current;
  if (!tab) return;
  // Lagring av mål skriver hele dokumentet, med sideendringene, og åpner det på nytt.
  if (measure.dirty && !saveAs) return void (await measure.save());
  if (tab.unsaved) return saveUnsaved();
  if (!tab.modified && !saveAs) return;
  let target = tab.path;
  if (saveAs) {
    const picked = await pickSavePath(tab.path.replace(/\.pdf$/i, " (endret).pdf"), "Lagre som");
    if (!picked || current !== tab) return;
    target = picked;
  }
  const b = busy("Lagrer…");
  try {
    await writeFile(target, tab.bytes);
    tab.path = target;
    tab.name = baseName(target);
    tab.modified = false;
    rememberFile(target, tab.name, viewer.current);
    await updateTitle();
    refresh();
    toast(`Lagret ${tab.name}`, "success");
  } catch (e) {
    toast(`Kunne ikke lagre: ${errorMessage(e)}`, "error");
  } finally {
    b.done();
  }
}

/** Forkaster endringene: lukker et ulagret dokument, eller laster fila på nytt. */
async function discardChanges(): Promise<void> {
  const tab = current;
  if (!tab) return;
  if (tab.unsaved) return closeTab(tab);
  if (!(await confirmDialog(`Forkaste endringene i «${tab.name}» og laste fila på nytt?`))) return;
  await openPath(tab.path, { page: viewer.current, replace: true });
}

function closeOrganizer(): void {
  organizer = null;
}

// ---------- Slå sammen og eksport ----------

function startMerge(): void {
  if (organizer) return;
  openMergeDialog(current && isTauri && !current.unsaved ? [current.path] : [], showMerged);
}

/** Viser resultatet av «Slå sammen» uten å lagre det, så det kan ses over først. */
function showMerged(bytes: Uint8Array, suggestedPath: string): void {
  void openPath(suggestedPath, { page: 0, bytes, unsaved: true });
}

/** Lagrer et sammenslått dokument som ikke er lagret ennå. */
async function saveUnsaved(): Promise<void> {
  const doc = current;
  if (!doc?.unsaved) return;
  const target = await pickSavePath(doc.path, "Lagre sammenslått PDF");
  if (!target || current !== doc) return;
  const b = busy("Lagrer…");
  try {
    await writeFile(target, doc.bytes);
    doc.path = target;
    doc.name = baseName(target);
    doc.unsaved = false;
    doc.modified = false;
    rememberFile(target, doc.name, viewer.current);
    await updateTitle();
    refresh();
    toast(`Lagret ${doc.name}`, "success");
  } catch (e) {
    toast(`Kunne ikke lagre: ${errorMessage(e)}`, "error");
  } finally {
    b.done();
  }
}


function startPrint(): void {
  if (!current || organizer) return;
  openPrintDialog(current.doc, current.bytes, current.name, viewer.current);
}

function startExport(): void {
  if (!current || organizer) return;
  openExportDialog(current.doc, current.path, viewer.current);
}

// ---------- Tastatur ----------

const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;

window.addEventListener("keydown", (e) => {
  // Aldri la nettleserdelen skrive ut selve programvinduet.
  const printKey = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p";
  if (printKey) e.preventDefault();
  if (presentation?.active || document.querySelector(".backdrop")) return;
  if (organizer) {
    if (organizer.handleKey(e)) e.preventDefault();
    return;
  }
  // Sidepanelet: Delete sletter valgte sider, Ctrl+Z angrer sideendringer.
  const ctrlKey = e.ctrlKey || e.metaKey;
  if (current && sidebarList.contains(document.activeElement)) {
    if (e.key === "Delete" && thumbSel.size) {
      e.preventDefault();
      return deleteSelectedPages();
    }
    if (ctrlKey && e.key.toLowerCase() === "z" && current.pageHistory.length) {
      e.preventDefault();
      return void undoPages();
    }
  }
  // Måling har egne taster (D/L/A, Enter, Esc, Delete …).
  if (measure.active && current && !typing(e.target) && measure.handleKey(e)) {
    e.preventDefault();
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  let handled = true;
  if (ctrl && k === "o") void openDialog();
  else if (ctrl && k === "m") startMerge();
  else if ((ctrl && k === "l") || e.key === "F5") void startPresentation();
  // Ctrl+P fanges alltid, ellers ville nettleserdelen skrevet ut selve programvinduet.
  else if (ctrl && k === "p") startPrint();
  else if (!current) handled = false;
  else if (ctrl && k === "w") void closeTab(current);
  else if (ctrl && (e.key === "Tab" || e.key === "PageDown" || e.key === "PageUp")) cycleTab(e.key === "PageUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1);
  else if (ctrl && k === "s") void saveDoc(e.shiftKey);
  else if (ctrl && k === "z" && current.pageHistory.length) void undoPages();
  else if (ctrl && k === "f") search.open();
  else if (e.key === "F3") search.step(e.shiftKey ? -1 : 1);
  else if (e.key === "Escape" && search.isOpen) search.close();
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
  else if (e.key === " " && !(e.target instanceof HTMLButtonElement)) viewer.handleSpace(e);
  else if (e.key === "Home") viewer.goToPage(0);
  else if (e.key === "End") viewer.goToPage(viewer.pageCount - 1);
  // Piltaster blar side, men ruller sidelengs når tegningen er bredere enn vinduet.
  else if (e.key === "ArrowRight" && !scrollsSideways()) viewer.goToPage(viewer.current + 1);
  else if (e.key === "ArrowLeft" && !scrollsSideways()) viewer.goToPage(viewer.current - 1);
  else if (k === "m") measure.toggle();
  else if (k === "h") setTool("hand");
  else if (k === "v") setTool("select");
  else if (e.key === "r") viewer.rotate(90);
  else if (e.key === "R") viewer.rotate(-90);
  else handled = false;
  if (handled) e.preventDefault();
});

window.addEventListener("keyup", (e) => {
  if (e.key === " " && current && !organizer && !presentation?.active) viewer.handleSpace(e);
});

function scrollsSideways(): boolean {
  return viewer.el.scrollWidth > viewer.el.clientWidth + 1;
}

// Hindre nettleserens egen kontekstmeny og utskriftsdialog i appen.
if (isTauri) {
  window.addEventListener("contextmenu", (e) => {
    if (!typing(e.target) && !window.getSelection()?.toString()) e.preventDefault();
  });
}

// ---------- Dra og slipp ----------

onFilesDropped(
  (paths) => {
    // Filene åpnes i hver sin fane (mens en dialog er åpen: i sammenslåingen, som før).
    if (document.querySelector(".backdrop")) openMergeDialog(paths, showMerged);
    else void openPaths(paths);
  },
  (on) => dropOverlay.classList.toggle("show", on),
);

// ---------- Oppstart ----------

// Spør før vinduet lukkes med noe som ikke er lagret.
onCloseRequested(confirmQuit);

/** Filer fra Utforsker (dobbeltklikk, «Åpne med», «Send til»): åpnes i faner, eller i sammenslåingen. */
function openLaunched({ files, merge }: { files: string[]; merge: boolean }): void {
  if (merge && files.length) openMergeDialog(files, showMerged);
  else void openPaths(files);
}

showCurrent();
void startupFiles().then(openLaunched);
// ArkiPDF kjører i ett vindu: filer som åpnes mens det er åpent, kommer hit.
onLaunchFiles(openLaunched);
