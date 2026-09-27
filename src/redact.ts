// «Sladd»: merk områder (dra, eller søk etter tekst), se over, og sladd.
// Selve fjerningen gjøres i redact-pdf.ts når man trykker «Sladd».
import type { Pt } from "./measure-math";
import type { PDFDocumentProxy } from "./pdf";
import type { Rect, RedactArea } from "./redact-pdf";
import { button, h, toast } from "./ui";
import type { PageGeometry, Viewer } from "./viewer";

interface Mark extends RedactArea {
  id: number;
}

interface Layer {
  el: HTMLDivElement;
  svg: SVGSVGElement;
  geom: PageGeometry;
}

const SVG = "http://www.w3.org/2000/svg";

export class Redactor {
  readonly bar: HTMLDivElement;
  active = false;
  private doc: PDFDocumentProxy | null = null;
  /** Merkingene per dokument (de er midlertidige til man trykker «Sladd»). */
  private marksByDoc = new WeakMap<PDFDocumentProxy, Mark[]>();
  private nextId = 1;
  private selected: number | null = null;
  private layers = new Map<number, Layer>();
  private drawing: { page: number; a: Pt; b: Pt; x: number; y: number } | null = null;
  private toolBefore: "select" | "hand" = "select";
  private applyBtn: HTMLButtonElement;
  private search: HTMLInputElement;

  onChange: () => void = () => {};
  /** Sladder områdene (hovedprogrammet skriver endringen inn i dokumentet). */
  onApply: (areas: RedactArea[]) => Promise<boolean> = async () => false;

  constructor(private readonly viewer: Viewer) {
    this.search = h("input", { type: "search", class: "redact-search", placeholder: "Søk etter tekst å sladde, f.eks. et beløp", "aria-label": "Søk etter tekst å sladde" });
    this.search.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") void this.markMatches();
      if (e.key === "Escape") this.search.blur();
    });
    this.applyBtn = button("Sladd", "redact", () => void this.apply(), { primary: true, className: "danger", title: "Fjern innholdet under de merkede områdene for godt" });
    this.bar = h(
      "div",
      { class: "subbar redact-bar", hidden: true },
      h("strong", {}, "Sladd"),
      this.search,
      button("Merk treff", null, () => void this.markMatches(), { title: "Merk alle steder teksten står, i hele dokumentet" }),
      h("span", { class: "sep" }),
      h("span", { class: "measure-hint muted" }, "Dra over det som skal sladdes · klikk en merking og trykk Delete for å fjerne den"),
      button("Fjern merkingene", null, () => this.clear(), { className: "ghost" }),
      this.applyBtn,
      button("", "close", () => this.close(), { title: "Avslutt sladding (Esc)", className: "ghost" }),
    );
    this.setupPointer();
    const prev = viewer.onPageRendered;
    viewer.onPageRendered = (page, pageEl, geom) => {
      prev?.(page, pageEl, geom);
      this.attach(page, pageEl, geom);
    };
    this.refreshBar();
  }

  private get marks(): Mark[] {
    if (!this.doc) return [];
    let m = this.marksByDoc.get(this.doc);
    if (!m) this.marksByDoc.set(this.doc, (m = []));
    return m;
  }

  private set marks(v: Mark[]) {
    if (this.doc) this.marksByDoc.set(this.doc, v);
  }

  /** Merkinger som ikke er sladdet ennå (for å spørre før fanen lukkes). */
  pendingFor(doc: PDFDocumentProxy): number {
    return this.marksByDoc.get(doc)?.length ?? 0;
  }

  setDocument(doc: PDFDocumentProxy | null): void {
    this.drawing = null;
    this.selected = null;
    this.doc = doc;
    this.layers.clear();
    this.refreshBar();
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
    this.viewer.el.classList.add("redacting");
    this.bar.hidden = false;
    this.refreshBar();
    this.onChange();
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    this.drawing = null;
    this.selected = null;
    this.viewer.el.classList.remove("redacting");
    this.viewer.tool = this.toolBefore;
    this.bar.hidden = true;
    this.redrawAll();
    this.onChange();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === "Escape") {
      if (this.drawing) this.drawing = null;
      else if (this.selected !== null) this.selected = null;
      else return this.close(), true;
      this.redrawAll();
    } else if ((e.key === "Delete" || e.key === "Backspace") && this.selected !== null) {
      this.marks = this.marks.filter((m) => m.id !== this.selected);
      this.selected = null;
      this.redrawAll();
      this.refreshBar();
    } else return false;
    return true;
  }

  private refreshBar(): void {
    const n = this.marks.length;
    this.applyBtn.disabled = !n;
    this.applyBtn.querySelector("span")!.textContent = n ? `Sladd (${n})` : "Sladd";
  }

  private clear(): void {
    this.marks = [];
    this.selected = null;
    this.redrawAll();
    this.refreshBar();
  }

  private add(page: number, rect: Rect): void {
    this.marks = [...this.marks, { id: this.nextId++, page, rect }];
    this.redraw(page);
    this.refreshBar();
  }

  private async apply(): Promise<void> {
    const marks = this.marks;
    if (!marks.length) return;
    if (await this.onApply(marks.map((m) => ({ page: m.page, rect: m.rect })))) {
      // Dokumentet er byttet ut; merkingene hørte til det gamle.
      this.selected = null;
      this.refreshBar();
    }
  }

  /** Merker alle steder teksten i søkefeltet står. */
  private async markMatches(): Promise<void> {
    const term = this.search.value.trim().toLowerCase().replace(/\s+/g, " ");
    const doc = this.doc;
    if (!term || !doc) return;
    let count = 0;
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        if (!("str" in it) || !it.str) continue;
        const str = it.str.toLowerCase().replace(/\s/g, " ");
        const t = it.transform;
        const size = Math.hypot(t[2], t[3]) || it.height || 10;
        const len = Math.hypot(t[0], t[1]) || 1;
        const d: Pt = [t[0] / len, t[1] / len];
        const n: Pt = [-d[1], d[0]];
        for (let at = str.indexOf(term); at >= 0; at = str.indexOf(term, at + 1)) {
          // Tegnenes plass anslås ut fra andelen av teksten, med litt margin.
          const u0 = (at / str.length) * it.width - size * 0.25;
          const u1 = ((at + term.length) / str.length) * it.width + size * 0.25;
          const pts: Pt[] = [
            [t[4] + d[0] * u0 + n[0] * -size * 0.3, t[5] + d[1] * u0 + n[1] * -size * 0.3],
            [t[4] + d[0] * u1 + n[0] * -size * 0.3, t[5] + d[1] * u1 + n[1] * -size * 0.3],
            [t[4] + d[0] * u1 + n[0] * size * 1.05, t[5] + d[1] * u1 + n[1] * size * 1.05],
            [t[4] + d[0] * u0 + n[0] * size * 1.05, t[5] + d[1] * u0 + n[1] * size * 1.05],
          ];
          const rect: Rect = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
          if (!this.marks.some((m) => m.page === i && m.rect.every((v, k) => Math.abs(v - rect[k]) < 0.5))) {
            this.marks = [...this.marks, { id: this.nextId++, page: i, rect }];
            count++;
          }
        }
      }
      if (this.doc !== doc) return;
    }
    this.redrawAll();
    this.refreshBar();
    toast(count ? `${count} treff merket. Se over merkingene før du sladder.` : `Fant ikke «${this.search.value.trim()}».`, count ? "success" : "info");
  }

  // ---------- Mus ----------

  private setupPointer(): void {
    const el = this.viewer.el;
    el.addEventListener("pointerdown", (e) => {
      if (!this.active || e.button !== 0 || this.viewer.panKeyHeld || this.viewer.tool === "hand") return;
      if (!(e.target as HTMLElement).closest(".page")) return;
      e.preventDefault();
      el.focus({ preventScroll: true });
      const hit = this.hitPage(e);
      if (!hit) return;
      const mark = [...this.marks].reverse().find((m) => m.page === hit.page && hit.p[0] >= m.rect[0] && hit.p[0] <= m.rect[2] && hit.p[1] >= m.rect[1] && hit.p[1] <= m.rect[3]);
      if (mark) {
        this.selected = mark.id;
        this.redrawAll();
        return;
      }
      this.selected = null;
      this.drawing = { page: hit.page, a: hit.p, b: hit.p, x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.active || !this.drawing) return;
      const hit = this.hitPage(e, this.drawing.page);
      if (!hit) return;
      this.drawing.b = hit.p;
      this.redraw(this.drawing.page);
    });
    el.addEventListener("pointerup", (e) => {
      const d = this.drawing;
      this.drawing = null;
      if (!this.active || !d) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) {
        this.add(d.page, [Math.min(d.a[0], d.b[0]), Math.min(d.a[1], d.b[1]), Math.max(d.a[0], d.b[0]), Math.max(d.a[1], d.b[1])]);
      } else this.redraw(d.page);
    });
  }

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
    const [x, y] = g.convertToPdfPoint(((e.clientX - r.left) / r.width) * g.width, ((e.clientY - r.top) / r.height) * g.height) as number[];
    return { page, p: [x, y] };
  }

  // ---------- Tegning ----------

  private attach(page: number, pageEl: HTMLDivElement, geom: PageGeometry): void {
    let layer = this.layers.get(page);
    if (!layer) {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("preserveAspectRatio", "none");
      const el = h("div", { class: "redactLayer" });
      el.append(svg);
      layer = { el, svg, geom };
      this.layers.set(page, layer);
    }
    layer.geom = geom;
    layer.svg.setAttribute("viewBox", `0 0 ${geom.width} ${geom.height}`);
    pageEl.append(layer.el);
    this.redraw(page);
  }

  private redrawAll(): void {
    for (const p of this.layers.keys()) this.redraw(p);
  }

  private redraw(page: number): void {
    const layer = this.layers.get(page);
    if (!layer) return;
    const g = layer.geom;
    const poly = (r: Rect, cls: string) => {
      const el = document.createElementNS(SVG, "polygon");
      const pts: Pt[] = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
      el.setAttribute("points", pts.map((p) => g.convertToViewportPoint(p[0], p[1]).join(",")).join(" "));
      el.setAttribute("class", cls);
      return el;
    };
    const nodes = this.marks.filter((m) => m.page === page).map((m) => poly(m.rect, `redact-mark${m.id === this.selected ? " selected" : ""}`));
    const d = this.drawing?.page === page ? this.drawing : null;
    if (d) nodes.push(poly([Math.min(d.a[0], d.b[0]), Math.min(d.a[1], d.b[1]), Math.max(d.a[0], d.b[0]), Math.max(d.a[1], d.b[1])], "redact-mark drawing"));
    layer.svg.replaceChildren(...nodes);
  }
}
