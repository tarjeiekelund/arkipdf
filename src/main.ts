import "./styles.css";
import { rearrangePages, type PageItem } from "./edit";
import { openExportDialog } from "./exportpng";
import { openMergeDialog } from "./merge";
import { Organizer } from "./organize";
import { loadPdf, pdfjs, ThumbCache, type PDFDocumentProxy } from "./pdf";
import {
  baseName,
  confirmDialog,
  dirName,
  isTauri,
  listScreens,
  onFilesDropped,
  openFile,
  openUrl,
  pickPdfs,
  pickSavePath,
  setTitle,
  startupFile,
  writeFile,
} from "./platform";
import { Presentation } from "./present";
import { openPrintDialog } from "./print";
import { Search } from "./search";
import { busy, button, errorMessage, h, icon, modal, toast } from "./ui";
import { CSS_UNITS, Viewer, type Tool, type ZoomMode } from "./viewer";

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
const search = new Search(viewer);
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

const presentBtn = docBtn(button("Presenter", "present", () => void startPresentation(), { title: "Fullskjerm-presentasjon (Ctrl+L)", primary: true, className: "split-main" }));
const screenBtn = docBtn(button("", "caret", () => void openScreenMenu(), { title: "Velg skjerm for presentasjonen", primary: true, className: "split-caret" }));

const toolbar = h(
  "header",
  { class: "toolbar" },
  button("Åpne", "open", () => void openDialog(), { title: "Åpne PDF (Ctrl+O)" }),
  button("Slå sammen", "merge", () => startMerge(), { title: "Slå sammen flere PDF-er (Ctrl+M)" }),
  docBtn(button("Sorter sider", "organize", () => startOrganize(), { title: "Endre rekkefølge, roter eller slett sider (Ctrl+K)" })),
  docBtn(button("Til PNG", "image", () => startExport(), { title: "Eksporter sider som PNG-bilder (Ctrl+E)" })),
  docBtn(button("Skriv ut", "print", () => startPrint(), { title: "Skriv ut (Ctrl+P)" })),
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
app.append(toolbar, h("main", {}, sidebar, content), dropOverlay);

function emptyState(): HTMLElement {
  const shortcuts: Array<[string, string]> = [
    ["Ctrl+O", "Åpne"],
    ["Ctrl+L", "Presenter i fullskjerm"],
    ["Ctrl+F", "Søk i teksten"],
    ["Ctrl+P", "Skriv ut"],
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
    { root: sidebarList, rootMargin: "300px 0px" },
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

async function confirmDiscard(): Promise<boolean> {
  if (!organizer?.dirty) return true;
  return confirmDialog("Du har endringer i siderekkefølgen som ikke er lagret. Forkaste dem?");
}

async function openDialog(): Promise<void> {
  const [path] = await pickPdfs(false);
  if (path) await openPath(path);
}

async function openPath(path: string, startPage?: number, preloaded?: Uint8Array): Promise<void> {
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
    current = { ...file, doc, thumbs: new ThumbCache(doc, 320) };
    const remembered = recentFiles().find((r) => r.path === path)?.page ?? 0;
    const page = Math.min(startPage ?? remembered, doc.numPages - 1);
    rememberFile(path, file.name, page);
    if (old) {
      old.thumbs.dispose();
      void old.doc.loadingTask.destroy();
    }
    await setTitle(`${file.name} – Blad`);
    showCurrent(page);
  } catch (e) {
    toast(`Kunne ikke åpne ${baseName(path)}: ${errorMessage(e)}`, "error");
    if (!preloaded) forgetFile(path);
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
  content.replaceChildren(viewer.el, search.el);
  if (viewer.document !== current.doc) {
    search.setDocument(current.doc);
    const z = store.get("zoom");
    viewer.setZoom(z === "width" || z === "page" ? z : "auto", null);
    void viewer.setDocument(current.doc, startPage).then(() => viewer.el.focus());
    buildSidebar();
    void buildOutline(current.doc);
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
    item("Skjermen Blad står på", null, !chosen),
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
  if (search.isOpen) search.close();
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
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  let handled = true;
  if (ctrl && k === "o") void openDialog();
  else if (ctrl && k === "m") startMerge();
  else if ((ctrl && k === "l") || e.key === "F5") void startPresentation();
  // Ctrl+P fanges alltid, ellers ville nettleserdelen skrevet ut selve programvinduet.
  else if (ctrl && k === "p") startPrint();
  else if (!current) handled = false;
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
