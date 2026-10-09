import "@fontsource-variable/hanken-grotesk";
import "./styles.css";
import { flattenForm, IMAGE_FILE, imagesToPdf, isSigned, rearrangePages, type PageItem } from "./edit";
import { fontFiles } from "./fonts";
import { normalizeImage } from "./images";
import { openExportDialog } from "./exportpng";
import { browserCodec } from "./compress";
import { copyMarkupDoc, Markup, reorderMarkupDoc, type MarkupDoc } from "./markup";
import { flattenSignatures } from "./markup-pdf";
import { TextMenu, type EraseArea } from "./textmenu";
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
  convertOffice,
  OFFICE_FILE,
  onLaunchFiles,
  openFile,
  openInNewWindow,
  readSystemFont,
  openUrl,
  pickDocuments,
  pickSavePath,
  setTitle,
  startupFiles,
  writeFile,
} from "./platform";
import { Presentation } from "./present";
import { openPrintDialog } from "./print";
import { openShrinkDialog } from "./shrink";
import { checkForUpdates } from "./update";
import { Redactor } from "./redact";
import { eraseText, redactPdf, type RedactArea } from "./redact-pdf";
import { Search } from "./search";
import { TextEditor } from "./textedit";
import { loadForRuns, replaceLine, textRuns, type TextLine } from "./textedit-pdf";
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
  /** Markeringene i dokumentet (settes første gang fanen vises). */
  markup: MarkupDoc | null;
  /** Skjemafelt er fylt ut, men ikke lagret (verdiene ligger i `doc.annotationStorage`). */
  formsDirty: boolean;
  /** Fila er signert digitalt (se `confirmSigned`). */
  signed: boolean;
  /** Sidene er flyttet eller slettet siden fila ble lagret; endringen finnes bare i minnet. */
  modified: boolean;
  /** Tidligere versjoner av dokumentet, for å angre sideendringer (Ctrl+Z). */
  pageHistory: Array<{ bytes: Uint8Array; measure: MeasureDoc | null; markup: MarkupDoc | null; modified: boolean }>;
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
const markup = new Markup(viewer);
const textEdit = new TextEditor(viewer);
const redactor = new Redactor(viewer);
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

const measureBtn = docBtn(button("Mål", "ruler", () => toggleMeasure(), { title: "Mål avstand, lengde og areal (M)", className: "keep-label" }));
const markupBtn = docBtn(button("Merk", "markup", () => toggleMarkup(), { title: "Marker med sky, pil og tekst (K)", className: "keep-label" }));
const signBtn = docBtn(button("Signer", "sign", () => void toggleSign(), { title: "Sett inn signaturen din (tegnet eller fra et bilde)", className: "keep-label" }));
const textEditBtn = docBtn(button("Rediger", "editText", () => toggleTextEdit(), { title: "Rediger tekst i PDF-en (E)", className: "keep-label" }));
measure.onChange = () => refresh();
markup.onChange = () => refresh();
textEdit.onChange = () => refresh();
redactor.onChange = () => refresh();
redactor.onApply = (areas) => applyRedaction(areas);
const redactBtn = docBtn(button("Sladd", "redact", () => toggleRedact(), { title: "Sladd: fjern tekst, bilder og annet for godt", className: "keep-label" }));
textEdit.onEdit = (line, text) => applyTextEdit(line, text);
// Tekstkommandoene leses med pdf-lib fra fanens bytes (én gang per versjon av dokumentet).
let runsDoc: { bytes: Uint8Array; doc: ReturnType<typeof loadForRuns> } | null = null;
textEdit.runsFor = async (page) => {
  const tab = current;
  if (!tab) return [];
  if (runsDoc?.bytes !== tab.bytes) runsDoc = { bytes: tab.bytes, doc: loadForRuns(tab.bytes) };
  return textRuns(await runsDoc.doc, page);
};
measure.onSave = () => saveAnnotations();
markup.onSave = () => saveAnnotations();
markup.onSaveLocked = () => saveFlattened();

// Høyreklikk på markert tekst: kopier, marker, understrek, gjennomstrek, slett.
const textMenu = new TextMenu(markup);
textMenu.onErase = (areas) => void applyErase(areas);
viewer.el.addEventListener("contextmenu", (e) => {
  if (!current || typing(e.target)) return;
  if (textMenu.handle(e, viewer.el)) e.preventDefault();
});

/** Måling, markering og tekstredigering er hver sin modus; bare én er på om gangen. */
function toggleMeasure(): void {
  closeModes(measure);
  measure.toggle();
}

function toggleMarkup(): void {
  closeModes(markup);
  markup.toggle();
}

/** Signering er markering med signaturverktøyet. */
async function toggleSign(): Promise<void> {
  if (markup.signing) return markup.close();
  closeModes(markup);
  const was = markup.active;
  markup.open();
  await markup.useTool("sign");
  // Avbrutt før det fantes en signatur: tilbake dit vi var.
  if (!was && !markup.signing) markup.close();
}

function toggleTextEdit(): void {
  closeModes(textEdit);
  textEdit.toggle();
}

function toggleRedact(): void {
  closeModes(redactor);
  redactor.toggle();
}

/** Lukker de andre verktøyene (bare ett er på om gangen). */
function closeModes(keep?: { close(): void }): void {
  for (const m of [measure, markup, textEdit, redactor]) if (m !== keep) m.close();
}

/**
 * Sladder områdene: innholdet under fjernes fra dokumentet (i minnet, så
 * Ctrl+Z angrer til man lagrer). Mål og markeringer i områdene fjernes også.
 */
async function applyRedaction(areas: RedactArea[]): Promise<boolean> {
  const tab = current;
  if (!tab) return false;
  const n = areas.length;
  const ok = await confirmDialog(
    `Sladde ${n} ${n === 1 ? "område" : "områder"}?\n\nAlt under områdene – tekst, bilder, figurer og kommentarer – fjernes fra dokumentet og dekkes med svart. Du kan angre med Ctrl+Z til du lagrer; etter at fila er lagret, kan innholdet ikke hentes tilbake.\n\nTips: bruk «Lagre som…», så beholder du originalen.`,
  );
  if (!ok || current !== tab) return false;
  const b = busy("Sladder…");
  try {
    await bakeForms(tab);
    const { bytes, stats } = await redactPdf(tab.bytes, areas, browserCodec);
    if (current !== tab) return false;
    await replaceContent(tab, bytes, Array.from({ length: tab.doc.numPages }, (_, i) => i), viewer.current);
    const own = measure.removeInAreas(areas) + markup.removeInAreas(areas);
    showCurrent();
    const parts: string[] = [];
    if (stats.glyphs) parts.push(`${stats.glyphs} tegn fjernet`);
    if (stats.images) parts.push(`${stats.images} ${stats.images === 1 ? "bilde" : "bilder"} svertet`);
    if (stats.paths) parts.push(`${stats.paths} ${stats.paths === 1 ? "figur" : "figurer"} fjernet`);
    if (stats.annotations + own) parts.push(`${stats.annotations + own} ${stats.annotations + own === 1 ? "kommentar" : "kommentarer"} fjernet`);
    toast(`Sladdet${parts.length ? `: ${parts.join(", ")}` : ""}. Lagre med «Lagre som…» for å beholde originalen. Ctrl+Z angrer.`, "success");
    return true;
  } catch (e) {
    toast(`Kunne ikke sladde: ${errorMessage(e)}`, "error");
    return false;
  } finally {
    b.done();
  }
}

/** «Slett tekst»: tegnene fjernes fra fila (i minnet, så Ctrl+Z angrer til man lagrer). */
async function applyErase(areas: EraseArea[]): Promise<void> {
  const tab = current;
  if (!tab || !areas.length) return;
  const b = busy("Sletter teksten…");
  try {
    await bakeForms(tab);
    const { bytes, stats } = await eraseText(tab.bytes, areas);
    if (current !== tab) return;
    if (!stats.glyphs) {
      toast("Fant ingen tekst å slette her. Tekst som er tegnet som streker (vanlig i CAD-eksport), er ikke tekst.", "info");
      return;
    }
    await replaceContent(tab, bytes, Array.from({ length: tab.doc.numPages }, (_, i) => i), viewer.current);
    showCurrent();
    toast("Teksten er slettet. Ctrl+Z angrer.", "success");
  } catch (e) {
    toast(`Kunne ikke slette teksten: ${errorMessage(e)}`, "error");
  } finally {
    b.done();
  }
}

/** Finner Windows-fonten for en font i PDF-en (se fonts.ts). */
async function loadSystemFont(name: string): Promise<Uint8Array | null> {
  for (const file of fontFiles(name)) {
    const bytes = await readSystemFont(file);
    if (bytes) return bytes;
  }
  return null;
}

/** Bytter ut en tekstlinje i dokumentet (i minnet, som sideendringer: Ctrl+Z angrer). */
async function applyTextEdit(line: TextLine, text: string): Promise<void> {
  const tab = current;
  if (!tab) return;
  const b = busy("Endrer teksten…");
  try {
    await bakeForms(tab);
    const r = await replaceLine(tab.bytes, line, text, loadSystemFont);
    if (current !== tab) return;
    await replaceContent(tab, r.bytes, Array.from({ length: tab.doc.numPages }, (_, i) => i), viewer.current);
    showCurrent();
    const parts = [text ? "Teksten er endret." : "Teksten er slettet."];
    if (!r.removed) parts.push("Den gamle teksten kunne ikke fjernes fra fila og er dekket over med hvitt.");
    else if (text && r.originalFont && r.font !== r.originalFont) parts.push(`Fonten «${r.originalFont}» finnes ikke på PC-en, så den nye teksten er skrevet med ${r.font}.`);
    parts.push("Ctrl+Z angrer.");
    toast(parts.join(" "), r.removed ? "success" : "info");
  } catch (e) {
    toast(`Kunne ikke endre teksten: ${errorMessage(e)}`, "error");
  } finally {
    b.done();
  }
}

/**
 * Lagrer mål og markeringer i fila, sammen med sideendringer som bare finnes
 * i minnet, og åpner den på nytt på samme side (med verktøyet fortsatt på).
 */
async function saveAnnotations(saveAs = false): Promise<boolean> {
  const tab = current;
  if (!tab) return false;
  let path = tab.path;
  if (tab.unsaved || saveAs) {
    const target = await pickSavePath(saveAs ? tab.path.replace(/\.pdf$/i, " (endret).pdf") : path, tab.unsaved ? "Lagre PDF" : "Lagre som");
    if (!target || current !== tab) return false;
    path = target;
  } else if ((measure.dirty || markup.dirty || tab.modified) && !(await confirmSigned(tab))) return false;
  const page = viewer.current;
  const wasMeasuring = measure.active;
  const wasMarking = markup.active;
  const parts = [measure.dirty && "målene", markup.dirty && "markeringene", tab.formsDirty && "skjemaet"].filter((x): x is string => !!x);
  const what = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} og ${parts.at(-1)}` : (parts[0] ?? "dokumentet");
  const b = busy(`Lagrer ${what}…`);
  try {
    let bytes = await bytesWithForms(tab);
    if (measure.dirty) bytes = await measure.writeTo(bytes);
    if (markup.dirty) bytes = await markup.writeTo(bytes);
    await writeFile(path, bytes);
    await openPath(path, { page, bytes, replace: true });
    if (wasMeasuring) measure.open();
    if (wasMarking) markup.open();
    toast(`${what[0].toUpperCase()}${what.slice(1)} er lagret i fila`, "success");
    return true;
  } catch (e) {
    toast(`Kunne ikke lagre: ${errorMessage(e)}`, "error");
    return false;
  } finally {
    b.done();
  }
}

// Stripe over et dokument med endringer som bare finnes i minnet: et
// sammenslått dokument som ikke er lagret ennå, eller flyttede/slettede sider.
const barTitle = h("strong", {});
const barHint = h("span", { class: "muted hint" });
const barDiscard = button("Forkast", null, () => void discardChanges());
const barSaveAs = button("Lagre som…", null, () => void saveDoc(true), { title: "Lagre som ny fil (Ctrl+Shift+S)" });
const barSave = button("Lagre", "save", () => void saveDoc(), { primary: true, title: "Lagre (Ctrl+S)" });
const barFlatten = button("Lagre låst kopi…", null, () => void saveFlattened(), { title: "Lagre en kopi der de utfylte feltene og signaturene ikke kan endres (f.eks. før skjemaet sendes)" });
const unsavedBar = h("div", { class: "subbar unsaved-bar" }, barTitle, barHint, h("span", { class: "spacer" }), barDiscard, barFlatten, barSaveAs, barSave);

function updateDocBar(): void {
  const t = current;
  unsavedBar.hidden = !t || !(t.unsaved || t.modified || t.formsDirty);
  if (!t || unsavedBar.hidden) return;
  const onlyForms = t.formsDirty && !t.unsaved && !t.modified;
  barTitle.textContent = t.unsaved ? "Ikke lagret" : onlyForms ? "Skjema" : "Endret";
  barHint.textContent = t.unsaved
    ? "Dokumentet finnes ikke som fil ennå. Dra sidene i sidepanelet for å endre rekkefølgen, og lagre når det er klart."
    : onlyForms
      ? "Skjemaet er fylt ut. Verdiene skrives til fila først når du lagrer."
      : "Dokumentet er endret. Endringene skrives til fila først når du lagrer. Ctrl+Z angrer.";
  barFlatten.hidden = !viewer.hasForms;
  barDiscard.title = t.unsaved ? "Lukk uten å lagre" : "Forkast endringene og last fila på nytt";
  barSaveAs.hidden = t.unsaved;
  barSave.querySelector("span")!.textContent = t.unsaved ? "Lagre…" : "Lagre";
}

const presentBtn = docBtn(button("Presenter", "present", () => void startPresentation(), { title: "Fullskjerm-presentasjon (Ctrl+L)", className: "split-main" }));
const screenBtn = docBtn(button("", "caret", () => void openScreenMenu(), { title: "Velg skjerm for presentasjonen", className: "split-caret" }));

const toolbar = h(
  "header",
  { class: "toolbar" },
  button("Åpne", "open", () => void openDialog(), { title: "Åpne PDF, eller gjør bilder om til PDF (Ctrl+O)", className: "keep-label" }),
  button("Slå sammen", "merge", () => startMerge(), { title: "Slå sammen PDF-er og bilder (Ctrl+M)", className: "keep-label" }),
  h("span", { class: "sep" }),
  docBtn(button("Sorter sider", "organize", () => startOrganize(), { title: "Endre rekkefølge, roter eller slett sider (Ctrl+K)" })),
  docBtn(button("Til PNG", "image", () => startExport(), { title: "Eksporter sider som PNG-bilder (Ctrl+E)" })),
  docBtn(button("Skriv ut", "print", () => void startPrint(), { title: "Skriv ut (Ctrl+P)" })),
  docBtn(button("Reduser", "shrink", () => void startShrink(), { title: "Reduser filstørrelse: skaler ned bilder og fjern duplikater" })),
  measureBtn,
  markupBtn,
  signBtn,
  textEditBtn,
  redactBtn,
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
tabBar.addEventListener("pointermove", moveTabDrag);
tabBar.addEventListener("pointerup", endTabDrag);
tabBar.addEventListener("pointercancel", endTabDrag);
tabBar.addEventListener("lostpointercapture", endTabDrag);
app.append(tabBar, toolbar, h("main", {}, sidebar, content), dropOverlay);

function emptyState(): HTMLElement {
  const shortcuts: Array<[string, string]> = [
    ["Ctrl+O", "Åpne"],
    ["Ctrl+L", "Presenter i fullskjerm"],
    ["Ctrl+F", "Søk i teksten"],
    ["M", "Mål avstand og areal"],
    ["K", "Marker med sky, pil og tekst"],
    ["E", "Rediger tekst"],
    ["Ctrl+P", "Skriv ut"],
    ["Ctrl+M", "Slå sammen PDF-er"],
    ["Ctrl+K", "Sorter sider"],
    ["Ctrl+E", "Eksporter til PNG"],
  ];
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty-icon", html: logo() }),
    h("h1", { class: "wordmark", "aria-label": "ArkiPDF" }, "Arki", h("span", { class: "wordmark__pdf" }, "PDF")),
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
  markupBtn.classList.toggle("active", markup.active && !markup.signing);
  signBtn.classList.toggle("active", markup.signing);
  textEditBtn.classList.toggle("active", textEdit.active);
  redactBtn.classList.toggle("active", redactor.active);
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
  if (t.unsaved) r.push("nytt dokument som ikke er lagret");
  else if (t.modified) r.push("sidene er endret");
  const pending = [t.measure?.dirty && "mål", t.markup?.dirty && "markeringer"].filter(Boolean).join(" og ");
  if (pending) r.push(`${pending} som ikke er lagret i fila`);
  if (t.formsDirty) r.push("utfylte skjemafelt som ikke er lagret");
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
  await openPaths(await pickDocuments(true));
}

/** Åpner flere filer, hver i sin fane (én om gangen, så den siste vises til slutt). Bilder blir PDF-er. */
async function openPaths(paths: string[]): Promise<void> {
  for (const p of paths) await (IMAGE_FILE.test(p) ? openImage(p) : OFFICE_FILE.test(p) ? openOffice(p) : openPath(p));
}

/** Gjør et Word-, Excel- eller PowerPoint-dokument om til PDF (med Office på PC-en) og åpner resultatet. */
async function openOffice(path: string): Promise<void> {
  const b = busy(`Gjør ${baseName(path)} om til PDF med Office…`);
  try {
    const pdf = await convertOffice(path);
    b.done();
    await openPath(path.replace(OFFICE_FILE, ".pdf"), { page: 0, bytes: pdf, unsaved: true });
  } catch (e) {
    toast(`Kunne ikke gjøre ${baseName(path)} om til PDF: ${errorMessage(e)}`, "error");
  } finally {
    b.done();
  }
}

/** Gjør et bilde om til en PDF og åpner den som et nytt, ulagret dokument ved siden av bildet. */
async function openImage(path: string): Promise<void> {
  const b = busy(`Gjør ${baseName(path)} om til PDF…`);
  try {
    const name = baseName(path);
    const pdf = await imagesToPdf([{ name, bytes: (await openFile(path)).bytes }], normalizeImage);
    b.done();
    await openPath(path.replace(IMAGE_FILE, ".pdf"), { page: 0, bytes: pdf, unsaved: true });
  } catch (e) {
    toast(`Kunne ikke gjøre ${baseName(path)} om til PDF: ${errorMessage(e)}`, "error");
  } finally {
    b.done();
  }
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
    const tab: OpenDoc = { ...file, doc, thumbs: new ThumbCache(doc, 320), unsaved, view, measure: null, markup: null, formsDirty: false, signed: !unsaved && isSigned(file.bytes), modified: false, pageHistory: [] };
    if (old && tabs.includes(old)) {
      tabs[tabs.indexOf(old)] = tab;
      old.thumbs.dispose();
      void old.doc.loadingTask.destroy();
    } else {
      tabs.push(tab);
      leaveCurrent();
    }
    current = tab;
    watchForms(tab);
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
  // Feiler hvis en side fortsatt tegnes; da ryddes den neste gang.
  current.doc.cleanup().catch(() => {});
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
  const pending = [tab.measure?.dirty && "mål", tab.markup?.dirty && "markeringer", tab.formsDirty && "utfylte skjemafelt"].filter(Boolean).join(" og ");
  if (!tab.unsaved && !tab.modified && pending && !(await confirmDialog(`«${tab.name}» har ${pending} som ikke er lagret i fila. Lukke likevel?\n\n(Velg «Nei» og trykk Ctrl+S for å lagre.)`))) return;
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (tab === current) {
    current = tabs[Math.min(i, tabs.length - 1)] ?? null;
    if (!current) {
      measure.close();
      measure.setDocument(null, null);
      markup.close();
      markup.setDocument(null);
      textEdit.close();
      textEdit.setDocument(null);
      redactor.close();
      redactor.setDocument(null);
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

/** Fanen som dras for å endre rekkefølgen: der pekeren og fanen var da draingen startet. */
let tabDrag: { tab: OpenDoc; pointer: number; startX: number; startLeft: number; moved: boolean } | null = null;

const tabEls = () => Array.from(tabBar.querySelectorAll<HTMLElement>(".doc-tab"));

function startTabDrag(tab: OpenDoc, el: HTMLElement, e: PointerEvent): void {
  if (organizer) return;
  tabDrag = { tab, pointer: e.pointerId, startX: e.clientX, startLeft: el.offsetLeft, moved: false };
  // Fanelinja (som ikke tegnes på nytt) holder på pekeren, også utenfor vinduet.
  tabBar.setPointerCapture(e.pointerId);
}

/** Fanen følger pekeren og bytter plass med naboen når den passerer midten av den. */
function moveTabDrag(e: PointerEvent): void {
  const d = tabDrag;
  if (!d || e.pointerId !== d.pointer || !tabs.includes(d.tab)) return;
  const dx = e.clientX - d.startX;
  if (!d.moved && Math.abs(dx) < 5) return;
  d.moved = true;
  for (;;) {
    const els = tabEls();
    const i = tabs.indexOf(d.tab);
    const el = els[i];
    el.classList.add("dragging");
    const center = d.startLeft + dx + el.offsetWidth / 2;
    const next = els[i + 1];
    const prev = els[i - 1];
    const to = next && center > next.offsetLeft + next.offsetWidth / 2 ? i + 1 : prev && center < prev.offsetLeft + prev.offsetWidth / 2 ? i - 1 : i;
    if (to === i) {
      el.style.transform = `translateX(${d.startLeft + dx - el.offsetLeft}px)`;
      return;
    }
    if (to > i) next.after(el);
    else prev.before(el);
    tabs.splice(i, 1);
    tabs.splice(to, 0, d.tab);
  }
}

function endTabDrag(): void {
  const moved = tabDrag?.moved;
  tabDrag = null;
  if (!moved) return;
  tabsKey = "";
  renderTabs();
}

/** Høyreklikk på en fane. */
function openTabMenu(tab: OpenDoc, x: number, y: number): void {
  if (organizer) return;
  const item = (label: string, action: () => void, disabled = false) => {
    const b = h("button", { type: "button", class: "popover-item", disabled }, label);
    b.addEventListener("click", () => {
      close();
      action();
    });
    return b;
  };
  const canMove = isTauri && tabs.length > 1;
  const blocked = hasUnsaved(tab);
  const menu = h(
    "div",
    { class: "popover", role: "menu" },
    canMove ? item("Åpne i nytt vindu", () => void moveToNewWindow(tab), blocked) : null,
    canMove && blocked ? h("div", { class: "popover-note muted" }, "Lagre fanen først (Ctrl+S) for å åpne den i et nytt vindu.") : null,
    item("Lukk fane", () => void closeTab(tab)),
  );
  const close = showPopover(menu);
  // Ved pekeren, men innenfor vinduet.
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
}

/** Flytter en fane til et nytt vindu. Bare når alt i fanen er lagret, så ingenting går tapt. */
async function moveToNewWindow(tab: OpenDoc): Promise<void> {
  if (organizer || hasUnsaved(tab) || !tabs.includes(tab)) return;
  // Det nye vinduet åpner fila på siden som er husket.
  rememberFile(tab.path, tab.name, tab === current ? viewer.current : tab.view.page);
  try {
    await openInNewWindow([tab.path]);
  } catch (e) {
    toast(`Kunne ikke åpne et nytt vindu: ${errorMessage(e)}`, "error");
    return;
  }
  await closeTab(tab);
}

let tabsKey = "";
/** Tegner fanelinja på nytt når noe i den er endret. */
function renderTabs(): void {
  if (tabDrag?.moved) return;
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
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
        startTabDrag(t, el, e);
        activate(t);
      });
      el.addEventListener("mousedown", (e) => {
        if (e.button === 1) e.preventDefault();
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openTabMenu(t, e.clientX, e.clientY);
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
  content.replaceChildren(unsavedBar, measure.bar, markup.bar, textEdit.bar, redactor.bar, viewer.el, search.el, measure.panel, markup.panel);
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
    textEdit.setDocument(tab.doc);
    redactor.setDocument(tab.doc);
    if (tab.markup) markup.useDocument(tab.markup);
    else {
      markup.close();
      markup.setDocument(tab.bytes);
      tab.markup = markup.state;
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
  // Mål og markeringer som ikke er lagret ennå, vises også.
  const { doc, temporary } = await withPending(current);
  presentation = new Presentation(doc, viewer.rotation);
  presentation.onExit = (page) => {
    viewer.goToPage(page);
    viewer.el.focus();
    if (temporary) void doc.loadingTask.destroy();
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
  const close = showPopover(menu);
}

/** Viser en liten meny som lukkes ved klikk utenfor eller Esc. Gir tilbake funksjonen som lukker den. */
function showPopover(menu: HTMLElement): () => void {
  document.querySelector(".popover")?.remove();
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
  (menu.querySelector(".popover-item:not(:disabled)") as HTMLElement | null)?.focus();
  return close;
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
  closeModes();
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
    await bakeForms(tab);
    const out = await rearrangePages(tab.bytes, items, tab.name);
    await replaceContent(tab, out, items.map((it) => it.src), focus);
    thumbSel = new Set(select);
    thumbAnchor = select[0] ?? -1;
    organizer = null;
    showCurrent();
    return true;
  } catch (e) {
    toast(`Kunne ikke endre sidene: ${errorMessage(e)}`, "error");
    return false;
  } finally {
    b.done();
  }
}

/**
 * Gir fanen nytt innhold i minnet (kan angres med Ctrl+Z). `order` er den
 * opprinnelige indeksen til hver side i det nye dokumentet; målene følger med.
 */
async function replaceContent(tab: OpenDoc, bytes: Uint8Array, order: number[], focus: number): Promise<void> {
  const doc = await loadPdf(bytes);
  tab.pageHistory.push({ bytes: tab.bytes, measure: tab.measure ? copyMeasureDoc(tab.measure) : null, markup: tab.markup ? copyMarkupDoc(tab.markup) : null, modified: tab.modified });
  if (tab.pageHistory.length > 30) tab.pageHistory.shift();
  if (tab.measure) reorderMeasureDoc(tab.measure, order, doc);
  if (tab.markup) reorderMarkupDoc(tab.markup, order);
  const old = swapDoc(tab, bytes, doc, focus);
  tab.modified = !tab.unsaved;
  void updateTitle();
  void old.loadingTask.destroy();
}

/** «Reduser filstørrelse»: resultatet vises før det lagres, som andre endringer. */
async function startShrink(): Promise<void> {
  const tab = current;
  if (!tab) return;
  await bakeForms(tab);
  openShrinkDialog(tab.bytes, tab.name, async (out) => {
    if (current !== tab) return;
    const n = tab.doc.numPages;
    await replaceContent(tab, out, Array.from({ length: n }, (_, i) => i), viewer.current);
    thumbSel.clear();
    showCurrent();
  });
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
    tab.markup = prev.markup;
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
  watchForms(tab);
  return old;
}

// ---------- Skjemautfylling ----------

/** Følger med på om skjemafeltene i fanens dokument blir fylt ut. */
function watchForms(tab: OpenDoc): void {
  // Typene til pdf.js sier null, men feltene er ment å settes.
  const storage = tab.doc.annotationStorage as unknown as { onSetModified: (() => void) | null; onResetModified: (() => void) | null };
  tab.formsDirty = false;
  storage.onSetModified = () => {
    tab.formsDirty = true;
    if (tab === current) void updateTitle();
    refresh();
  };
  // pdf.js nullstiller «endret» når den skriver dokumentet (også for utskrift og
  // låst kopi), men verdiene er ikke lagret i fila før vi selv lagrer den.
  storage.onResetModified = null;
}

/** Dokumentet med de utfylte skjemaverdiene (pdf.js skriver dem og utseendet deres inn i fila). */
async function bytesWithForms(tab: OpenDoc): Promise<Uint8Array> {
  return tab.formsDirty ? tab.doc.saveDocument() : tab.bytes;
}

/**
 * Før sidene endres eller fila komprimeres: skriv de utfylte verdiene inn i
 * bytene i minnet, så de følger med over i det nye dokumentet.
 */
async function bakeForms(tab: OpenDoc): Promise<void> {
  if (!tab.formsDirty) return;
  tab.bytes = await tab.doc.saveDocument();
  tab.formsDirty = false;
  tab.modified = !tab.unsaved;
}

/**
 * Lagrer en kopi der skjemafeltene og signaturene er gjort om til vanlig
 * innhold, så mottakeren ikke kan endre, flytte eller slette dem.
 */
async function saveFlattened(): Promise<void> {
  const tab = current;
  if (!tab) return;
  const target = await pickSavePath(tab.path.replace(/\.pdf$/i, " (låst).pdf"), "Lagre låst kopi");
  if (!target || current !== tab) return;
  const b = busy("Lagrer låst kopi…");
  try {
    let bytes = await bytesWithForms(tab);
    if (measure.dirty) bytes = await measure.writeTo(bytes);
    if (markup.dirty) bytes = await markup.writeTo(bytes);
    if (viewer.hasForms) bytes = await flattenForm(bytes);
    const signed = await flattenSignatures(bytes);
    await writeFile(target, signed.bytes);
    const what = [viewer.hasForms && "skjemafeltene", signed.count && (signed.count === 1 ? "signaturen" : "signaturene")].filter(Boolean).join(" og ") || "innholdet";
    toast(`Låst kopi lagret: ${baseName(target)}. I kopien kan ${what} ikke endres. Dokumentet her er fortsatt åpent for endringer.`, "success");
  } catch (e) {
    toast(`Kunne ikke lagre låst kopi: ${errorMessage(e)}`, "error");
  } finally {
    b.done();
  }
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

/**
 * Før en signert PDF overskrives: mål, markeringer og sideendringer skriver
 * fila på nytt, og da blir den digitale signaturen ugyldig. (Utfylte skjema
 * lagres som et tillegg til fila og beholder signaturen.)
 */
async function confirmSigned(tab: OpenDoc): Promise<boolean> {
  if (!tab.signed) return true;
  return confirmDialog(
    `«${tab.name}» er signert digitalt. Lagrer du endringene i denne fila, blir signaturen ugyldig.\n\nLagre likevel?\n\n(Velg «Nei» og bruk «Lagre som…» for å beholde originalen med gyldig signatur.)`,
  );
}

/** Lagrer dokumentet (Ctrl+S), eller som ny fil (Ctrl+Shift+S). Mål som ikke er lagret, blir med. */
async function saveDoc(saveAs = false): Promise<void> {
  const tab = current;
  if (!tab) return;
  // Mål og markeringer skrives inn i hele dokumentet, med sideendringene, som så åpnes på nytt.
  if (measure.dirty || markup.dirty || tab.formsDirty) return void (await saveAnnotations(saveAs));
  if (tab.unsaved) return saveUnsaved();
  if (!tab.modified && !saveAs) return;
  if (!saveAs && !(await confirmSigned(tab))) return;
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

/** Lagrer et nytt dokument (sammenslått eller laget av bilder) som ikke er lagret ennå. */
async function saveUnsaved(): Promise<void> {
  const doc = current;
  if (!doc?.unsaved) return;
  const target = await pickSavePath(doc.path, "Lagre PDF");
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


async function startPrint(): Promise<void> {
  const tab = current;
  if (!tab || organizer) return;
  // Utskriften tar med det som ikke er lagret ennå: utfylte felt, mål og markeringer.
  const { doc, bytes } = await withPending(tab);
  openPrintDialog(doc, bytes, tab.name, viewer.current);
}

/**
 * Dokumentet slik det blir når det lagres (for utskrift og presentasjon).
 * Uten ulagrede mål eller markeringer er det fanens eget dokument.
 */
async function withPending(tab: OpenDoc): Promise<{ doc: PDFDocumentProxy; bytes: Uint8Array; temporary: boolean }> {
  const bytes = await bytesWithForms(tab);
  if (!measure.dirty && !markup.dirty) return { doc: tab.doc, bytes, temporary: false };
  const b = busy("Gjør klar…");
  try {
    let out = bytes;
    if (measure.dirty) out = await measure.writeTo(out);
    if (markup.dirty) out = await markup.writeTo(out);
    return { doc: await loadPdf(out), bytes: out, temporary: true };
  } catch {
    return { doc: tab.doc, bytes, temporary: false };
  } finally {
    b.done();
  }
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
  // Markering likeså (S/P/T, Esc, Delete, Ctrl+Z).
  if (markup.active && current && !typing(e.target) && markup.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if (textEdit.active && current && !typing(e.target) && textEdit.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if (redactor.active && current && !typing(e.target) && redactor.handleKey(e)) {
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
  else if (ctrl && k === "p") void startPrint();
  else if (!current) handled = false;
  else if (ctrl && k === "w") void closeTab(current);
  else if (ctrl && (e.key === "Tab" || e.key === "PageDown" || e.key === "PageUp")) cycleTab(e.key === "PageUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1);
  else if (ctrl && k === "s") void saveDoc(e.shiftKey);
  // I et skjemafelt angrer Ctrl+Z skrivingen, ikke sideendringer. Siste tekstmarkering angres først.
  else if (ctrl && k === "z" && !typing(e.target) && (markup.state.quick.length || current.pageHistory.length)) {
    if (!markup.undoQuick()) void undoPages();
  }
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
  else if (k === "m") toggleMeasure();
  else if (k === "k") toggleMarkup();
  else if (k === "e") toggleTextEdit();
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
// Litt etter oppstart, så det ikke konkurrerer med å åpne filer.
setTimeout(() => void checkForUpdates(), 5000);
// ArkiPDF kjører i ett vindu: filer som åpnes mens det er åpent, kommer hit.
onLaunchFiles(openLaunched);
