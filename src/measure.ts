// Måling (M): avstand, lengde (polylinje), areal, rektangel og sirkel på
// tegninger – også godt egnet til raske skisser (f.eks. fotavtrykk av bygg).
//
// Punktene lagres i PDF-koordinater, så målene ligger fast på tegningen
// uansett zoom og rotasjon. Målestokk hentes fra PDF-en når den er lagt inn
// (Revit, ArchiCAD m.fl.), ellers velger man den selv eller kalibrerer mot
// et kjent mål.
import {
  angleOf,
  centroid,
  circlePoints,
  distance,
  formatArea,
  formatLength,
  formatPaper,
  insertionPoint,
  insidePolygon,
  lineIntersection,
  lockDirection,
  lockVertex,
  metersPerPointForScale,
  offsetEdge,
  offsetPath,
  parseNumber,
  parsePages,
  pathDistance,
  pathLength,
  PAPER_METERS_PER_POINT,
  polygonArea,
  rectFrom,
  regionAt,
  scaleLabel,
  segmentDistance,
  setEdgeLength,
  type PdfScaleRegion,
  type Pt,
} from "./measure-math";
import { DEFAULT_COLOR, readMeasureData, writeMeasurements, type WritableMeasurement } from "./measure-pdf";
import type { PDFDocumentProxy } from "./pdf";
import { SnapIndex, type SnapHit } from "./snap";
import { button, h, modal, toast } from "./ui";
import type { PageGeometry, Viewer } from "./viewer";

export type MeasureKind = "distance" | "length" | "area" | "circle";
/** Verktøyene: rektangel tegnes med tre klikk og blir et vanlig areal. */
type Tool = MeasureKind | "rect";
type Unit = "m" | "mm";

interface Scale {
  metersPerPoint: number;
  label: string;
}

interface Measurement {
  id: number;
  page: number;
  kind: MeasureKind;
  /** Hjørnene; for sirkel sentrum og et punkt på omkretsen. */
  points: Pt[];
  /** Målestokk fra PDF-en der målet startet; ellers gjelder sidens målestokk. */
  fixed: Scale | null;
  name?: string;
  color?: string;
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
    items: m.items.map((x) => [x.page, x.kind, x.points, x.fixed, x.name ?? "", x.color ?? ""]),
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
const KIND_NAMES: Record<MeasureKind, string> = { distance: "Avstand", length: "Lengde", area: "Areal", circle: "Sirkel" };
const TOOL_NAMES: Record<Tool, string> = { ...KIND_NAMES, rect: "Rektangel" };
const PALETTE: Array<[string, string]> = [
  [DEFAULT_COLOR, "Oransje"],
  ["#1c7ed6", "Blå"],
  ["#2b8a3e", "Grønn"],
  ["#7048e8", "Lilla"],
  ["#e03131", "Rød"],
  ["#0c8599", "Turkis"],
  ["#e8a200", "Gul"],
  ["#495057", "Grå"],
];

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
  private tool: Tool = "distance";
  private unit: Unit = store.get("measureUnit") === "mm" ? "mm" : "m";
  /** Fargen nye mål får (sist valgte). */
  private color = PALETTE.some(([c]) => c === store.get("measureColor")) ? store.get("measureColor")! : DEFAULT_COLOR;
  /** Målene og målestokken for dokumentet som vises (se `MeasureDoc`). */
  private s: MeasureDoc = newMeasureDoc(null);
  private nextId = 1;
  private drawing: { page: number; points: Pt[] } | null = null;
  /** Et mål som skrives inn med tastaturet mens man tegner (f.eks. «12,5»). */
  private typed = "";
  private calibrating = false;
  private cursor: { page: number; p: Pt } | null = null;
  /** Forhåndsvisning mens en dialog er åpen (forskyving, rotasjon). */
  private ghost: { page: number; points: Pt[]; closed: boolean; color: string } | null = null;
  private layers = new Map<number, Layer>();
  private toolBefore: "select" | "hand" = "select";
  private down: { x: number; y: number } | null = null;
  /**
   * Et mål som dras: ett punkt (`node`), én kant (`edge`, flyttes parallelt)
   * eller hele målet (begge er null).
   */
  private grab: {
    id: number;
    page: number;
    node: number | null;
    edge: number | null;
    via: "node" | "edge" | "label" | "inside";
    x: number;
    y: number;
    from: Pt;
    points: Pt[];
    moved: boolean;
  } | null = null;
  /** Kopiert mål (Ctrl+C), og hvor mange ganger det er limt inn. */
  private clip: { m: Measurement; pasted: number } | null = null;
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
  /** Lagrer dokumentet (hovedprogrammet skriver mål og markeringer sammen). */
  onSave: (() => Promise<unknown>) | null = null;
  private saveBtn: HTMLButtonElement;
  private toolButtons: Record<Tool, HTMLButtonElement>;
  private colorSwatch: HTMLSpanElement;
  private scaleSelect: HTMLSelectElement;
  private unitSelect: HTMLSelectElement;
  private scaleInfo: HTMLSpanElement;
  private hint: HTMLSpanElement;
  private list: HTMLOListElement;
  private totals: HTMLDivElement;
  private count: HTMLSpanElement;

  onChange: () => void = () => {};

  constructor(private readonly viewer: Viewer) {
    const toolBtn = (t: Tool, iconName: string, key: string) =>
      button(TOOL_NAMES[t], iconName, () => this.setTool(t), { title: `${TOOL_NAMES[t]} (${key})`, className: "ghost tool" });
    this.toolButtons = {
      distance: toolBtn("distance", "ruler", "D"),
      length: toolBtn("length", "polyline", "L"),
      area: toolBtn("area", "area", "A"),
      rect: toolBtn("rect", "rect", "R"),
      circle: toolBtn("circle", "circle", "S"),
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

    // Farge: gjelder nye mål, og valgt mål.
    this.colorSwatch = h("span", { class: "m-swatch" });
    this.colorSwatch.style.background = this.color;
    const palette = h(
      "div",
      { class: "m-palette", hidden: true },
      ...PALETTE.map(([c, name]) => {
        const b = h("button", { type: "button", class: "m-swatch", title: name, "aria-label": name });
        b.style.background = c;
        b.addEventListener("click", () => {
          palette.hidden = true;
          this.setColor(c);
        });
        return b;
      }),
    );
    const colorBtn = h("button", { type: "button", class: "btn ghost m-color-btn", title: "Farge (nye mål og valgt mål)", "aria-label": "Farge" }, this.colorSwatch);
    colorBtn.addEventListener("click", () => (palette.hidden = !palette.hidden));
    const colorWrap = h("span", { class: "m-color" }, colorBtn, palette);
    document.addEventListener("pointerdown", (e) => {
      if (!colorWrap.contains(e.target as Node)) palette.hidden = true;
    });

    const t = this.toolButtons;
    this.bar = h(
      "div",
      { class: "subbar measure-bar", hidden: true },
      h("strong", {}, "Mål"),
      h("span", { class: "tool-group" }, t.distance, t.length, t.area, t.rect, t.circle),
      colorWrap,
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
    this.setTool(this.tool);
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
    this.typed = "";
    this.ghost = null;
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

  /**
   * Etter en endring: er målene nå annerledes enn i fila? (Angrer man
   * tilbake, er de ikke det.) Uten `full` bygges ikke lista på nytt (f.eks.
   * mens man skriver i navnefeltet).
   */
  private markDirty(full = true): void {
    const dirty = measureSignature(this.s) !== measureSignature(this.s.saved);
    const changed = dirty !== this.s.dirty;
    this.s.dirty = dirty;
    if (changed) this.onChange();
    if (full) this.refreshPanel();
    else this.refreshSaveState();
  }

  /** Lagrer dokumentet med målene. */
  async save(): Promise<void> {
    await this.onSave?.();
  }

  /** Skriver målene inn i PDF-bytes (brukes når dokumentet lagres). */
  async writeTo(bytes: Uint8Array): Promise<Uint8Array> {
    const items: WritableMeasurement[] = this.s.items.map((m) => {
      const d = this.describe(m);
      const scale = m.fixed ?? this.scaleFor(m.page);
      return {
        page: m.page,
        kind: m.kind,
        points: m.points,
        fixed: m.fixed,
        name: m.name,
        color: m.color,
        metersPerPoint: scale?.metersPerPoint ?? null,
        scaleLabel: scale?.label ?? null,
        text: d.main,
        subText: d.sub,
      };
    });
    return writeMeasurements(bytes, items, this.s.pageScale, this.s.defaultScale);
  }

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

  private setTool(t: Tool): void {
    this.cancelDrawing();
    this.tool = t;
    for (const [key, b] of Object.entries(this.toolButtons)) b.classList.toggle("active", key === t);
    this.updateHint();
  }

  /** Ny farge: brukes på nye mål og på målet som er valgt. */
  private setColor(c: string): void {
    this.color = c;
    store.set("measureColor", c);
    this.colorSwatch.style.background = c;
    const m = this.selectedItem();
    if (!m || (m.color ?? DEFAULT_COLOR) === c) return;
    this.remember();
    m.color = c;
    this.redraw(m.page);
    this.markDirty();
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

  /** Målestokk fra PDF-en der et nytt mål starter (ellers null: sidens målestokk gjelder). */
  private fixedAt(page: number, p: Pt): Scale | null {
    const region = regionAt(this.s.pdfScales.get(page), p);
    return region ? { metersPerPoint: region.metersPerPoint, label: `${region.label} fra PDF` } : null;
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
    const preview = h("p", { class: "muted" }, " ");
    const read = () => {
      const n = Number(input.value.replace(",", "."));
      return n > 0 ? (unit.value === "mm" ? n / 1000 : n) : null;
    };
    const update = () => {
      const m = read();
      preview.textContent = m ? `Gir målestokk ca. ${scaleLabel(m / pts)} (når arket skrives ut i full størrelse).` : " ";
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
      const target = e.target as HTMLElement;
      // Feltet for å skrive inn en sidelengde skal oppføre seg som et vanlig felt.
      if (target.closest(".measure-seg-input")) return;
      // Ikke marker tekst i PDF-en når man klikker eller drar under måling
      // (men la rullefeltet være i fred).
      if (target.closest(".page")) e.preventDefault();
      el.focus({ preventScroll: true });
      // Klikk på lengden til en side av valgt mål: skriv inn ny lengde.
      const seg = !this.drawing && !this.calibrating ? (target.closest(".measure-seg[data-seg]") as HTMLElement | null) : null;
      if (seg) return this.editSegment(Number(seg.dataset.id), Number(seg.dataset.seg));
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
        el.dataset.mhover = t ? (t.via === "node" || t.via === "edge" ? "node" : "body") : "";
      }
      const hit = this.resolve(e);
      if (!hit || (this.drawing && hit.page !== this.drawing.page)) return;
      if (!this.drawing && !this.calibrating) return;
      const p = e.shiftKey && !hit.snapped ? this.lockDraw(hit.page, hit.p) : hit.p;
      this.cursor = { page: hit.page, p };
      this.drawPreview(hit.page);
    });
    el.addEventListener("pointerleave", () => this.showMarker(null));
    el.addEventListener("dblclick", (e) => {
      if (!this.active) return;
      e.preventDefault();
      if (this.drawing && (this.tool === "length" || this.tool === "area")) this.finish();
      else if (!this.drawing && !this.calibrating) this.insertNode(e);
    });
  }

  /**
   * Dobbeltklikk på kanten av valgt lengde- eller arealmål gir et nytt punkt.
   * (Hendelsen kan gå til visningen etter at musa ble holdt, så punktet
   * regnes ut fra målets side.)
   */
  private insertNode(e: MouseEvent): void {
    const m = this.selectedItem();
    const hit = m && (m.kind === "length" || m.kind === "area") ? this.hitPage(e, m.page) : null;
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

  /** Flytter et punkt, en kant eller hele målet mens det dras. */
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
    const translate = (dx: number, dy: number) => g.points.map((p) => [p[0] + dx, p[1] + dy] as Pt);
    if (g.node !== null || g.edge !== null) {
      // Punktet (eller kanten) festes til tegningen som når man måler.
      const hit = this.resolve(e, g.page);
      if (!hit) return;
      const free = e.shiftKey && !hit.snapped;
      if (m.kind === "circle") {
        const c = g.points[0];
        if (g.node === 0) m.points = translate(hit.p[0] - c[0], hit.p[1] - c[1]);
        else if (g.node === 1) m.points = [c, free ? lockDirection(c, hit.p, 0, Math.PI / 4) : hit.p];
        else {
          // Kanten: endre radien, i samme retning som før.
          const r = distance(c, hit.p);
          const r0 = distance(c, g.points[1]) || 1;
          m.points = [c, [c[0] + ((g.points[1][0] - c[0]) / r0) * r, c[1] + ((g.points[1][1] - c[1]) / r0) * r]];
        }
      } else if (g.node !== null) {
        const p = free ? lockVertex(g.points, g.node, m.kind === "area", hit.p, this.pointsPerPixel(g.page) * 12) : hit.p;
        m.points = g.points.map((q, i) => (i === g.node ? p : q));
      } else {
        // Kanten flyttes parallelt; nabokantene beholder retningen.
        const i = g.edge!;
        const a = g.points[i];
        const b = g.points[(i + 1) % g.points.length];
        const len = distance(a, b) || 1;
        const n: Pt = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
        const d = (hit.p[0] - g.from[0]) * n[0] + (hit.p[1] - g.from[1]) * n[1];
        m.points = offsetEdge(g.points, i, d, m.kind === "area");
      }
    } else {
      const hit = this.hitPage(e, g.page);
      if (!hit) return;
      m.points = translate(hit.p[0] - g.from[0], hit.p[1] - g.from[1]);
    }
    this.redraw(g.page);
  }

  /**
   * Hva et trykk treffer når man ikke er midt i en måling: et punkt eller en
   * kant på det valgte målet, en etikett, eller innsiden av et areal. Innsiden
   * teller ikke nær kantene eller når punktet festes til tegningen, for der
   * starter man nye mål (f.eks. rommet ved siden av, med felles hjørner).
   */
  private grabTarget(e: MouseEvent): { id: number; node: number | null; edge: number | null; via: "node" | "edge" | "label" | "inside" } | null {
    const labelEl = (e.target as HTMLElement).closest(".measure-label[data-id]") as HTMLElement | null;
    if (labelEl) return { id: Number(labelEl.dataset.id), node: null, edge: null, via: "label" };
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
      if (node >= 0) return { id: sel.id, node, edge: null, via: "node" };
      // Kanten på valgt mål: dra flytter kanten, dobbeltklikk gir nytt punkt.
      if (sel.kind === "circle") {
        if (Math.abs(distance(sel.points[0], hit.p) - distance(sel.points[0], sel.points[1])) <= ppp * 6) return { id: sel.id, node: null, edge: 0, via: "edge" };
      } else if (sel.kind !== "distance") {
        const n = sel.points.length;
        const edges = sel.kind === "area" ? n : n - 1;
        let edge = -1;
        let bestEdge = ppp * 6;
        for (let i = 0; i < edges; i++) {
          const d = segmentDistance(hit.p, sel.points[i], sel.points[(i + 1) % n]);
          if (d <= bestEdge) {
            bestEdge = d;
            edge = i;
          }
        }
        if (edge >= 0) return { id: sel.id, node: null, edge, via: "edge" };
      }
    }
    if (this.snapOn && !e.altKey && !e.shiftKey && this.snapIndex(hit.page)?.query(hit.p, ppp * 10)) return null;
    for (let i = this.s.items.length - 1; i >= 0; i--) {
      const m = this.s.items[i];
      if (m.page !== hit.page) continue;
      if (m.kind === "area" && insidePolygon(hit.p, m.points) && pathDistance(hit.p, m.points, true) > ppp * 8) return { id: m.id, node: null, edge: null, via: "inside" };
      if (m.kind === "circle" && distance(hit.p, m.points[0]) < distance(m.points[0], m.points[1]) - ppp * 8) return { id: m.id, node: null, edge: null, via: "inside" };
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

  /**
   * Shift mens man tegner: første side låses til 45° mot arket, de neste til
   * 90° på forrige side (også når bygget ligger skrått). For areal festes
   * punktet også der siste side blir vinkelrett på den første, så figuren
   * kan lukkes rett.
   */
  private lockDraw(page: number, p: Pt): Pt {
    const pts = this.drawing?.points;
    if (!pts?.length) return p;
    if (!this.calibrating && (this.tool === "circle" || (this.tool === "rect" && pts.length === 2))) return p;
    const last = pts[pts.length - 1];
    const prev = pts.length >= 2 ? pts[pts.length - 2] : null;
    let q = prev ? lockDirection(last, p, angleOf(prev, last), Math.PI / 2) : lockDirection(last, p, 0, Math.PI / 4);
    const dir: Pt = [q[0] - last[0], q[1] - last[1]];
    if (!this.calibrating && this.tool === "area" && pts.length >= 2 && Math.hypot(...dir) > 0) {
      const tol = this.pointsPerPixel(page) * 12;
      const a0 = angleOf(pts[0], pts[1]);
      let best: Pt | null = null;
      for (const a of [a0, a0 + Math.PI / 2]) {
        const x = lineIntersection(last, dir, pts[0], [Math.cos(a), Math.sin(a)]);
        if (x && distance(x, q) <= tol && (!best || distance(x, q) < distance(best, q))) best = x;
      }
      if (best) q = best;
    }
    return q;
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

  // ---------- Tegning av nye mål ----------

  private click(page: number, raw: Pt, shift: boolean): void {
    if (this.drawing && page !== this.drawing.page) return;
    const pts = this.drawing?.points ?? [];
    const last = pts.at(-1);
    const p = shift ? this.lockDraw(page, raw) : raw;
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
    if (this.tool === "area" && pts.length >= 3 && distance(pts[0], p) < tol * 3) return this.finish();
    this.addPoint(page, p);
  }

  /** Legger til et punkt i målet som tegnes (fra klikk eller et innskrevet mål). */
  private addPoint(page: number, p: Pt): void {
    this.typed = "";
    if (!this.drawing) {
      this.drawing = { page, points: [p] };
      if (this.s.selected !== null) {
        this.s.selected = null;
        this.redrawAll();
      }
    } else {
      const pts = this.drawing.points;
      if (this.tool === "rect" && pts.length === 2) {
        const r = rectFrom(pts[0], pts[1], p);
        if (polygonArea(r) < 1e-6) return;
        return this.finish("area", r);
      }
      if (this.tool === "circle") return this.finish("circle", [pts[0], p]);
      pts.push(p);
    }
    if (this.tool === "distance" && this.drawing.points.length === 2) return this.finish();
    this.updateHint();
    this.drawPreview(page);
  }

  /** Avslutter målet som tegnes (eller lagrer en ferdig figur, f.eks. et rektangel). */
  private finish(kind?: MeasureKind, points?: Pt[]): void {
    const d = this.drawing;
    if (!d) return;
    if (!kind) {
      if (this.tool === "rect" || this.tool === "circle") return;
      kind = this.tool;
      points = d.points;
      if (points.length < (kind === "area" ? 3 : 2)) return;
    }
    const m: Measurement = { id: this.nextId++, page: d.page, kind, points: points!, fixed: this.fixedAt(d.page, points![0]), color: this.color };
    this.remember();
    this.s.items.push(m);
    this.s.selected = m.id;
    this.drawing = null;
    this.cursor = null;
    this.typed = "";
    this.redraw(d.page);
    this.markDirty();
    this.updateHint();
  }

  private cancelDrawing(): void {
    const page = this.drawing?.page;
    this.drawing = null;
    this.cursor = null;
    this.typed = "";
    this.calibrating = false;
    if (page !== undefined) this.drawPreview(page);
    this.updateHint();
  }

  /**
   * Bruker et mål som er skrevet inn mens man tegner: neste side får den
   * lengden i retningen musa peker (rektangel: bredden; sirkel: radien).
   */
  private applyTyped(): void {
    const d = this.drawing;
    const v = parseNumber(this.typed);
    this.typed = "";
    this.updateHint();
    if (!d) return;
    if (v === null || v <= 0) {
      toast("Skriv et tall større enn 0", "error");
      return this.drawPreview(d.page);
    }
    const k = this.fixedAt(d.page, d.points[0])?.metersPerPoint ?? this.scaleFor(d.page)?.metersPerPoint ?? null;
    if (k === null) {
      toast("Velg målestokk først for å skrive inn mål", "error");
      return this.drawPreview(d.page);
    }
    const len = (this.unit === "mm" ? v / 1000 : v) / k;
    const pts = d.points;
    const last = pts[pts.length - 1];
    const cur = this.cursor?.page === d.page ? this.cursor.p : null;
    if (this.tool === "rect" && pts.length === 2) {
      const [a, b] = pts;
      const ab = distance(a, b);
      const n: Pt = [-(b[1] - a[1]) / ab, (b[0] - a[0]) / ab];
      const side = cur && (cur[0] - b[0]) * n[0] + (cur[1] - b[1]) * n[1] < 0 ? -1 : 1;
      return this.finish("area", rectFrom(a, b, [b[0] + n[0] * len * side, b[1] + n[1] * len * side]));
    }
    let u: Pt | null = cur && distance(cur, last) > 1e-9 ? [(cur[0] - last[0]) / distance(cur, last), (cur[1] - last[1]) / distance(cur, last)] : null;
    if (!u && this.tool === "circle") u = [1, 0];
    if (!u) {
      toast("Pek med musa i retningen først");
      return this.drawPreview(d.page);
    }
    this.addPoint(d.page, [last[0] + u[0] * len, last[1] + u[1] * len]);
  }

  // ---------- Endring av valgt mål ----------

  private selectedItem(): Measurement | null {
    return this.s.items.find((x) => x.id === this.s.selected) ?? null;
  }

  /** Skriv inn ny lengde for en side (eller radien) av et mål, rett på tegningen. */
  private editSegment(id: number, seg: number): void {
    const m = this.s.items.find((x) => x.id === id);
    const layer = m && this.layers.get(m.page);
    const k = m && this.metersPerPoint(m);
    if (!m || !layer || !k) return;
    const n = m.points.length;
    const a = m.points[seg];
    const b = m.points[(seg + 1) % n];
    const cur = distance(a, b);
    const factor = this.unit === "mm" ? 1000 : 1;
    const shown = (cur * k * factor).toLocaleString("nb-NO", { maximumFractionDigits: this.unit === "mm" ? 0 : 3, useGrouping: false });
    const input = h("input", {
      type: "text",
      inputmode: "decimal",
      class: "measure-seg-input",
      "aria-label": m.kind === "circle" ? "Radius" : "Lengde på siden",
      value: shown,
    });
    const label = layer.labels.querySelector(`.measure-seg[data-id="${id}"][data-seg="${seg}"]`) as HTMLElement | null;
    if (label) {
      input.style.left = label.style.left;
      input.style.top = label.style.top;
      input.style.transform = label.style.transform;
    } else this.place(layer, input, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    input.style.setProperty("--mc", m.color ?? DEFAULT_COLOR);
    let done = false;
    const end = (apply: boolean) => {
      if (done) return;
      done = true;
      const v = parseNumber(input.value);
      input.remove();
      this.viewer.el.focus({ preventScroll: true });
      // Uendret tekst: ikke endre noe (verdien som vises er avrundet).
      if (!apply || v === null || input.value.trim() === shown) return;
      if (v <= 0) return toast("Skriv et tall større enn 0", "error");
      const len = v / factor / k;
      if (Math.abs(len - cur) < 1e-9) return;
      this.remember();
      m.points = m.kind === "circle" ? [a, [a[0] + ((b[0] - a[0]) / cur) * len, a[1] + ((b[1] - a[1]) / cur) * len]] : setEdgeLength(m.points, seg, len, m.kind === "area");
      this.redraw(m.page);
      this.markDirty();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") end(true);
      else if (e.key === "Escape") end(false);
    });
    input.addEventListener("blur", () => end(true));
    layer.labels.append(input);
    input.focus();
    input.select();
  }

  /**
   * Gjør en operasjon på punktene i visningens koordinater (slik siden vises,
   * også når den er rotert), så «vannrett» og «med klokka» blir som man ser.
   */
  private inView(page: number, points: Pt[], f: (pts: Pt[]) => Pt[]): Pt[] {
    const layer = this.layers.get(page);
    if (!layer) return f(points);
    return f(points.map((p) => this.toView(layer, p))).map((p) => layer.geom.convertToPdfPoint(p[0], p[1]) as Pt);
  }

  /** Midten av et mål (i samme koordinater som punktene). */
  private static center(kind: MeasureKind, pts: Pt[]): Pt {
    if (kind === "circle") return pts[0];
    if (kind === "area") return centroid(pts);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }

  private rotated(m: Measurement, degrees: number): Pt[] {
    // Positive grader er mot klokka slik siden vises (y går nedover i visningen).
    const t = (degrees * Math.PI) / 180;
    return this.inView(m.page, m.points, (pts) => {
      const [cx, cy] = Measure.center(m.kind, pts);
      return pts.map(([x, y]) => [cx + (x - cx) * Math.cos(t) + (y - cy) * Math.sin(t), cy - (x - cx) * Math.sin(t) + (y - cy) * Math.cos(t)] as Pt);
    });
  }

  private rotate(m: Measurement, degrees: number): void {
    this.remember();
    m.points = this.rotated(m, degrees);
    this.redraw(m.page);
    this.markDirty();
  }

  private mirror(m: Measurement, horizontal: boolean): void {
    this.remember();
    m.points = this.inView(m.page, m.points, (pts) => {
      const [cx, cy] = Measure.center(m.kind, pts);
      return pts.map(([x, y]) => (horizontal ? [2 * cx - x, y] : [x, 2 * cy - y]) as Pt);
    });
    this.redraw(m.page);
    this.markDirty();
  }

  /** Legger til en kopi av et mål (på samme eller en annen side). */
  private addCopy(src: Measurement, page: number, points: Pt[]): Measurement {
    const m: Measurement = { ...src, id: this.nextId++, page, points, fixed: page === src.page ? src.fixed : this.fixedAt(page, points[0]) };
    this.s.items.push(m);
    return m;
  }

  /** Punktene flyttet litt ned og til høyre (slik siden vises), for kopier. */
  private nudged(page: number, points: Pt[], times: number): Pt[] {
    // Visningens enheter per skjermpiksel (uten tegnet side: PDF-punkter).
    const layer = this.layers.get(page);
    const perPx = layer?.el.isConnected ? layer.geom.width / (layer.el.getBoundingClientRect().width || 1) : 1;
    const step = 16 * times * perPx;
    return this.inView(page, points, (pts) => pts.map(([x, y]) => [x + step, y + step] as Pt));
  }

  private duplicate(m: Measurement): void {
    this.remember();
    const copy = this.addCopy(m, m.page, this.nudged(m.page, m.points, 1));
    this.s.selected = copy.id;
    this.redraw(m.page);
    this.markDirty();
    this.updateHint();
  }

  private paste(): void {
    const c = this.clip;
    if (!c) return;
    const page = this.viewer.current;
    if (page >= this.viewer.pageCount) return;
    this.remember();
    // Samme side: litt forskjøvet, så kopien synes. Annen side: samme sted.
    const points = page === c.m.page ? this.nudged(page, c.m.points, ++c.pasted) : c.m.points.map((p) => [p[0], p[1]] as Pt);
    const copy = this.addCopy(c.m, page, points);
    this.s.selected = copy.id;
    this.redrawAll();
    this.markDirty();
    this.updateHint();
  }

  /** Dialog for å forskyve konturen (f.eks. byggegrense 4 m fra nabogrensen). */
  private askOffset(m: Measurement): void {
    const k = this.metersPerPoint(m);
    if (!k) return toast("Velg målestokk først", "error");
    const closed = m.kind === "area" || m.kind === "circle";
    const input = h("input", { type: "text", inputmode: "decimal", placeholder: this.unit === "mm" ? "f.eks. 4000" : "f.eks. 4" });
    const dir = h(
      "select",
      { "aria-label": "Retning" },
      ...(closed ? [h("option", { value: "1" }, "Utover"), h("option", { value: "-1" }, "Innover")] : [h("option", { value: "1" }, "Til den ene siden"), h("option", { value: "-1" }, "Til den andre siden")]),
    );
    const keep = h("input", { type: "checkbox", checked: true });
    const compute = (): Pt[] | null => {
      const v = parseNumber(input.value);
      if (v === null || v <= 0) return null;
      const d = ((this.unit === "mm" ? v / 1000 : v) / k) * Number(dir.value);
      if (m.kind === "circle") {
        const r = distance(m.points[0], m.points[1]);
        if (r + d <= 0) return null;
        const c = m.points[0];
        return [c, [c[0] + ((m.points[1][0] - c[0]) / r) * (r + d), c[1] + ((m.points[1][1] - c[1]) / r) * (r + d)]];
      }
      const out = offsetPath(m.points, d, closed);
      // Innover kan ikke bli større (da har figuren vrengt seg).
      if (closed && d < 0 && (polygonArea(out) >= polygonArea(m.points) || polygonArea(out) < 1e-6)) return null;
      return out;
    };
    const update = () => {
      const pts = compute();
      this.ghost = pts ? { page: m.page, points: m.kind === "circle" ? circlePoints(pts[0], distance(pts[0], pts[1]), 96) : pts, closed, color: m.color ?? DEFAULT_COLOR } : null;
      this.drawPreview(m.page);
    };
    input.addEventListener("input", update);
    dir.addEventListener("change", update);
    const ok = () => {
      const pts = compute();
      if (!pts) return toast(input.value.trim() ? "Avstanden er for stor innover" : "Skriv en avstand", "error");
      close();
      this.remember();
      if (keep.checked) {
        const copy = this.addCopy(m, m.page, pts);
        copy.name = undefined;
        this.s.selected = copy.id;
      } else m.points = pts;
      this.redraw(m.page);
      this.markDirty();
      this.updateHint();
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && ok());
    const body = h(
      "div",
      { class: "form" },
      h("div", { class: "row" }, input, h("span", { class: "unit-label" }, this.unit), dir),
      h("label", { class: "inline-field check" }, keep, h("span", {}, "Behold originalen (lag et nytt mål)")),
      h("p", { class: "muted" }, "Forhåndsvisningen vises stiplet på tegningen."),
    );
    const close = modal("Forskyv kontur", body, [button("Avbryt", null, () => close()), button("Forskyv", null, ok, { primary: true })], () => {
      this.ghost = null;
      this.drawPreview(m.page);
    });
  }

  /** Dialog for å rotere et mål et valgfritt antall grader. */
  private askRotate(m: Measurement): void {
    const input = h("input", { type: "text", inputmode: "decimal", placeholder: "f.eks. 15" });
    const read = () => parseNumber(input.value);
    input.addEventListener("input", () => {
      const v = read();
      this.ghost = v ? { page: m.page, points: this.rotated(m, v), closed: m.kind === "area", color: m.color ?? DEFAULT_COLOR } : null;
      this.drawPreview(m.page);
    });
    const ok = () => {
      const v = read();
      if (v === null) return toast("Skriv antall grader", "error");
      close();
      if (v) this.rotate(m, v);
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && ok());
    const body = h(
      "div",
      { class: "form" },
      h("label", { class: "field" }, h("span", {}, "Grader (positivt er mot klokka)"), input),
    );
    const close = modal("Roter", body, [button("Avbryt", null, () => close()), button("Roter", null, ok, { primary: true })], () => {
      this.ghost = null;
      this.drawPreview(m.page);
    });
  }

  /** Dialog for å kopiere et mål til andre sider (samme sted på siden). */
  private askCopyToPages(m: Measurement): void {
    const count = this.viewer.pageCount;
    const input = h("input", { type: "text", placeholder: count > 1 ? `f.eks. 2-${count} eller alle` : "1" });
    const ok = () => {
      const pages = parsePages(input.value, count)?.filter((p) => p !== m.page);
      if (!pages?.length) return toast(`Skriv sidetall mellom 1 og ${count} (f.eks. 2, 4-6), eller «alle»`, "error");
      close();
      this.remember();
      for (const p of pages) this.addCopy(m, p, m.points.map((q) => [q[0], q[1]] as Pt));
      this.redrawAll();
      this.markDirty();
      toast(`Kopiert til ${pages.length} ${pages.length === 1 ? "side" : "sider"}`, "success");
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && ok());
    const body = h(
      "div",
      { class: "form" },
      h("label", { class: "field" }, h("span", {}, "Sider"), input),
      h("p", { class: "muted" }, "Målet legges på samme sted på hver side – nyttig for f.eks. samme fotavtrykk på flere etasjeplaner."),
    );
    const close = modal("Kopier til andre sider", body, [button("Avbryt", null, () => close()), button("Kopier", null, ok, { primary: true })]);
  }

  /** Fjerner mål som ligger i sladdede områder (de ville ellers blitt skrevet til fila igjen). */
  removeInAreas(areas: Array<{ page: number; rect: [number, number, number, number] }>): number {
    const hit = (m: Measurement) =>
      areas.some((a) => a.page === m.page && m.points.some((p) => p[0] >= a.rect[0] && p[0] <= a.rect[2] && p[1] >= a.rect[1] && p[1] <= a.rect[3]));
    const gone = this.s.items.filter(hit);
    if (!gone.length) return 0;
    this.s.items = this.s.items.filter((m) => !hit(m));
    if (!this.s.items.some((m) => m.id === this.s.selected)) this.s.selected = null;
    this.redrawAll();
    this.markDirty();
    return gone.length;
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
    const sel = this.selectedItem();
    // Et mål kan skrives inn mens man tegner: «12,5» og Enter.
    if (this.drawing && !this.calibrating && !ctrl && !e.altKey && /^[0-9.,]$/.test(k)) {
      this.typed += k === "." ? "," : k;
      this.updateHint();
      this.drawPreview(this.drawing.page);
      return true;
    }
    if (this.typed && (k === "Backspace" || k === "Escape")) {
      this.typed = k === "Escape" ? "" : this.typed.slice(0, -1);
      this.updateHint();
      if (this.drawing) this.drawPreview(this.drawing.page);
      return true;
    }
    if (k === "Escape") {
      if (this.drawing || this.calibrating) this.cancelDrawing();
      else if (this.s.selected !== null) {
        this.s.selected = null;
        this.redrawAll();
        this.refreshPanel();
        this.updateHint();
      } else this.close();
    } else if (ctrl && k.toLowerCase() === "s") void this.save();
    else if (k === "Enter") {
      if (this.typed) this.applyTyped();
      else this.finish();
    } else if (k === "Backspace" && this.drawing) {
      this.drawing.points.pop();
      const page = this.drawing.page;
      if (!this.drawing.points.length) this.drawing = null;
      this.drawPreview(page);
      this.updateHint();
    } else if ((k === "Delete" || k === "Backspace") && sel) this.remove(sel.id);
    else if (ctrl && k.toLowerCase() === "z" && !this.drawing) this.undo();
    else if (ctrl && k.toLowerCase() === "c" && sel && !this.drawing) {
      this.clip = { m: { ...sel, points: sel.points.map((p) => [p[0], p[1]] as Pt) }, pasted: 0 };
      toast("Målet er kopiert – lim inn med Ctrl+V, også på en annen side");
    } else if (ctrl && k.toLowerCase() === "v" && this.clip && !this.drawing) this.paste();
    else if (ctrl && k.toLowerCase() === "d" && sel && !this.drawing) this.duplicate(sel);
    else if (ctrl || e.altKey) return false;
    else if (k === "d" || k === "D") this.setTool("distance");
    else if (k === "l" || k === "L") this.setTool("length");
    else if (k === "a" || k === "A") this.setTool("area");
    else if (k === "r" || k === "R") this.setTool("rect");
    else if (k === "s" || k === "S") this.setTool("circle");
    else return false;
    return true;
  }

  private updateHint(): void {
    // Mens man måler, skal etikettene til andre mål ikke fange klikkene.
    this.viewer.el.classList.toggle("m-drawing", !!this.drawing || this.calibrating);
    if (this.drawing || this.calibrating) delete this.viewer.el.dataset.mhover;
    const n = this.drawing?.points.length ?? 0;
    const type = " · skriv et mål og trykk Enter";
    let t: string;
    if (this.typed) t = `Mål: ${this.typed} ${this.unit} – Enter bruker det, Esc avbryter`;
    else if (this.calibrating) t = this.drawing ? "Klikk sluttpunktet på det kjente målet" : "Kalibrer: klikk startpunktet på et kjent mål";
    else if (!this.drawing && this.s.selected !== null) t = "Dra punkter eller kanter (Shift: 90°) · klikk et sidemål for å endre det · dobbeltklikk på kanten gir nytt punkt · Delete sletter";
    else if (!this.drawing) t = this.tool === "circle" ? "Klikk sentrum" : this.tool === "rect" ? "Klikk første hjørne" : this.tool === "distance" ? "Klikk startpunkt" : "Klikk første punkt";
    else if (this.tool === "distance") t = "Klikk sluttpunkt · Shift låser vinkelen" + type;
    else if (this.tool === "rect") t = n === 1 ? "Klikk enden av første side · Shift låser vinkelen" + type : "Klikk for bredden" + type;
    else if (this.tool === "circle") t = "Klikk for radien" + type;
    else if (this.tool === "length") t = "Klikk flere punkter · Shift: 90° · dobbeltklikk eller Enter avslutter" + type;
    else t = "Klikk hjørnene · Shift: 90° · klikk startpunktet eller dobbeltklikk for å lukke" + type;
    this.hint.textContent = t;
    this.hint.title = t;
  }

  // ---------- Verdier ----------

  private describe(m: Pick<Measurement, "kind" | "points" | "fixed" | "page">): { main: string; sub?: string; value: number | null; perimeter?: number | null } {
    const k = m.fixed?.metersPerPoint ?? this.scaleFor(m.page)?.metersPerPoint ?? null;
    if (m.kind === "area" || m.kind === "circle") {
      const r = m.kind === "circle" ? distance(m.points[0], m.points[1]) : 0;
      const a = m.kind === "circle" ? Math.PI * r * r : polygonArea(m.points);
      const per = m.kind === "circle" ? 2 * Math.PI * r : pathLength(m.points, true);
      if (k === null) {
        const cm2 = a * (PAPER_METERS_PER_POINT * 100) ** 2;
        return { main: `${cm2.toLocaleString("nb-NO", { maximumFractionDigits: 1 })} cm² på arket`, sub: m.kind === "circle" ? `r ${formatPaper(r)}` : undefined, value: null };
      }
      const sub = m.kind === "circle" ? `r ${formatLength(r * k, this.unit)}` : `omkrets ${formatLength(per * k, this.unit)}`;
      return { main: formatArea(a * k * k), sub, value: a * k * k, perimeter: per * k };
    }
    const len = pathLength(m.points);
    if (k === null) return { main: formatPaper(len), value: null };
    return { main: formatLength(len * k, this.unit), value: len * k };
  }

  private refreshSaveState(): void {
    this.count.textContent = this.s.items.length ? `(${this.s.items.length})` : "";
    this.panel.hidden = !this.active || (this.s.items.length === 0 && !this.dirty);
    this.saveBtn.disabled = !this.dirty;
    this.saveBtn.classList.toggle("primary", this.dirty);
    this.saveBtn.title = this.dirty ? "Lagre målene i PDF-fila (Ctrl+S)" : "Målene er lagret i fila";
  }

  private refreshPanel(): void {
    this.refreshSaveState();
    this.list.replaceChildren(
      ...this.s.items.map((m, i) => {
        const d = this.describe(m);
        const scale = m.fixed?.label ?? this.scaleFor(m.page)?.label ?? "uten målestokk";
        const selected = m.id === this.s.selected;
        const swatch = h("span", { class: "m-swatch small" });
        swatch.style.background = m.color ?? DEFAULT_COLOR;
        const row = h(
          "li",
          { class: selected ? "selected" : "" },
          h(
            "div",
            { class: "measure-row" },
            h("span", { class: "measure-nr" }, String(i + 1)),
            swatch,
            h(
              "span",
              { class: "measure-desc" },
              h("span", { class: "measure-value" }, m.name ? h("span", { class: "measure-name-tag" }, m.name) : null, d.main),
              h("span", { class: "muted" }, `${KIND_NAMES[m.kind]} · side ${m.page + 1} · ${scale}`),
            ),
            button("", "close", () => this.remove(m.id), { title: "Fjern", className: "ghost" }),
          ),
          selected ? this.props(m) : null,
        );
        row.addEventListener("click", (e) => {
          if (!(e.target as HTMLElement).closest("button, input, .measure-props")) this.select(m.id, true);
        });
        return row;
      }),
    );
    let area = 0;
    let areas = 0;
    let len = 0;
    let lens = 0;
    const byName = new Map<string, { sum: number; n: number }>();
    for (const m of this.s.items) {
      const v = this.describe(m).value;
      if (v === null) continue;
      if (m.kind === "area" || m.kind === "circle") {
        area += v;
        areas++;
        if (m.name) {
          const g = byName.get(m.name) ?? { sum: 0, n: 0 };
          g.sum += v;
          g.n++;
          byName.set(m.name, g);
        }
      } else {
        len += v;
        lens++;
      }
    }
    const parts: string[] = [];
    if (areas > 1) parts.push(`Sum areal: ${formatArea(area)}`);
    if (lens > 1) parts.push(`Sum lengder: ${formatLength(len, this.unit)}`);
    const groups = [...byName].filter(([, g]) => g.n > 1).map(([name, g]) => h("div", { class: "muted" }, `${name}: ${formatArea(g.sum)} (${g.n} stk.)`));
    this.totals.replaceChildren(h("div", {}, parts.join(" · ")), ...groups);
    this.totals.hidden = !parts.length && !groups.length;
  }

  /** Navn, farge og verktøy for valgt mål (under raden i lista). */
  private props(m: Measurement): HTMLElement {
    const name = h("input", { type: "text", class: "measure-name", placeholder: "Navn, f.eks. BYA eller Bod", maxlength: 200, "aria-label": "Navn" });
    name.value = m.name ?? "";
    let remembered = false;
    name.addEventListener("input", () => {
      if (!remembered) this.remember();
      remembered = true;
      m.name = name.value.trim() || undefined;
      this.redraw(m.page);
      this.markDirty(false);
    });
    name.addEventListener("change", () => (remembered = false));
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        this.refreshPanel();
        this.viewer.el.focus({ preventScroll: true });
      }
    });
    const swatches = h(
      "div",
      { class: "m-swatches" },
      ...PALETTE.map(([c, label]) => {
        const b = h("button", { type: "button", class: `m-swatch${(m.color ?? DEFAULT_COLOR) === c ? " active" : ""}`, title: label, "aria-label": label });
        b.style.background = c;
        b.addEventListener("click", () => this.setColor(c));
        return b;
      }),
    );
    const tool = (iconName: string, title: string, f: () => void) => button("", iconName, f, { title, className: "ghost" });
    const tools = h(
      "div",
      { class: "measure-tools" },
      tool("offset", "Forskyv kontur …", () => this.askOffset(m)),
      tool("copy", "Dupliser (Ctrl+D) – Ctrl+C / Ctrl+V kopierer, også til en annen side", () => this.duplicate(m)),
      tool("pages", "Kopier til andre sider …", () => this.askCopyToPages(m)),
      m.kind === "circle" ? null : tool("flipH", "Speil vannrett", () => this.mirror(m, true)),
      m.kind === "circle" ? null : tool("flipV", "Speil loddrett", () => this.mirror(m, false)),
      m.kind === "circle" ? null : tool("rotateRight", "Roter 90° med klokka", () => this.rotate(m, -90)),
      m.kind === "circle" ? null : tool("rotateFree", "Roter …", () => this.askRotate(m)),
    );
    return h("div", { class: "measure-props" }, name, swatches, tools);
  }

  /** Kopierer målene som tabulatordelt tekst, klar til å limes inn i Excel. */
  private async copyTable(): Promise<void> {
    const num = (v: number) => v.toFixed(2).replace(".", ",");
    const rows = [["Nr", "Navn", "Side", "Type", "Verdi", "Enhet", "Omkrets (m)", "Målestokk"].join("\t")];
    this.s.items.forEach((m, i) => {
      const d = this.describe(m);
      const scale = m.fixed?.label ?? this.scaleFor(m.page)?.label ?? "";
      const isArea = m.kind === "area" || m.kind === "circle";
      const unit = d.value === null ? "" : isArea ? "m²" : this.unit;
      const value = d.value === null ? d.main : num(!isArea && this.unit === "mm" ? d.value * 1000 : d.value);
      rows.push([i + 1, m.name ?? "", m.page + 1, KIND_NAMES[m.kind], value, unit, d.perimeter != null ? num(d.perimeter) : "", scale].join("\t"));
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

  private place(layer: Layer, el: HTMLElement, p: Pt): void {
    const [x, y] = this.toView(layer, p);
    el.style.left = `${(x / layer.geom.width) * 100}%`;
    el.style.top = `${(y / layer.geom.height) * 100}%`;
  }

  /** Etikett med verdien. Med `id` kan den klikkes (velger målet) og dras (flytter det). */
  private label(layer: Layer, at: Pt, text: { name?: string; main: string; sub?: string }, cls: string, color: string, id?: number): HTMLDivElement {
    const el = h(
      "div",
      { class: `measure-label ${cls}`, "data-id": id },
      text.name ? h("b", { class: "measure-label-name" }, text.name) : null,
      h("span", {}, text.main),
      text.sub ? h("small", {}, text.sub) : null,
    );
    el.style.setProperty("--mc", color);
    this.place(layer, el, at);
    return el;
  }

  private dot(layer: Layer, p: Pt, cls: string, color: string): HTMLDivElement {
    const el = h("div", { class: `measure-dot ${cls}` });
    el.style.setProperty("--mc", color);
    this.place(layer, el, p);
    return el;
  }

  private shape(layer: Layer, points: Pt[], closed: boolean, cls: string, color: string): SVGElement {
    const el = document.createElementNS(SVG, closed ? "polygon" : "polyline");
    el.setAttribute("points", points.map((p) => this.toView(layer, p).join(",")).join(" "));
    el.setAttribute("class", cls);
    el.setAttribute("style", `--mc:${color}`);
    el.setAttribute("vector-effect", "non-scaling-stroke");
    return el;
  }

  /** Linjene for et mål; sirkelen med radius når den er valgt eller tegnes. */
  private shapes(layer: Layer, m: Pick<Measurement, "kind" | "points">, cls: string, color: string, radius: boolean): SVGElement[] {
    if (m.kind !== "circle") return [this.shape(layer, m.points, m.kind === "area", `${cls} ${m.kind}`, color)];
    const out = [this.shape(layer, circlePoints(m.points[0], distance(m.points[0], m.points[1]), 96), true, `${cls} area circle`, color)];
    if (radius) out.push(this.shape(layer, m.points, false, `${cls} radius`, color));
    return out;
  }

  /**
   * Lengden på hver side (sirkel: radien), langs sidene. På valgt mål kan de
   * klikkes for å skrive inn en ny lengde. Korte sider får ingen etikett.
   */
  private segLabels(layer: Layer, m: Pick<Measurement, "kind" | "points" | "fixed" | "page" | "color">, id: number | null): HTMLElement[] {
    if (m.kind === "distance") return [];
    const k = m.fixed?.metersPerPoint ?? this.scaleFor(m.page)?.metersPerPoint ?? null;
    const ppp = this.pointsPerPixel(m.page);
    const n = m.points.length;
    const segs = m.kind === "circle" ? 1 : m.kind === "area" && n >= 3 ? n : n - 1;
    const out: HTMLElement[] = [];
    const view = m.points.map((p) => this.toView(layer, p));
    const perPx = layer.el.isConnected ? layer.geom.width / (layer.el.getBoundingClientRect().width || 1) : 1;
    for (let i = 0; i < segs; i++) {
      const a = m.points[i];
      const b = m.points[(i + 1) % n];
      const len = distance(a, b);
      if (len / ppp < 34) continue;
      const text = k === null ? formatPaper(len).replace(" på arket", "") : formatLength(len * k, this.unit);
      const editable = id !== null && k !== null;
      const el = h(
        "div",
        { class: `measure-seg${editable ? " edit" : ""}`, "data-id": editable ? id : undefined, "data-seg": editable ? i : undefined, title: editable ? "Klikk for å skrive inn en ny lengde" : undefined },
        m.kind === "circle" ? `r ${text}` : text,
      );
      el.style.setProperty("--mc", m.color ?? DEFAULT_COLOR);
      // Litt utenfor siden (utenfor figuren), så selve kanten kan gripes og dras.
      const va = this.toView(layer, a);
      const vb = this.toView(layer, b);
      const vl = Math.hypot(vb[0] - va[0], vb[1] - va[1]) || 1;
      let nx = -(vb[1] - va[1]) / vl;
      let ny = (vb[0] - va[0]) / vl;
      const mid: Pt = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2];
      if (m.kind === "area" && insidePolygon([mid[0] + nx, mid[1] + ny], view)) [nx, ny] = [-nx, -ny];
      const off = m.kind === "circle" ? 0 : 5 * perPx;
      el.style.left = `${((mid[0] + nx * off) / layer.geom.width) * 100}%`;
      el.style.top = `${((mid[1] + ny * off) / layer.geom.height) * 100}%`;
      // Etiketten legges helt på utsiden: den nære kanten av boksen ved punktet.
      if (m.kind !== "circle") el.style.transform = `translate(${(nx - 1) * 50}%, ${(ny - 1) * 50}%)`;
      out.push(el);
    }
    return out;
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

  private labelAt(m: Pick<Measurement, "kind" | "points">): Pt {
    return m.kind === "area" ? centroid(m.points) : m.kind === "circle" ? m.points[0] : this.midpoint(m.points);
  }

  private redraw(page: number): void {
    const layer = this.layers.get(page);
    if (!layer) return;
    const shapes: SVGElement[] = [];
    const labels: HTMLElement[] = [];
    for (const m of this.s.items) {
      if (m.page !== page) continue;
      const isSel = m.id === this.s.selected;
      const sel = isSel ? " selected" : "";
      const color = m.color ?? DEFAULT_COLOR;
      shapes.push(...this.shapes(layer, m, `m-shape${sel}`, color, isSel));
      if (m.kind !== "circle" || isSel) for (const p of m.points) labels.push(this.dot(layer, p, sel, color));
      if (isSel) labels.push(...this.segLabels(layer, m, m.id));
      const d = this.describe(m);
      labels.push(this.label(layer, this.labelAt(m), { name: m.name, main: d.main, sub: d.sub }, sel, color, m.id));
    }
    const preview = document.createElementNS(SVG, "g");
    preview.setAttribute("class", "m-preview");
    layer.svg.replaceChildren(...shapes, preview);
    const previewLabels = h("div", { class: "measure-preview" });
    layer.labels.replaceChildren(...labels, previewLabels);
    this.drawPreview(page);
  }

  /** Den pågående målingen, med gummistrikk til musepekeren (og forhåndsvisning fra dialoger). */
  private drawPreview(page: number): void {
    const layer = this.layers.get(page);
    if (!layer) return;
    const g = layer.svg.querySelector(".m-preview");
    const box = layer.labels.querySelector(".measure-preview");
    if (!g || !box) return;
    const svgs: SVGElement[] = [];
    const html: HTMLElement[] = [];
    const ghost = this.ghost?.page === page ? this.ghost : null;
    if (ghost) svgs.push(this.shape(layer, ghost.points, ghost.closed, `m-shape preview ${ghost.closed ? "area" : "length"}`, ghost.color));
    const d = this.drawing?.page === page ? this.drawing : null;
    if (d) {
      const cur = this.cursor?.page === page ? this.cursor.p : null;
      const raw = cur ? [...d.points, cur] : d.points;
      const tool: Tool = this.calibrating ? "distance" : this.tool;
      let kind: MeasureKind;
      let pts: Pt[];
      if (tool === "rect") {
        kind = raw.length >= 3 ? "area" : "distance";
        pts = raw.length >= 3 ? rectFrom(raw[0], raw[1], raw[2]) : raw;
      } else if (tool === "circle") {
        kind = raw.length >= 2 ? "circle" : "distance";
        pts = raw.slice(0, 2);
      } else {
        kind = tool;
        pts = raw;
      }
      const closed = kind === "circle" || (kind === "area" && pts.length >= 3);
      const shownKind: MeasureKind = kind === "area" && !closed ? "length" : kind;
      const fake = { page, kind: shownKind, points: pts, fixed: this.fixedAt(page, d.points[0]), color: this.color };
      for (const s of this.shapes(layer, fake, `m-shape preview${this.calibrating ? " calibrate" : ""}`, this.color, true)) svgs.push(s);
      for (const p of d.points) html.push(this.dot(layer, p, "preview", this.color));
      if (pts.length >= 2) {
        const desc = this.calibrating ? { main: formatPaper(pathLength(pts)), sub: undefined } : this.describe(fake);
        if (!this.calibrating) html.push(...this.segLabels(layer, fake, null));
        const at = closed ? this.labelAt(fake) : (cur ?? pts[pts.length - 1]);
        html.push(this.label(layer, at, { main: desc.main, sub: desc.sub }, `preview${closed ? "" : " at-cursor"}`, this.color));
      }
      if (this.typed) {
        const t = h("div", { class: "measure-typed" }, `${this.typed} ${this.unit} ↵`);
        this.place(layer, t, cur ?? d.points[d.points.length - 1]);
        html.push(t);
      }
    }
    g.replaceChildren(...svgs);
    box.replaceChildren(...html);
  }
}
