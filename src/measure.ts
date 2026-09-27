// Måling (M): avstand, lengde (polylinje) og areal på tegninger.
//
// Punktene lagres i PDF-koordinater, så målene ligger fast på tegningen
// uansett zoom og rotasjon. Målestokk hentes fra PDF-en når den er lagt inn
// (Revit, ArchiCAD m.fl.), ellers velger man den selv eller kalibrerer mot
// et kjent mål.
import {
  centroid,
  distance,
  formatArea,
  formatLength,
  formatPaper,
  insertionPoint,
  insidePolygon,
  metersPerPointForScale,
  pathDistance,
  pathLength,
  PAPER_METERS_PER_POINT,
  polygonArea,
  regionAt,
  scaleLabel,
  snap45,
  type PdfScaleRegion,
  type Pt,
} from "./measure-math";
import { readMeasureData, writeMeasurements, type WritableMeasurement } from "./measure-pdf";
import type { PDFDocumentProxy } from "./pdf";
import { SnapIndex, type SnapHit } from "./snap";
import { button, errorMessage, h, modal, toast } from "./ui";
import type { PageGeometry, Viewer } from "./viewer";

export type MeasureKind = "distance" | "length" | "area";
type Unit = "m" | "mm";

interface Scale {
  metersPerPoint: number;
  label: string;
}

interface Measurement {
  id: number;
  page: number;
  kind: MeasureKind;
  points: Pt[];
  /** Målestokk fra PDF-en der målet startet; ellers gjelder sidens målestokk. */
  fixed: Scale | null;
}

/** Alt som hører til ett dokument: mål, målestokk, angrehistorikk og snapdata. */
export interface MeasureDoc {
  doc: PDFDocumentProxy | null;
  pdfScales: Map<number, PdfScaleRegion[]>;
  pageScale: Map<number, Scale>;
  defaultScale: Scale | null;
  items: Measurement[];
  selected: number | null;
  /** Tidligere tilstander for Ctrl+Z. */
  history: Measurement[][];
  /** Målene er annerledes enn i fila (se `measureSignature`). */
  dirty: boolean;
  /** Slik målene var sist de ble lest fra eller lagret i fila. */
  saved: { items: Measurement[]; pageScale: Map<number, Scale>; defaultScale: Scale | null };
  snaps: Map<number, SnapIndex | null>;
  snapLoading: Set<number>;
}

/**
 * Fingeravtrykk av målene, for å se om de er endret siden de ble lagret.
 * Uten mål teller ikke målestokken: å bare velge målestokk er ingen endring
 * som må lagres (den lagres uansett sammen med neste mål).
 */
function measureSignature(m: { items: Measurement[]; pageScale: Map<number, Scale>; defaultScale: Scale | null }): string {
  if (!m.items.length) return "";
  return JSON.stringify({
    items: m.items.map((x) => [x.page, x.kind, x.points, x.fixed]),
    scales: [...m.pageScale].sort((a, b) => a[0] - b[0]),
    def: m.defaultScale,
  });
}

/** Husker målene som lagret (etter lesing fra eller lagring til fila). */
function markSaved(st: MeasureDoc): void {
  // Egne kopier: målene endres på stedet når de dras.
  st.saved = { items: st.items.map((m) => ({ ...m, points: m.points.map((p) => [p[0], p[1]] as Pt) })), pageScale: new Map(st.pageScale), defaultScale: st.defaultScale };
  st.dirty = false;
}

function newMeasureDoc(doc: PDFDocumentProxy | null): MeasureDoc {
  return {
    doc,
    pdfScales: new Map(),
    pageScale: new Map(),
    defaultScale: null,
    items: [],
    selected: null,
    history: [],
    dirty: false,
    saved: { items: [], pageScale: new Map(), defaultScale: null },
    snaps: new Map(),
    snapLoading: new Set(),
  };
}

/** Kopi av målene i et dokument (for å kunne angre en endring av sidene). */
export function copyMeasureDoc(st: MeasureDoc): MeasureDoc {
  return {
    ...st,
    pdfScales: new Map(st.pdfScales),
    pageScale: new Map(st.pageScale),
    items: st.items.map((m) => ({ ...m, points: m.points.map((p) => [p[0], p[1]] as Pt) })),
    history: [],
    snaps: new Map(),
    snapLoading: new Set(),
  };
}

/**
 * Sidene har fått ny rekkefølge (eller noen er slettet): `order[i]` er den
 * gamle indeksen til ny side `i`. Målene følger sidene sine; mål på slettede
 * sider forsvinner. Punktene er i PDF-koordinater og endres ikke.
 */
export function reorderMeasureDoc(st: MeasureDoc, order: number[], doc: PDFDocumentProxy): void {
  const moved = new Map(order.map((old, i) => [old, i]));
  const remap = <T>(m: Map<number, T>) => new Map([...m].flatMap(([k, v]) => (moved.has(k) ? [[moved.get(k)!, v] as [number, T]] : [])));
  const move = (items: Measurement[]) => items.filter((m) => moved.has(m.page)).map((m) => ({ ...m, page: moved.get(m.page)! }));
  st.items = move(st.items);
  st.pageScale = remap(st.pageScale);
  // Målene som ligger i fila, flytter med sidene sine når dokumentet lagres.
  st.saved = { items: move(st.saved.items), pageScale: remap(st.saved.pageScale), defaultScale: st.saved.defaultScale };
  st.pdfScales = remap(st.pdfScales);
  if (!st.items.some((m) => m.id === st.selected)) st.selected = null;
  // Angring av enkeltmål gjelder den gamle siderekkefølgen.
  st.history = [];
  st.snaps = new Map();
  st.snapLoading = new Set();
  st.doc = doc;
}

interface Layer {
  el: HTMLDivElement;
  svg: SVGSVGElement;
  labels: HTMLDivElement;
  marker: HTMLDivElement;
  geom: PageGeometry;
}

const SNAP_NAMES: Record<SnapHit["kind"], string> = { vertex: "Hjørne", mid: "Midtpunkt", cross: "Skjæring", line: "På linje" };

const SVG = "http://www.w3.org/2000/svg";
const PRESETS = [1, 5, 10, 20, 50, 100, 200, 250, 500, 1000, 2000];
const KIND_NAMES: Record<MeasureKind, string> = { distance: "Avstand", length: "Lengde", area: "Areal" };

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ikke kritisk */
    }
  },
};

export class Measure {
  readonly bar: HTMLDivElement;
  readonly panel: HTMLDivElement;
  active = false;
  private kind: MeasureKind = "distance";
  private unit: Unit = store.get("measureUnit") === "mm" ? "mm" : "m";
  /** Målene og målestokken for dokumentet som vises (se `MeasureDoc`). */
  private s: MeasureDoc = newMeasureDoc(null);
  private nextId = 1;
  private drawing: { page: number; points: Pt[] } | null = null;
  private calibrating = false;
  private cursor: { page: number; p: Pt } | null = null;
  private layers = new Map<number, Layer>();
  private toolBefore: "select" | "hand" = "select";
  private down: { x: number; y: number } | null = null;
  /** Et mål som dras: ett punkt (`node`) eller hele målet (`node` er null). */
  private grab: { id: number; page: number; node: number | null; via: "node" | "edge" | "label" | "inside"; x: number; y: number; from: Pt; points: Pt[]; moved: boolean } | null = null;
  private snapOn = store.get("measureSnap") !== "0";
  private lastSnap: { page: number; hit: SnapHit } | null = null;
  /** Endringer som ikke er lagret i fila (for dokumentet som vises). */
  get dirty(): boolean {
    return this.s.dirty;
  }
  set dirty(v: boolean) {
    if (v) this.s.dirty = true;
    else markSaved(this.s);
  }
  /** Kalles med nye filbytes når målene skal lagres. */
  onSave: ((bytes: Uint8Array) => Promise<boolean | void>) | null = null;
  private saveBtn: HTMLButtonElement;

  private kindButtons: Record<MeasureKind, HTMLButtonElement>;
  private scaleSelect: HTMLSelectElement;
  private unitSelect: HTMLSelectElement;
  private scaleInfo: HTMLSpanElement;
  private hint: HTMLSpanElement;
  private list: HTMLOListElement;
  private totals: HTMLDivElement;
  private count: HTMLSpanElement;

  onChange: () => void = () => {};

  constructor(private readonly viewer: Viewer) {
    const kindBtn = (k: MeasureKind, iconName: string, key: string) =>
      button(KIND_NAMES[k], iconName, () => this.setKind(k), { title: `${KIND_NAMES[k]} (${key})`, className: "ghost tool" });
    this.kindButtons = {
      distance: kindBtn("distance", "ruler", "D"),
      length: kindBtn("length", "polyline", "L"),
      area: kindBtn("area", "area", "A"),
    };
    this.scaleSelect = h("select", { "aria-label": "Målestokk", title: "Målestokk for denne siden (og sider uten egen målestokk)" });
    this.scaleSelect.addEventListener("change", () => this.onScaleSelect());
    this.unitSelect = h("select", { "aria-label": "Enhet" }, h("option", { value: "m" }, "meter"), h("option", { value: "mm" }, "millimeter"));
    this.unitSelect.value = this.unit;
    this.unitSelect.addEventListener("change", () => {
      this.unit = this.unitSelect.value as Unit;
      store.set("measureUnit", this.unit);
      this.redrawAll();
    });
    this.scaleInfo = h("span", { class: "scale-info" });
    const snapBox = h("input", { type: "checkbox", checked: this.snapOn });
    snapBox.addEventListener("change", () => {
      this.snapOn = snapBox.checked;
      store.set("measureSnap", this.snapOn ? "1" : "0");
      this.showMarker(null);
    });
    this.hint = h("span", { class: "measure-hint muted" });

    this.bar = h(
      "div",
      { class: "subbar measure-bar", hidden: true },
      h("strong", {}, "Mål"),
      h("span", { class: "tool-group" }, this.kindButtons.distance, this.kindButtons.length, this.kindButtons.area),
      h("span", { class: "sep" }),
      h("label", { class: "inline-field" }, h("span", {}, "Målestokk"), this.scaleSelect),
      this.scaleInfo,
      h("label", { class: "inline-field" }, h("span", {}, "Enhet"), this.unitSelect),
      h("label", { class: "inline-field check", title: "Fest punktene til hjørner, midtpunkter og linjer i tegningen. Hold Alt for å slå av midlertidig." }, snapBox, h("span", {}, "Fest til tegningen")),
      h("span", { class: "spacer" }),
      this.hint,
      button("", "close", () => this.close(), { title: "Avslutt måling (Esc)", className: "ghost" }),
    );

    this.list = h("ol", { class: "measure-list" });
    this.totals = h("div", { class: "measure-totals" });
    this.count = h("span", {});
    this.saveBtn = button("Lagre", "save", () => void this.save(), { title: "Lagre målene i PDF-fila (Ctrl+S)", className: "save-btn" });
    this.panel = h(
      "div",
      { class: "measure-panel", hidden: true },
      h(
        "header",
        {},
        h("strong", {}, "Mål ", this.count),
        this.saveBtn,
        button("", "copy", () => void this.copyTable(), { title: "Kopier som tabell (lim inn i Excel)", className: "ghost" }),
        button("", "trash", () => this.clearAll(), { title: "Fjern alle mål", className: "ghost" }),
      ),
      this.list,
      this.totals,
    );

    this.setupPointer();
    viewer.onPageRendered = (page, pageEl, geom) => this.attach(page, pageEl, geom);
    this.setKind(this.kind);
  }

  // ---------- Dokument og modus ----------

  /**
   * Nytt dokument: ny, tom tilstand, og les i bakgrunnen innebygd målestokk
   * og mål som er lagret i fila tidligere. Tilstanden hentes med `state` og
   * kan tas i bruk igjen med `useDocument` (faner).
   */
  setDocument(bytes: Uint8Array | null, doc: PDFDocumentProxy | null): void {
    const st = newMeasureDoc(doc);
    this.useDocument(st);
    if (!bytes) return;
    readMeasureData(bytes)
      .then((data) => {
        // Resultatet hører til dette dokumentet, også om en annen fane vises nå.
        st.pdfScales = data.scales;
        for (const [page, sc] of data.pageScales) st.pageScale.set(page, sc);
        st.defaultScale = data.defaultScale;
        st.items = data.measurements.map((m) => ({ ...m, id: this.nextId++ }));
        markSaved(st);
        if (this.s !== st) return;
        this.refreshScaleUi();
        this.redrawAll();
        this.onChange();
      })
      .catch(() => {
        /* Uleselig eller kryptert: da finnes bare manuell målestokk. */
      });
  }

  /** Målene og målestokken for dokumentet som vises. */
  get state(): MeasureDoc {
    return this.s;
  }

  /** Bytter til et dokument som har vært vist før (f.eks. en annen fane), med målene det hadde. */
  useDocument(st: MeasureDoc): void {
    if (this.drawing || this.calibrating) this.cancelDrawing();
    this.s = st;
    this.grab = null;
    this.down = null;
    this.drawing = null;
    this.calibrating = false;
    this.cursor = null;
    this.layers.clear();
    this.lastSnap = null;
    this.refreshPanel();
    this.refreshScaleUi();
    this.updateHint();
  }

  /** Husker målene slik de er nå, så neste endring kan angres. */
  private remember(): void {
    this.s.history.push(this.s.items.map((m) => ({ ...m, points: m.points.map((p) => [p[0], p[1]] as Pt) })));
    if (this.s.history.length > 100) this.s.history.shift();
  }

  private undo(): void {
    const prev = this.s.history.pop();
    if (!prev) return;
    const pages = new Set([...this.s.items, ...prev].map((m) => m.page));
    this.s.items = prev;
    if (!prev.some((m) => m.id === this.s.selected)) this.s.selected = null;
    for (const p of pages) this.redraw(p);
    this.markDirty();
    this.updateHint();
  }

  /** Etter en endring: er målene nå annerledes enn i fila? (Angrer man tilbake, er de ikke det.) */
  private markDirty(): void {
    const dirty = measureSignature(this.s) !== measureSignature(this.s.saved);
    const changed = dirty !== this.s.dirty;
    this.s.dirty = dirty;
    if (changed) this.onChange();
    this.refreshPanel();
  }

  /** Skriver målene inn i PDF-fila. */
  async save(): Promise<void> {
    if (!this.onSave || !this.bytesSource) return;
    const items: WritableMeasurement[] = this.s.items.map((m) => {
      const d = this.describe(m);
      const scale = m.fixed ?? this.scaleFor(m.page);
      return {
        page: m.page,
        kind: m.kind,
        points: m.points,
        fixed: m.fixed,
        metersPerPoint: scale?.metersPerPoint ?? null,
        scaleLabel: scale?.label ?? null,
        text: d.main,
        subText: d.sub,
      };
    });
    try {
      const out = await writeMeasurements(this.bytesSource(), items, this.s.pageScale, this.s.defaultScale);
      // `false`: brukeren avbrøt (f.eks. valg av filnavn), målene er fortsatt ulagret.
      if ((await this.onSave(out)) !== false) this.dirty = false;
    } catch (e) {
      toast(`Kunne ikke lagre målene: ${errorMessage(e)}`, "error");
    }
  }

  /** Henter gjeldende filbytes (settes av hovedprogrammet). */
  bytesSource: (() => Uint8Array) | null = null;

  toggle(): void {
    if (this.active) this.close();
    else this.open();
  }

  open(): void {
    if (this.active) return;
    this.active = true;
    this.toolBefore = this.viewer.tool;
    this.viewer.tool = "select";
    this.viewer.el.classList.add("measuring");
    this.bar.hidden = false;
    this.panel.hidden = this.s.items.length === 0 && !this.dirty;
    this.refreshScaleUi();
    this.updateHint();
    this.onChange();
  }

  close(): void {
    if (!this.active) return;
    this.cancelDrawing();
    this.active = false;
    this.viewer.el.classList.remove("measuring");
    this.viewer.tool = this.toolBefore;
    this.bar.hidden = true;
    this.panel.hidden = true;
    this.onChange();
  }

  private setKind(k: MeasureKind): void {
    this.cancelDrawing();
    this.kind = k;
    for (const [key, b] of Object.entries(this.kindButtons)) b.classList.toggle("active", key === k);
    this.updateHint();
  }

  /** Oppdaterer målestokkvisningen når man blar til en annen side. */
  pageChanged(): void {
    if (this.active) this.refreshScaleUi();
  }

  // ---------- Målestokk ----------

  private scaleFor(page: number): Scale | null {
    return this.s.pageScale.get(page) ?? this.s.defaultScale;
  }

  private metersPerPoint(m: Measurement): number | null {
    return m.fixed?.metersPerPoint ?? this.scaleFor(m.page)?.metersPerPoint ?? null;
  }

  private refreshScaleUi(): void {
    const page = this.viewer.current;
    const current = this.scaleFor(page);
    const opts: HTMLOptionElement[] = [h("option", { value: "none" }, this.s.pdfScales.get(page)?.length ? "Ikke valgt" : "Ikke valgt (mål på arket)")];
    let selected = "none";
    for (const den of PRESETS) {
      const value = String(den);
      opts.push(h("option", { value }, `1:${den}`));
      if (current && Math.abs(current.metersPerPoint - metersPerPointForScale(den)) < 1e-12) selected = value;
    }
    if (current && selected === "none") {
      opts.push(h("option", { value: "current" }, current.label));
      selected = "current";
    }
    opts.push(h("option", { value: "custom" }, "Annen målestokk…"), h("option", { value: "calibrate" }, "Kalibrer mot kjent mål…"));
    this.scaleSelect.replaceChildren(...opts);
    this.scaleSelect.value = selected;

    const regions = this.s.pdfScales.get(page);
    if (regions?.length) {
      const labels = [...new Set(regions.map((r) => r.label))].join(", ");
      this.scaleInfo.textContent = `Fra PDF: ${labels}`;
      this.scaleInfo.title = "Tegningen har innebygd målestokk. Den brukes automatisk for mål innenfor tegningsområdet; valget til venstre gjelder utenfor.";
      this.scaleInfo.hidden = false;
    } else this.scaleInfo.hidden = true;
  }

  private setScale(scale: Scale | null): void {
    const page = this.viewer.current;
    // Valget gjelder denne siden og alle sider uten egen målestokk.
    if (scale) this.s.pageScale.set(page, scale);
    else this.s.pageScale.delete(page);
    this.s.defaultScale = scale;
    this.refreshScaleUi();
    this.redrawAll();
    this.markDirty();
  }

  private onScaleSelect(): void {
    const v = this.scaleSelect.value;
    if (v === "none") this.setScale(null);
    else if (v === "calibrate") this.startCalibration();
    else if (v === "custom") this.askCustomScale();
    else if (v !== "current") this.setScale({ metersPerPoint: metersPerPointForScale(Number(v)), label: `1:${v}` });
    this.scaleSelect.blur();
  }

  private askCustomScale(): void {
    const input = h("input", { type: "text", inputmode: "decimal", placeholder: "f.eks. 75", class: "range" });
    const ok = () => {
      const den = Number(input.value.replace(",", ".").replace(/^1\s*:\s*/, ""));
      if (!(den > 0)) {
        toast("Skriv et tall større enn 0", "error");
        return;
      }
      close();
      this.setScale({ metersPerPoint: metersPerPointForScale(den), label: `1:${den.toLocaleString("nb-NO")}` });
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && ok());
    const body = h("div", { class: "form" }, h("label", { class: "field" }, h("span", {}, "Målestokk 1:"), input));
    const close = modal("Annen målestokk", body, [button("Avbryt", null, () => close()), button("Bruk", null, ok, { primary: true })], () => this.refreshScaleUi());
  }

  private startCalibration(): void {
    this.cancelDrawing();
    this.calibrating = true;
    this.updateHint();
    toast("Klikk på to punkter på et mål du kjenner lengden på.");
  }

  private finishCalibration(page: number, a: Pt, b: Pt): void {
    this.calibrating = false;
    this.drawing = null;
    this.updateHint();
    const pts = distance(a, b);
    if (pts < 1) return;
    const input = h("input", { type: "text", inputmode: "decimal", placeholder: "f.eks. 5,4" });
    const unit = h("select", { "aria-label": "Enhet" }, h("option", { value: "m" }, "meter"), h("option", { value: "mm" }, "millimeter"));
    unit.value = this.unit;
    const preview = h("p", { class: "muted" }, " ");
    const read = () => {
      const n = Number(input.value.replace(",", "."));
      return n > 0 ? (unit.value === "mm" ? n / 1000 : n) : null;
    };
    const update = () => {
      const m = read();
      preview.textContent = m ? `Gir målestokk ca. ${scaleLabel(m / pts)} (når arket skrives ut i full størrelse).` : " ";
    };
    input.addEventListener("input", update);
    unit.addEventListener("change", update);
    const ok = () => {
      const m = read();
      if (!m) {
        toast("Skriv lengden som et tall", "error");
        return;
      }
      close();
      const k = m / pts;
      this.setScale({ metersPerPoint: k, label: `Kalibrert (≈ ${scaleLabel(k)})` });
      toast(`Kalibrert: ${formatPaper(pts)} = ${formatLength(m, this.unit)}`, "success");
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && ok());
    const body = h(
      "div",
      { class: "form" },
      h("p", {}, `Linjen du klikket er ${formatPaper(pts)}. Hvor lang er den i virkeligheten?`),
      h("div", { class: "row" }, input, unit),
      preview,
    );
    const close = modal("Kalibrer målestokk", body, [button("Avbryt", null, () => close()), button("Bruk", null, ok, { primary: true })], () => {
      this.refreshScaleUi();
      this.redraw(page);
    });
  }

  // ---------- Mus ----------

  private setupPointer(): void {
    const el = this.viewer.el;
    el.addEventListener("pointerdown", (e) => {
      if (!this.active || e.button !== 0 || this.viewer.panKeyHeld || this.viewer.tool === "hand") return;
      // Ikke marker tekst i PDF-en når man klikker eller drar under måling
      // (men la rullefeltet være i fred).
      if ((e.target as HTMLElement).closest(".page")) e.preventDefault();
      el.focus({ preventScroll: true });
      this.down = { x: e.clientX, y: e.clientY };
      if (this.drawing || this.calibrating) return;
      const t = this.grabTarget(e);
      const m = t && this.s.items.find((x) => x.id === t.id);
      const from = m && this.hitPage(e, m.page);
      if (!t || !m || !from) return;
      this.grab = { ...t, page: m.page, x: e.clientX, y: e.clientY, from: from.p, points: m.points.map((p) => [p[0], p[1]] as Pt), moved: false };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointerup", (e) => {
      const d = this.down;
      const g = this.grab;
      this.down = null;
      this.grab = null;
      if (!this.active || !d || e.button !== 0) return;
      if (g) {
        el.classList.remove("m-dragging");
        if (g.moved) {
          this.markDirty();
          return;
        }
        // Klikk på etiketten eller inne i flaten velger målet, og klikk på
        // kanten beholder valget (dobbeltklikk der gir nytt punkt). Klikk på et
        // punkt uten å dra starter et nytt mål der, som før.
        if (g.via === "edge") return;
        if (g.via !== "node") return this.select(g.id, false);
      }
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      // Mens et mål holdes, går hendelsene til visningen; bruk målets side.
      const hit = this.resolve(e, g?.page);
      if (hit) this.click(hit.page, hit.p, e.shiftKey && !hit.snapped);
    });
    el.addEventListener("pointercancel", () => {
      const g = this.grab;
      this.grab = null;
      this.down = null;
      el.classList.remove("m-dragging");
      if (g?.moved) this.markDirty();
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.active) return;
      if (this.grab) return this.drag(e, this.grab);
      if (!this.drawing && !this.calibrating) {
        const t = e.buttons ? null : this.grabTarget(e);
        el.dataset.mhover = t ? (t.via === "node" ? "node" : "body") : "";
      }
      const hit = this.resolve(e);
      if (!hit || (this.drawing && hit.page !== this.drawing.page)) return;
      if (!this.drawing && !this.calibrating) return;
      let p = hit.p;
      const last = this.drawing?.points.at(-1);
      if (last && e.shiftKey && !hit.snapped) p = snap45(last, p);
      this.cursor = { page: hit.page, p };
      this.drawPreview(hit.page);
    });
    el.addEventListener("pointerleave", () => this.showMarker(null));
    el.addEventListener("dblclick", (e) => {
      if (!this.active) return;
      e.preventDefault();
      if (this.drawing && this.kind !== "distance") this.finish();
      else if (!this.drawing && !this.calibrating) this.insertNode(e);
    });
  }

  /**
   * Dobbeltklikk på kanten av valgt lengde- eller arealmål gir et nytt punkt.
   * (Hendelsen kan gå til visningen etter at musa ble holdt, så punktet
   * regnes ut fra målets side.)
   */
  private insertNode(e: MouseEvent): void {
    const m = this.s.items.find((x) => x.id === this.s.selected);
    const hit = m && m.kind !== "distance" ? this.hitPage(e, m.page) : null;
    if (!m || !hit) return;
    const ppp = this.pointsPerPixel(m.page);
    if (pathDistance(hit.p, m.points, m.kind === "area") > ppp * 6) return;
    if (m.points.some((p) => distance(p, hit.p) <= ppp * 8)) return;
    const { index, p } = insertionPoint(hit.p, m.points, m.kind === "area");
    this.remember();
    m.points = [...m.points.slice(0, index), p, ...m.points.slice(index)];
    this.redraw(m.page);
    this.markDirty();
  }

  /** Flytter et punkt eller hele målet mens det dras. */
  private drag(e: PointerEvent, g: NonNullable<Measure["grab"]>): void {
    if (!g.moved) {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) <= 4) return;
      g.moved = true;
      this.remember();
      this.viewer.el.classList.add("m-dragging");
      if (this.s.selected !== g.id) {
        this.s.selected = g.id;
        this.redrawAll();
        this.updateHint();
      }
    }
    const m = this.s.items.find((x) => x.id === g.id);
    if (!m) return;
    if (g.node !== null) {
      // Punktet festes til tegningen som når man måler.
      const hit = this.resolve(e, g.page);
      if (hit) m.points = g.points.map((p, i) => (i === g.node ? hit.p : p));
    } else {
      const hit = this.hitPage(e, g.page);
      if (!hit) return;
      const dx = hit.p[0] - g.from[0];
      const dy = hit.p[1] - g.from[1];
      m.points = g.points.map((p) => [p[0] + dx, p[1] + dy] as Pt);
    }
    this.redraw(g.page);
  }

  /**
   * Hva et trykk treffer når man ikke er midt i en måling: et punkt på det
   * valgte målet, en etikett, eller innsiden av et areal. Innsiden teller ikke
   * nær kantene eller når punktet festes til tegningen, for der starter man
   * nye mål (f.eks. rommet ved siden av, med felles hjørner).
   */
  private grabTarget(e: MouseEvent): { id: number; node: number | null; via: "node" | "edge" | "label" | "inside" } | null {
    const labelEl = (e.target as HTMLElement).closest(".measure-label[data-id]") as HTMLElement | null;
    if (labelEl) return { id: Number(labelEl.dataset.id), node: null, via: "label" };
    const hit = this.hitPage(e);
    if (!hit) return null;
    const ppp = this.pointsPerPixel(hit.page);
    const sel = this.s.items.find((m) => m.id === this.s.selected && m.page === hit.page);
    if (sel) {
      let node = -1;
      let best = ppp * 8;
      sel.points.forEach((p, i) => {
        const d = distance(p, hit.p);
        if (d <= best) {
          best = d;
          node = i;
        }
      });
      if (node >= 0) return { id: sel.id, node, via: "node" };
      // Kanten på valgt lengde/areal: dra flytter målet, dobbeltklikk gir nytt punkt.
      if (sel.kind !== "distance" && pathDistance(hit.p, sel.points, sel.kind === "area") <= ppp * 6) return { id: sel.id, node: null, via: "edge" };
    }
    if (this.snapOn && !e.altKey && !e.shiftKey && this.snapIndex(hit.page)?.query(hit.p, ppp * 10)) return null;
    for (let i = this.s.items.length - 1; i >= 0; i--) {
      const m = this.s.items[i];
      if (m.page !== hit.page || m.kind !== "area") continue;
      if (insidePolygon(hit.p, m.points) && pathDistance(hit.p, m.points, true) > ppp * 8) return { id: m.id, node: null, via: "inside" };
    }
    return null;
  }

  /** Siden og PDF-punktet under musepekeren (eller på en gitt side, f.eks. mens man drar). */
  private hitPage(e: MouseEvent, onPage?: number): { page: number; p: Pt } | null {
    let page: number;
    let box: Element;
    if (onPage !== undefined) {
      const l = this.layers.get(onPage);
      if (!l || !l.el.isConnected) return null;
      page = onPage;
      box = l.el;
    } else {
      const pageEl = (e.target as HTMLElement).closest(".page") as HTMLElement | null;
      if (!pageEl) return null;
      page = Number(pageEl.dataset.index);
      box = pageEl;
    }
    const layer = this.layers.get(page);
    if (!layer) return null;
    const r = box.getBoundingClientRect();
    const g = layer.geom;
    const vx = ((e.clientX - r.left) / r.width) * g.width;
    const vy = ((e.clientY - r.top) / r.height) * g.height;
    const [x, y] = g.convertToPdfPoint(vx, vy) as number[];
    return { page, p: [x, y] };
  }

  /**
   * Punktet under musa etter snapping: fester til hjørner, midtpunkter,
   * skjæringer og linjer i tegningen (ikke med Shift, som låser vinkelen,
   * og ikke mens Alt holdes inne).
   */
  private resolve(e: MouseEvent, onPage?: number): { page: number; p: Pt; snapped: boolean } | null {
    const raw = this.hitPage(e, onPage);
    if (!raw) {
      this.showMarker(null);
      return null;
    }
    let hit: SnapHit | null = null;
    if (this.snapOn && !e.altKey && !e.shiftKey) {
      const index = this.snapIndex(raw.page);
      if (index) hit = index.query(raw.p, this.pointsPerPixel(raw.page) * 10);
    }
    this.showMarker(hit ? { page: raw.page, hit } : null);
    return hit ? { page: raw.page, p: hit.p, snapped: true } : { ...raw, snapped: false };
  }

  /** Snapdata for en side; leses i bakgrunnen første gang siden brukes. */
  private snapIndex(page: number): SnapIndex | null {
    if (this.s.snaps.has(page)) return this.s.snaps.get(page) ?? null;
    const st = this.s;
    if (!st.snapLoading.has(page) && st.doc) {
      st.snapLoading.add(page);
      st.doc
        .getPage(page + 1)
        .then((p) => SnapIndex.build(p))
        .then((index) => st.snaps.set(page, index))
        .catch(() => st.snaps.set(page, null));
    }
    return null;
  }

  /** Viser hva punktet festes til (firkant: hjørne, trekant: midtpunkt, kryss: linje). */
  private showMarker(snap: { page: number; hit: SnapHit } | null): void {
    const prev = this.lastSnap;
    if (prev && (!snap || prev.page !== snap.page)) this.layers.get(prev.page)?.marker.classList.remove("show");
    this.lastSnap = snap;
    if (!snap) return;
    const layer = this.layers.get(snap.page);
    if (!layer) return;
    const [x, y] = this.toView(layer, snap.hit.p);
    const m = layer.marker;
    m.style.left = `${(x / layer.geom.width) * 100}%`;
    m.style.top = `${(y / layer.geom.height) * 100}%`;
    m.dataset.kind = snap.hit.kind;
    m.dataset.label = SNAP_NAMES[snap.hit.kind];
    m.classList.add("show");
  }

  /** PDF-punkter per skjermpiksel på en side (for toleranser). */
  private pointsPerPixel(page: number): number {
    const layer = this.layers.get(page);
    if (!layer || !layer.el.isConnected) return 1;
    return layer.geom.width / (layer.el.getBoundingClientRect().width || 1);
  }

  private click(page: number, raw: Pt, shift: boolean): void {
    if (this.drawing && page !== this.drawing.page) return;
    const pts = this.drawing?.points ?? [];
    const last = pts.at(-1);
    const p = last && shift ? snap45(last, raw) : raw;
    const tol = this.pointsPerPixel(page) * 3;
    // Dobbeltklikk gir to klikk på samme sted; det andre ignoreres.
    if (last && distance(last, p) < tol) return;

    if (this.calibrating) {
      if (!this.drawing) this.drawing = { page, points: [p] };
      else return this.finishCalibration(page, pts[0], p);
      this.updateHint();
      return this.drawPreview(page);
    }

    // Areal: klikk på startpunktet lukker figuren.
    if (this.kind === "area" && pts.length >= 3 && distance(pts[0], p) < tol * 3) return this.finish();

    if (!this.drawing) this.drawing = { page, points: [p] };
    else pts.push(p);
    this.s.selected = null;
    if (this.kind === "distance" && this.drawing.points.length === 2) return this.finish();
    this.updateHint();
    this.drawPreview(page);
  }

  private finish(): void {
    const d = this.drawing;
    if (!d) return;
    const need = this.kind === "area" ? 3 : 2;
    if (d.points.length < need) return;
    const region = regionAt(this.s.pdfScales.get(d.page), d.points[0]);
    const m: Measurement = {
      id: this.nextId++,
      page: d.page,
      kind: this.kind,
      points: d.points,
      fixed: region ? { metersPerPoint: region.metersPerPoint, label: `${region.label} fra PDF` } : null,
    };
    this.remember();
    this.s.items.push(m);
    this.s.selected = m.id;
    this.drawing = null;
    this.cursor = null;
    this.redraw(d.page);
    this.markDirty();
    this.updateHint();
  }

  private cancelDrawing(): void {
    const page = this.drawing?.page;
    this.drawing = null;
    this.cursor = null;
    this.calibrating = false;
    if (page !== undefined) this.drawPreview(page);
    this.updateHint();
  }

  private remove(id: number): void {
    const m = this.s.items.find((x) => x.id === id);
    if (!m) return;
    this.remember();
    this.s.items = this.s.items.filter((x) => x.id !== id);
    if (this.s.selected === id) this.s.selected = null;
    this.redraw(m.page);
    this.markDirty();
    this.updateHint();
  }

  private clearAll(): void {
    const pages = new Set(this.s.items.map((m) => m.page));
    if (!this.s.items.length) return;
    this.remember();
    this.s.items = [];
    this.s.selected = null;
    for (const p of pages) this.redraw(p);
    this.markDirty();
  }

  private select(id: number, reveal: boolean): void {
    this.s.selected = id;
    const m = this.s.items.find((x) => x.id === id);
    if (!m) return;
    if (reveal && m.page !== this.viewer.current) this.viewer.goToPage(m.page);
    this.redrawAll();
    this.refreshPanel();
    this.updateHint();
    // Så Delete og Backspace når fram, også etter klikk i lista.
    this.viewer.el.focus({ preventScroll: true });
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === "Escape") {
      if (this.drawing || this.calibrating) this.cancelDrawing();
      else if (this.s.selected !== null) {
        this.s.selected = null;
        this.redrawAll();
        this.refreshPanel();
        this.updateHint();
      } else this.close();
    } else if (ctrl && k.toLowerCase() === "s") void this.save();
    else if (k === "Enter") this.finish();
    else if (k === "Backspace" && this.drawing) {
      this.drawing.points.pop();
      const page = this.drawing.page;
      if (!this.drawing.points.length) this.drawing = null;
      this.drawPreview(page);
      this.updateHint();
    } else if ((k === "Delete" || k === "Backspace") && this.s.selected !== null) this.remove(this.s.selected);
    else if (ctrl && k.toLowerCase() === "z" && !this.drawing) this.undo();
    else if (!ctrl && (k === "d" || k === "D")) this.setKind("distance");
    else if (!ctrl && (k === "l" || k === "L")) this.setKind("length");
    else if (!ctrl && (k === "a" || k === "A")) this.setKind("area");
    else return false;
    return true;
  }

  private updateHint(): void {
    // Mens man måler, skal etikettene til andre mål ikke fange klikkene.
    this.viewer.el.classList.toggle("m-drawing", !!this.drawing || this.calibrating);
    if (this.drawing || this.calibrating) delete this.viewer.el.dataset.mhover;
    let t: string;
    if (this.calibrating) t = this.drawing ? "Klikk sluttpunktet på det kjente målet" : "Kalibrer: klikk startpunktet på et kjent mål";
    else if (!this.drawing && this.s.selected !== null) t = "Dra punktene · dobbeltklikk på kanten gir nytt punkt · Delete sletter";
    else if (!this.drawing) t = this.kind === "distance" ? "Klikk startpunkt" : "Klikk første punkt";
    else if (this.kind === "distance") t = "Klikk sluttpunkt · Shift låser vinkelen";
    else if (this.kind === "length") t = "Klikk flere punkter · dobbeltklikk eller Enter avslutter";
    else t = "Klikk hjørnene · klikk startpunktet, dobbeltklikk eller Enter lukker";
    this.hint.textContent = t;
    this.hint.title = t;
  }

  // ---------- Verdier ----------

  private describe(m: Measurement): { main: string; sub?: string; value: number | null; perimeter?: number | null } {
    const k = this.metersPerPoint(m);
    if (m.kind === "area") {
      const a = polygonArea(m.points);
      const per = pathLength(m.points, true);
      if (k === null) {
        const cm2 = a * (PAPER_METERS_PER_POINT * 100) ** 2;
        return { main: `${cm2.toLocaleString("nb-NO", { maximumFractionDigits: 1 })} cm² på arket`, value: null };
      }
      return { main: formatArea(a * k * k), sub: `omkrets ${formatLength(per * k, this.unit)}`, value: a * k * k, perimeter: per * k };
    }
    const len = pathLength(m.points);
    if (k === null) return { main: formatPaper(len), value: null };
    return { main: formatLength(len * k, this.unit), value: len * k };
  }

  private refreshPanel(): void {
    this.count.textContent = this.s.items.length ? `(${this.s.items.length})` : "";
    this.panel.hidden = !this.active || (this.s.items.length === 0 && !this.dirty);
    this.saveBtn.disabled = !this.dirty;
    this.saveBtn.classList.toggle("primary", this.dirty);
    this.saveBtn.title = this.dirty ? "Lagre målene i PDF-fila (Ctrl+S)" : "Målene er lagret i fila";
    this.list.replaceChildren(
      ...this.s.items.map((m, i) => {
        const d = this.describe(m);
        const scale = m.fixed?.label ?? this.scaleFor(m.page)?.label ?? "uten målestokk";
        const row = h(
          "li",
          { class: m.id === this.s.selected ? "selected" : "" },
          h("span", { class: "measure-nr" }, String(i + 1)),
          h("span", { class: "measure-desc" }, h("span", { class: "measure-value" }, d.main), h("span", { class: "muted" }, `${KIND_NAMES[m.kind]} · side ${m.page + 1} · ${scale}`)),
        );
        const del = button("", "close", () => this.remove(m.id), { title: "Fjern", className: "ghost" });
        row.append(del);
        row.addEventListener("click", (e) => {
          if (!(e.target as HTMLElement).closest("button")) this.select(m.id, true);
        });
        return row;
      }),
    );
    let area = 0;
    let areas = 0;
    let len = 0;
    let lens = 0;
    for (const m of this.s.items) {
      const v = this.describe(m).value;
      if (v === null) continue;
      if (m.kind === "area") {
        area += v;
        areas++;
      } else {
        len += v;
        lens++;
      }
    }
    const parts: string[] = [];
    if (areas > 1) parts.push(`Sum areal: ${formatArea(area)}`);
    if (lens > 1) parts.push(`Sum lengder: ${formatLength(len, this.unit)}`);
    this.totals.textContent = parts.join(" · ");
    this.totals.hidden = !parts.length;
  }

  /** Kopierer målene som tabulatordelt tekst, klar til å limes inn i Excel. */
  private async copyTable(): Promise<void> {
    const num = (v: number) => v.toFixed(2).replace(".", ",");
    const rows = [["Nr", "Side", "Type", "Verdi", "Enhet", "Omkrets (m)", "Målestokk"].join("\t")];
    this.s.items.forEach((m, i) => {
      const d = this.describe(m);
      const scale = m.fixed?.label ?? this.scaleFor(m.page)?.label ?? "";
      const unit = d.value === null ? "" : m.kind === "area" ? "m²" : this.unit;
      const value = d.value === null ? d.main : num(m.kind !== "area" && this.unit === "mm" ? d.value * 1000 : d.value);
      rows.push([i + 1, m.page + 1, KIND_NAMES[m.kind], value, unit, d.perimeter != null ? num(d.perimeter) : "", scale].join("\t"));
    });
    const text = rows.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h("textarea", {}, text);
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast(`${this.s.items.length} mål kopiert – lim inn i Excel`, "success");
  }

  // ---------- Tegning på sidene ----------

  /** Kalles hver gang visningen har tegnet en side. */
  private attach(page: number, pageEl: HTMLDivElement, geom: PageGeometry): void {
    let layer = this.layers.get(page);
    if (!layer) {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("preserveAspectRatio", "none");
      const labels = h("div", { class: "measure-labels" });
      const marker = h("div", { class: "snap-marker" });
      const el = h("div", { class: "measureLayer" });
      el.append(svg, labels, marker);
      layer = { el, svg, labels, marker, geom };
      this.layers.set(page, layer);
    }
    layer.geom = geom;
    layer.svg.setAttribute("viewBox", `0 0 ${geom.width} ${geom.height}`);
    pageEl.append(layer.el);
    this.redraw(page);
  }

  private redrawAll(): void {
    for (const page of this.layers.keys()) this.redraw(page);
    this.refreshPanel();
  }

  private toView(layer: Layer, p: Pt): Pt {
    return layer.geom.convertToViewportPoint(p[0], p[1]) as Pt;
  }

  /** Etikett med verdien. Med `id` kan den klikkes (velger målet) og dras (flytter det). */
  private label(layer: Layer, at: Pt, main: string, sub: string | undefined, cls: string, id?: number): HTMLDivElement {
    const [x, y] = this.toView(layer, at);
    const el = h("div", { class: `measure-label ${cls}`, "data-id": id }, h("span", {}, main), sub ? h("small", {}, sub) : null);
    el.style.left = `${(x / layer.geom.width) * 100}%`;
    el.style.top = `${(y / layer.geom.height) * 100}%`;
    return el;
  }

  private dot(layer: Layer, p: Pt, cls = ""): HTMLDivElement {
    const [x, y] = this.toView(layer, p);
    const el = h("div", { class: `measure-dot ${cls}` });
    el.style.left = `${(x / layer.geom.width) * 100}%`;
    el.style.top = `${(y / layer.geom.height) * 100}%`;
    return el;
  }

  private shape(layer: Layer, points: Pt[], closed: boolean, cls: string): SVGElement {
    const el = document.createElementNS(SVG, closed ? "polygon" : "polyline");
    el.setAttribute("points", points.map((p) => this.toView(layer, p).join(",")).join(" "));
    el.setAttribute("class", cls);
    el.setAttribute("vector-effect", "non-scaling-stroke");
    return el;
  }

  /** Midtpunktet langs en polylinje (for etiketten). */
  private midpoint(points: Pt[]): Pt {
    const total = pathLength(points);
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      const seg = distance(points[i - 1], points[i]);
      if (acc + seg >= total / 2) {
        const t = seg ? (total / 2 - acc) / seg : 0;
        return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
      }
      acc += seg;
    }
    return points[0];
  }

  private redraw(page: number): void {
    const layer = this.layers.get(page);
    if (!layer) return;
    const shapes: SVGElement[] = [];
    const labels: HTMLElement[] = [];
    for (const m of this.s.items) {
      if (m.page !== page) continue;
      const sel = m.id === this.s.selected ? " selected" : "";
      const closed = m.kind === "area";
      shapes.push(this.shape(layer, m.points, closed, `m-shape ${m.kind}${sel}`));
      for (const p of m.points) labels.push(this.dot(layer, p, sel));
      const d = this.describe(m);
      const at = closed ? centroid(m.points) : this.midpoint(m.points);
      labels.push(this.label(layer, at, d.main, d.sub, sel, m.id));
    }
    const preview = document.createElementNS(SVG, "g");
    preview.setAttribute("class", "m-preview");
    layer.svg.replaceChildren(...shapes, preview);
    const previewLabels = h("div", { class: "measure-preview" });
    layer.labels.replaceChildren(...labels, previewLabels);
    this.drawPreview(page);
  }

  /** Den pågående målingen, med gummistrikk til musepekeren. */
  private drawPreview(page: number): void {
    const layer = this.layers.get(page);
    if (!layer) return;
    const g = layer.svg.querySelector(".m-preview");
    const box = layer.labels.querySelector(".measure-preview");
    if (!g || !box) return;
    const d = this.drawing?.page === page ? this.drawing : null;
    const cur = this.cursor?.page === page ? this.cursor.p : null;
    if (!d) {
      g.replaceChildren();
      box.replaceChildren();
      return;
    }
    const pts = cur ? [...d.points, cur] : d.points;
    const closed = this.kind === "area" && !this.calibrating && pts.length >= 3;
    g.replaceChildren(this.shape(layer, pts, closed, `m-shape preview ${this.calibrating ? "calibrate" : this.kind}`));
    const dots = d.points.map((p) => this.dot(layer, p, "preview"));
    let text: HTMLElement | null = null;
    if (pts.length >= 2) {
      const fake: Measurement = { id: 0, page, kind: this.calibrating ? "distance" : this.kind, points: pts, fixed: null };
      const region = regionAt(this.s.pdfScales.get(page), d.points[0]);
      if (region) fake.fixed = { metersPerPoint: region.metersPerPoint, label: region.label };
      const desc = this.calibrating ? { main: formatPaper(pathLength(pts)), sub: undefined } : this.describe(fake);
      const at = closed ? centroid(pts) : (cur ?? pts[pts.length - 1]);
      text = this.label(layer, at, desc.main, desc.sub, `preview${closed ? "" : " at-cursor"}`);
    }
    box.replaceChildren(...dots, ...(text ? [text] : []));
  }
}
