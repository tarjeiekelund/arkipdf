// «Rediger tekst» (E): pek på en tekstlinje, klikk og skriv ny tekst. Selve
// endringen gjøres i textedit-pdf.ts; her er visningen: linjen under musa
// markeres, og et skrivefelt legges over linjen som skal endres.
import type { Pt } from "./measure-math";
import type { PDFDocumentProxy } from "./pdf";
import { groupLines, lineContains, onLine, type Run, type TextItemLike, type TextLine } from "./textedit-pdf";
import { button, h } from "./ui";
import type { PageGeometry, Viewer } from "./viewer";

interface Layer {
  el: HTMLDivElement;
  svg: SVGSVGElement;
  geom: PageGeometry;
}

const SVG = "http://www.w3.org/2000/svg";

export class TextEditor {
  readonly bar: HTMLDivElement;
  active = false;
  private doc: PDFDocumentProxy | null = null;
  private lines = new Map<number, Promise<TextLine[]>>();
  private loaded = new Map<number, TextLine[]>();
  private layers = new Map<number, Layer>();
  private hover: { page: number; line: TextLine } | null = null;
  /** Siste musebevegelse, så linjen kan markeres når linjene er lest inn. */
  private lastMove: MouseEvent | null = null;
  private editor: { el: HTMLInputElement; line: TextLine; done: boolean } | null = null;
  private toolBefore: "select" | "hand" = "select";
  private hint: HTMLSpanElement;

  onChange: () => void = () => {};
  /** Tekstkommandoene på en side (for å skille synlig tekst fra skjult). */
  runsFor: (page: number) => Promise<Run[]> = async () => [];
  /** Utfører endringen (hovedprogrammet skriver den inn i dokumentet). */
  onEdit: (line: TextLine, text: string) => Promise<void> = async () => {};

  constructor(private readonly viewer: Viewer) {
    this.hint = h("span", { class: "measure-hint muted" }, "Klikk en tekstlinje for å endre den · Enter bruker endringen · Esc avbryter · Ctrl+Z angrer");
    this.bar = h(
      "div",
      { class: "subbar textedit-bar", hidden: true },
      h("strong", {}, "Rediger tekst"),
      h("span", { class: "muted small" }, "Samme font brukes når den finnes på PC-en."),
      h("span", { class: "spacer" }),
      this.hint,
      button("", "close", () => this.close(), { title: "Avslutt redigering (Esc)", className: "ghost" }),
    );
    this.setupPointer();
    const prev = viewer.onPageRendered;
    viewer.onPageRendered = (page, pageEl, geom) => {
      prev?.(page, pageEl, geom);
      this.attach(page, pageEl, geom);
    };
  }

  setDocument(doc: PDFDocumentProxy | null): void {
    this.closeEditor(false);
    this.doc = doc;
    this.lines.clear();
    this.loaded.clear();
    this.layers.clear();
    this.hover = null;
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
    this.viewer.el.classList.add("editing-text");
    this.bar.hidden = false;
    for (const page of this.layers.keys()) this.pageLines(page);
    this.onChange();
  }

  close(): void {
    if (!this.active) return;
    this.closeEditor(false);
    this.active = false;
    this.setHover(null);
    this.viewer.el.classList.remove("editing-text");
    this.viewer.tool = this.toolBefore;
    this.bar.hidden = true;
    this.onChange();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active || e.key !== "Escape") return false;
    this.close();
    return true;
  }

  /** Tekstlinjene på en side (leses første gang siden brukes). */
  private pageLines(page: number): TextLine[] | null {
    const cached = this.loaded.get(page);
    if (cached) return cached;
    if (!this.lines.has(page) && this.doc) {
      const doc = this.doc;
      const lines = doc
        .getPage(page + 1)
        .then((pg) => pg.getTextContent())
        .then((tc) => groupLines(tc.items.filter((i) => "str" in i) as TextItemLike[], page));
      // Bare linjer med synlig tekst: skjulte lag og usynlig OCR-tekst kan ikke redigeres.
      const p = Promise.all([lines, this.runsFor(page).catch(() => [] as Run[])])
        .then(([ls, runs]) => {
          if (!runs.length) return ls;
          const visible = runs.filter((r) => this.visible(page, r));
          return ls.filter((l) => visible.some((r) => onLine(l, r.a, r.b)));
        })
        .catch(() => [] as TextLine[]);
      this.lines.set(page, p);
      void p.then((l) => {
        if (this.doc !== doc) return;
        this.loaded.set(page, l);
        if (this.active && !this.editor && this.lastMove) this.setHover(this.hit(this.lastMove));
      });
    }
    return null;
  }

  private setupPointer(): void {
    const el = this.viewer.el;
    el.addEventListener("pointermove", (e) => {
      if (!this.active || this.editor || e.buttons) return;
      this.lastMove = e;
      const hit = this.hit(e);
      this.setHover(hit);
    });
    el.addEventListener("pointerleave", () => {
      if (this.active && !this.editor) this.setHover(null);
    });
    el.addEventListener("pointerdown", (e) => {
      if (!this.active || e.button !== 0 || this.viewer.panKeyHeld || this.viewer.tool === "hand") return;
      if ((e.target as HTMLElement).closest(".textedit-input")) return;
      if (!(e.target as HTMLElement).closest(".page")) return;
      e.preventDefault();
      if (this.editor) {
        // Klikk utenfor skrivefeltet: bruk endringen.
        void this.commit();
        return;
      }
      const hit = this.hit(e);
      if (hit) this.openEditor(hit.page, hit.line);
    });
  }

  private hit(e: MouseEvent): { page: number; line: TextLine } | null {
    const pageEl = (e.target as HTMLElement).closest(".page") as HTMLElement | null;
    if (!pageEl) return null;
    const page = Number(pageEl.dataset.index);
    const layer = this.layers.get(page);
    const lines = this.pageLines(page);
    if (!layer || !lines) return null;
    const r = pageEl.getBoundingClientRect();
    const g = layer.geom;
    const [x, y] = g.convertToPdfPoint(((e.clientX - r.left) / r.width) * g.width, ((e.clientY - r.top) / r.height) * g.height) as number[];
    const pad = (g.width / (r.width || 1)) * 3;
    // Minste linje først, så en kort linje inni en lang (f.eks. i en tabell) kan velges.
    const hits = lines.filter((l) => lineContains(l, [x, y], pad)).sort((a, b) => a.length - b.length);
    return hits[0] ? { page, line: hits[0] } : null;
  }

  /**
   * Om teksten kan ses. Skjulte lag og usynlig tekst er merket av tolkingen;
   * hvit tekst (vanlig i maler) sjekkes mot den tegnede siden: er det lyst
   * rundt, er den usynlig.
   */
  private visible(page: number, r: Run): boolean {
    if (r.hidden) return false;
    if (Math.min(...r.color) < 0.94) return true;
    const layer = this.layers.get(page);
    const canvas = layer?.el.parentElement?.querySelector("canvas");
    const ctx = canvas?.getContext("2d");
    if (!layer || !canvas || !ctx) return true;
    const g = layer.geom;
    let sum = 0;
    let count = 0;
    // Bakgrunnen rett over og under linjen (der ligger ikke annen tekst på samme linje).
    const n: Pt = [-(r.b[1] - r.a[1]), r.b[0] - r.a[0]];
    const nl = Math.hypot(n[0], n[1]) || 1;
    for (const t of [0.15, 0.5, 0.85]) {
      for (const v of [r.size * 1.15, -r.size * 0.45]) {
        const px = r.a[0] + (r.b[0] - r.a[0]) * t + (n[0] / nl) * v;
        const py = r.a[1] + (r.b[1] - r.a[1]) * t + (n[1] / nl) * v;
        const [vx, vy] = g.convertToViewportPoint(px, py) as Pt;
        const x = Math.round((vx / g.width) * canvas.width);
        const y = Math.round((vy / g.height) * canvas.height);
        try {
          const d = ctx.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
          for (let i = 0; i < d.length; i += 4) {
            sum += (d[i] + d[i + 1] + d[i + 2]) / 765;
            count++;
          }
        } catch {
          return true;
        }
      }
    }
    return !count || sum / count < 0.85;
  }

  /** Rektangelet rundt en linje, i PDF-koordinater. */
  private box(l: TextLine): Pt[] {
    const n: Pt = [-l.dir[1], l.dir[0]];
    const at = (u: number, v: number): Pt => [l.origin[0] + l.dir[0] * u + n[0] * v, l.origin[1] + l.dir[1] * u + n[1] * v];
    const pad = l.size * 0.15;
    return [at(-pad, -l.size * 0.28), at(l.length + pad, -l.size * 0.28), at(l.length + pad, l.size * 0.98), at(-pad, l.size * 0.98)];
  }

  private setHover(hit: { page: number; line: TextLine } | null): void {
    const prev = this.hover;
    if (prev?.line === hit?.line) return;
    this.hover = hit;
    if (prev) this.layers.get(prev.page)?.svg.replaceChildren();
    this.viewer.el.dataset.thover = hit ? "line" : "";
    if (!hit) return;
    const layer = this.layers.get(hit.page);
    if (!layer) return;
    const poly = document.createElementNS(SVG, "polygon");
    poly.setAttribute("points", this.box(hit.line).map((p) => layer.geom.convertToViewportPoint(p[0], p[1]).join(",")).join(" "));
    poly.setAttribute("class", "te-hover");
    layer.svg.replaceChildren(poly);
  }

  private openEditor(page: number, line: TextLine): void {
    const layer = this.layers.get(page);
    if (!layer) return;
    this.setHover(null);
    const g = layer.geom;
    const pxPerPt = (layer.el.getBoundingClientRect().width || g.width) / g.width;
    const n: Pt = [-line.dir[1], line.dir[0]];
    // Øvre venstre hjørne av linjen, og vinkelen den har i visningen.
    const top: Pt = [line.origin[0] + n[0] * line.size * 1.05 - line.dir[0] * line.size * 0.15, line.origin[1] + n[1] * line.size * 1.05 - line.dir[1] * line.size * 0.15];
    const [tx, ty] = g.convertToViewportPoint(top[0], top[1]) as Pt;
    const [ax, ay] = g.convertToViewportPoint(line.origin[0], line.origin[1]) as Pt;
    const [bx, by] = g.convertToViewportPoint(line.origin[0] + line.dir[0], line.origin[1] + line.dir[1]) as Pt;
    const angle = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    const input = h("input", { type: "text", class: "textedit-input", spellcheck: "true", "aria-label": "Ny tekst" });
    input.value = line.text;
    input.style.left = `${(tx / g.width) * 100}%`;
    input.style.top = `${(ty / g.height) * 100}%`;
    input.style.fontSize = `${line.size * pxPerPt}px`;
    input.style.height = `${line.size * 1.4 * pxPerPt}px`;
    input.style.transform = `rotate(${angle}deg)`;
    const fit = () => {
      input.style.width = `${Math.max(line.length + line.size * 2, line.size * (input.value.length * 0.62 + 2)) * pxPerPt}px`;
    };
    fit();
    input.addEventListener("input", fit);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        void this.commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeEditor(false);
      }
    });
    this.editor = { el: input, line, done: false };
    layer.el.append(input);
    input.focus();
    input.select();
  }

  private async commit(): Promise<void> {
    const ed = this.editor;
    if (!ed || ed.done) return;
    const text = ed.el.value;
    this.closeEditor(false);
    if (text !== ed.line.text) await this.onEdit(ed.line, text);
  }

  private closeEditor(_commit: boolean): void {
    const ed = this.editor;
    if (!ed) return;
    ed.done = true;
    this.editor = null;
    ed.el.remove();
    this.viewer.el.focus({ preventScroll: true });
  }

  private attach(page: number, pageEl: HTMLDivElement, geom: PageGeometry): void {
    let layer = this.layers.get(page);
    if (!layer) {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("preserveAspectRatio", "none");
      const el = h("div", { class: "texteditLayer" });
      el.append(svg);
      layer = { el, svg, geom };
      this.layers.set(page, layer);
    }
    layer.geom = geom;
    layer.svg.setAttribute("viewBox", `0 0 ${geom.width} ${geom.height}`);
    pageEl.append(layer.el);
    // Les linjene i forkant, så de er klare når musa kommer.
    if (this.active) this.pageLines(page);
  }
}
