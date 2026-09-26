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
  metersPerPointForScale,
  pathLength,
  PAPER_METERS_PER_POINT,
  polygonArea,
  readPdfScales,
  regionAt,
  scaleLabel,
  snap45,
  type PdfScaleRegion,
  type Pt,
} from "./measure-math";
import { button, h, modal, toast } from "./ui";
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

interface Layer {
  el: HTMLDivElement;
  svg: SVGSVGElement;
  labels: HTMLDivElement;
  geom: PageGeometry;
}

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
  private pdfScales = new Map<number, PdfScaleRegion[]>();
  private pageScale = new Map<number, Scale>();
  private defaultScale: Scale | null = null;
  private items: Measurement[] = [];
  private nextId = 1;
  private selected: number | null = null;
  private drawing: { page: number; points: Pt[] } | null = null;
  private calibrating = false;
  private cursor: { page: number; p: Pt } | null = null;
  private layers = new Map<number, Layer>();
  private token = 0;
  private toolBefore: "select" | "hand" = "select";
  private down: { x: number; y: number } | null = null;

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
      h("span", { class: "spacer" }),
      this.hint,
      button("", "close", () => this.close(), { title: "Avslutt måling (Esc)", className: "ghost" }),
    );

    this.list = h("ol", { class: "measure-list" });
    this.totals = h("div", { class: "measure-totals" });
    this.count = h("span", {});
    this.panel = h(
      "div",
      { class: "measure-panel", hidden: true },
      h(
        "header",
        {},
        h("strong", {}, "Mål ", this.count),
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

  /** Nytt dokument: nullstill mål og les innebygd målestokk i bakgrunnen. */
  setDocument(bytes: Uint8Array | null): void {
    const token = ++this.token;
    this.items = [];
    this.selected = null;
    this.drawing = null;
    this.calibrating = false;
    this.pdfScales = new Map();
    this.pageScale.clear();
    this.defaultScale = null;
    this.layers.clear();
    this.refreshPanel();
    this.refreshScaleUi();
    if (!bytes) return;
    readPdfScales(bytes)
      .then((scales) => {
        if (token !== this.token) return;
        this.pdfScales = scales;
        this.refreshScaleUi();
        this.redrawAll();
      })
      .catch(() => {
        /* Uleselig eller kryptert: da finnes bare manuell målestokk. */
      });
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
    this.panel.hidden = this.items.length === 0;
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
    return this.pageScale.get(page) ?? this.defaultScale;
  }

  private metersPerPoint(m: Measurement): number | null {
    return m.fixed?.metersPerPoint ?? this.scaleFor(m.page)?.metersPerPoint ?? null;
  }

  private refreshScaleUi(): void {
    const page = this.viewer.current;
    const current = this.scaleFor(page);
    const opts: HTMLOptionElement[] = [h("option", { value: "none" }, this.pdfScales.get(page)?.length ? "Ikke valgt" : "Ikke valgt (mål på arket)")];
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

    const regions = this.pdfScales.get(page);
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
    if (scale) this.pageScale.set(page, scale);
    else this.pageScale.delete(page);
    this.defaultScale = scale;
    this.refreshScaleUi();
    this.redrawAll();
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
      if ((e.target as HTMLElement).closest(".measure-label")) return;
      this.down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerup", (e) => {
      const d = this.down;
      this.down = null;
      if (!this.active || !d || e.button !== 0) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      const hit = this.hitPage(e);
      if (hit) this.click(hit.page, hit.p, e.shiftKey);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.active || (!this.drawing && !this.calibrating)) return;
      const hit = this.hitPage(e);
      if (!hit || (this.drawing && hit.page !== this.drawing.page)) return;
      let p = hit.p;
      const last = this.drawing?.points.at(-1);
      if (last && e.shiftKey) p = snap45(last, p);
      this.cursor = { page: hit.page, p };
      this.drawPreview(hit.page);
    });
    el.addEventListener("dblclick", (e) => {
      if (!this.active) return;
      e.preventDefault();
      if (this.drawing && this.kind !== "distance") this.finish();
    });
  }

  /** Siden og PDF-punktet under musepekeren. */
  private hitPage(e: MouseEvent): { page: number; p: Pt } | null {
    const pageEl = (e.target as HTMLElement).closest(".page") as HTMLElement | null;
    if (!pageEl) return null;
    const page = Number(pageEl.dataset.index);
    const layer = this.layers.get(page);
    if (!layer) return null;
    const r = pageEl.getBoundingClientRect();
    const g = layer.geom;
    const vx = ((e.clientX - r.left) / r.width) * g.width;
    const vy = ((e.clientY - r.top) / r.height) * g.height;
    const [x, y] = g.convertToPdfPoint(vx, vy) as number[];
    return { page, p: [x, y] };
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
    this.selected = null;
    if (this.kind === "distance" && this.drawing.points.length === 2) return this.finish();
    this.updateHint();
    this.drawPreview(page);
  }

  private finish(): void {
    const d = this.drawing;
    if (!d) return;
    const need = this.kind === "area" ? 3 : 2;
    if (d.points.length < need) return;
    const region = regionAt(this.pdfScales.get(d.page), d.points[0]);
    const m: Measurement = {
      id: this.nextId++,
      page: d.page,
      kind: this.kind,
      points: d.points,
      fixed: region ? { metersPerPoint: region.metersPerPoint, label: `${region.label} fra PDF` } : null,
    };
    this.items.push(m);
    this.selected = m.id;
    this.drawing = null;
    this.cursor = null;
    this.redraw(d.page);
    this.refreshPanel();
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
    const m = this.items.find((x) => x.id === id);
    if (!m) return;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.selected === id) this.selected = null;
    this.redraw(m.page);
    this.refreshPanel();
  }

  private clearAll(): void {
    const pages = new Set(this.items.map((m) => m.page));
    this.items = [];
    this.selected = null;
    for (const p of pages) this.redraw(p);
    this.refreshPanel();
  }

  private select(id: number, reveal: boolean): void {
    this.selected = id;
    const m = this.items.find((x) => x.id === id);
    if (!m) return;
    if (reveal && m.page !== this.viewer.current) this.viewer.goToPage(m.page);
    this.redrawAll();
    this.refreshPanel();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === "Escape") {
      if (this.drawing || this.calibrating) this.cancelDrawing();
      else if (this.selected !== null) {
        this.selected = null;
        this.redrawAll();
        this.refreshPanel();
      } else this.close();
    } else if (k === "Enter") this.finish();
    else if (k === "Backspace" && this.drawing) {
      this.drawing.points.pop();
      const page = this.drawing.page;
      if (!this.drawing.points.length) this.drawing = null;
      this.drawPreview(page);
      this.updateHint();
    } else if ((k === "Delete" || k === "Backspace") && this.selected !== null) this.remove(this.selected);
    else if (ctrl && k.toLowerCase() === "z" && !this.drawing && this.items.length) this.remove(this.items[this.items.length - 1].id);
    else if (!ctrl && (k === "d" || k === "D")) this.setKind("distance");
    else if (!ctrl && (k === "l" || k === "L")) this.setKind("length");
    else if (!ctrl && (k === "a" || k === "A")) this.setKind("area");
    else return false;
    return true;
  }

  private updateHint(): void {
    let t: string;
    if (this.calibrating) t = this.drawing ? "Klikk sluttpunktet på det kjente målet" : "Kalibrer: klikk startpunktet på et kjent mål";
    else if (!this.drawing) t = this.kind === "distance" ? "Klikk startpunkt" : "Klikk første punkt";
    else if (this.kind === "distance") t = "Klikk sluttpunkt · Shift låser vinkelen";
    else if (this.kind === "length") t = "Klikk flere punkter · dobbeltklikk eller Enter avslutter";
    else t = "Klikk hjørnene · klikk startpunktet, dobbeltklikk eller Enter lukker";
    this.hint.textContent = t;
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
    this.count.textContent = this.items.length ? `(${this.items.length})` : "";
    this.panel.hidden = !this.active || this.items.length === 0;
    this.list.replaceChildren(
      ...this.items.map((m, i) => {
        const d = this.describe(m);
        const scale = m.fixed?.label ?? this.scaleFor(m.page)?.label ?? "uten målestokk";
        const row = h(
          "li",
          { class: m.id === this.selected ? "selected" : "" },
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
    for (const m of this.items) {
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
    this.items.forEach((m, i) => {
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
    toast(`${this.items.length} mål kopiert – lim inn i Excel`, "success");
  }

  // ---------- Tegning på sidene ----------

  /** Kalles hver gang visningen har tegnet en side. */
  private attach(page: number, pageEl: HTMLDivElement, geom: PageGeometry): void {
    let layer = this.layers.get(page);
    if (!layer) {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("preserveAspectRatio", "none");
      const labels = h("div", { class: "measure-labels" });
      const el = h("div", { class: "measureLayer" });
      el.append(svg, labels);
      layer = { el, svg, labels, geom };
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

  private label(layer: Layer, at: Pt, main: string, sub: string | undefined, cls: string, onClick?: () => void): HTMLDivElement {
    const [x, y] = this.toView(layer, at);
    const el = h("div", { class: `measure-label ${cls}` }, h("span", {}, main), sub ? h("small", {}, sub) : null);
    el.style.left = `${(x / layer.geom.width) * 100}%`;
    el.style.top = `${(y / layer.geom.height) * 100}%`;
    if (onClick) {
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
    }
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
    for (const m of this.items) {
      if (m.page !== page) continue;
      const sel = m.id === this.selected ? " selected" : "";
      const closed = m.kind === "area";
      shapes.push(this.shape(layer, m.points, closed, `m-shape ${m.kind}${sel}`));
      for (const p of m.points) labels.push(this.dot(layer, p, sel));
      const d = this.describe(m);
      const at = closed ? centroid(m.points) : this.midpoint(m.points);
      labels.push(this.label(layer, at, d.main, d.sub, sel, () => this.select(m.id, false)));
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
      const region = regionAt(this.pdfScales.get(page), d.points[0]);
      if (region) fake.fixed = { metersPerPoint: region.metersPerPoint, label: region.label };
      const desc = this.calibrating ? { main: formatPaper(pathLength(pts)), sub: undefined } : this.describe(fake);
      const at = closed ? centroid(pts) : (cur ?? pts[pts.length - 1]);
      text = this.label(layer, at, desc.main, desc.sub, `preview${closed ? "" : " at-cursor"}`);
    }
    box.replaceChildren(...dots, ...(text ? [text] : []));
  }
}
