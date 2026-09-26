// Kontinuerlig sidevisning. Bare sidene som er synlige (pluss litt margin)
// tegnes, så også dokumenter med tusenvis av sider åpner umiddelbart.
import { pdfjs, renderPageToCanvas, type PDFDocumentProxy } from "./pdf";

export type ZoomMode = "auto" | "width" | "page" | number;

const GAP = 16; // mellomrom mellom sider (px)
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
/** pdf.js regner i punkter (1/72"), skjermen i CSS-piksler (1/96"). 100 % = faktisk størrelse. */
export const CSS_UNITS = 96 / 72;

interface Rendered {
  scale: number;
  canvas: HTMLCanvasElement;
  cancel?: () => void;
  text?: { cancel: () => void };
}

export class Viewer {
  readonly el: HTMLDivElement;
  private pagesEl: HTMLDivElement;
  private doc: PDFDocumentProxy | null = null;
  private sizes: Array<{ w: number; h: number }> = [];
  private pageEls: HTMLDivElement[] = [];
  private rendered = new Map<number, Rendered>();
  private visible = new Set<number>();
  private observer: IntersectionObserver;
  private renderScheduled = false;
  private generation = 0;
  private mode: ZoomMode = "auto";
  scale = 1;
  current = 0;
  onChange: () => void = () => {};

  constructor() {
    this.pagesEl = document.createElement("div");
    this.pagesEl.className = "pages";
    this.el = document.createElement("div");
    this.el.className = "viewer";
    this.el.tabIndex = 0;
    this.el.append(this.pagesEl);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.index);
          if (e.isIntersecting) this.visible.add(i);
          else {
            this.visible.delete(i);
            this.release(i);
          }
        }
        this.scheduleRender();
      },
      { root: this.el, rootMargin: "150% 0px" },
    );

    let scrollFrame = 0;
    this.el.addEventListener("scroll", () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        this.updateCurrent();
      });
    });

    this.el.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey || !this.doc) return;
        e.preventDefault();
        this.setZoom(this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      },
      { passive: false },
    );

    new ResizeObserver(() => {
      if (this.doc && typeof this.mode !== "number") this.applyZoom();
    }).observe(this.el);
  }

  get document(): PDFDocumentProxy | null {
    return this.doc;
  }

  get pageCount(): number {
    return this.doc?.numPages ?? 0;
  }

  get zoomMode(): ZoomMode {
    return this.mode;
  }

  async setDocument(doc: PDFDocumentProxy | null, startPage = 0): Promise<void> {
    const gen = ++this.generation;
    this.clear();
    this.doc = doc;
    if (!doc) return;

    const first = await doc.getPage(1);
    if (gen !== this.generation) return;
    const vp = first.getViewport({ scale: 1 });
    this.sizes = Array.from({ length: doc.numPages }, () => ({ w: vp.width, h: vp.height }));

    const frag = document.createDocumentFragment();
    for (let i = 0; i < doc.numPages; i++) {
      const p = document.createElement("div");
      p.className = "page";
      p.dataset.index = String(i);
      p.setAttribute("aria-label", `Side ${i + 1}`);
      this.pageEls.push(p);
      frag.append(p);
    }
    this.pagesEl.append(frag);
    this.applyZoom(startPage);
    for (const p of this.pageEls) this.observer.observe(p);
    this.onChange();
    void this.loadSizes(gen);
  }

  /** Henter faktisk størrelse på alle sider i bakgrunnen (de kan variere). */
  private async loadSizes(gen: number): Promise<void> {
    const doc = this.doc!;
    let changed = false;
    for (let i = 1; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      if (gen !== this.generation) return;
      const vp = page.getViewport({ scale: 1 });
      const s = this.sizes[i];
      if (Math.abs(s.w - vp.width) > 0.5 || Math.abs(s.h - vp.height) > 0.5) {
        this.sizes[i] = { w: vp.width, h: vp.height };
        changed = true;
      }
      // Oppdater oppsettet i porsjoner så rullingen ikke hakker.
      if (changed && (i % 200 === 0 || i === doc.numPages - 1)) {
        changed = false;
        this.applyZoom(this.current, true);
      }
    }
  }

  private clear(): void {
    this.observer.disconnect();
    for (const i of [...this.rendered.keys()]) this.release(i);
    this.visible.clear();
    this.pageEls = [];
    this.pagesEl.replaceChildren();
    this.sizes = [];
    this.current = 0;
  }

  private release(i: number): void {
    const r = this.rendered.get(i);
    if (!r) return;
    r.cancel?.();
    r.text?.cancel();
    r.canvas.width = r.canvas.height = 0;
    this.pageEls[i]?.replaceChildren();
    this.rendered.delete(i);
  }

  private computeScale(): number {
    if (typeof this.mode === "number") return this.mode;
    const s = this.sizes[this.current] ?? this.sizes[0];
    if (!s) return 1;
    const availW = this.el.clientWidth - 2 * GAP;
    const availH = this.el.clientHeight - 2 * GAP;
    const fitW = availW / s.w;
    const fitPage = Math.min(fitW, availH / s.h);
    let scale: number;
    if (this.mode === "width") scale = Math.min(fitW, 4);
    else if (this.mode === "page") scale = fitPage;
    // «auto»: stående sider fyller bredden, men maks 125 %; liggende vises hele.
    else scale = s.w > s.h ? fitPage : Math.min(fitW, 1.25 * CSS_UNITS);
    return Math.max(MIN_SCALE, scale);
  }

  setZoom(mode: ZoomMode): void {
    this.mode = typeof mode === "number" ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, mode)) : mode;
    this.applyZoom();
  }

  get zoomPercent(): number {
    return Math.round((this.scale / CSS_UNITS) * 100);
  }

  zoomIn(): void {
    this.setZoom(nextStep(this.scale / CSS_UNITS, 1) * CSS_UNITS);
  }

  zoomOut(): void {
    this.setZoom(nextStep(this.scale / CSS_UNITS, -1) * CSS_UNITS);
  }

  /** Setter størrelse på alle sider og holder posisjonen i dokumentet. */
  private applyZoom(anchorPage?: number, keepOffset = true): void {
    if (!this.doc) return;
    const idx = anchorPage ?? this.current;
    const anchorEl = this.pageEls[idx];
    const frac = anchorEl && keepOffset && anchorEl.offsetHeight ? (this.el.scrollTop - anchorEl.offsetTop) / anchorEl.offsetHeight : 0;

    this.scale = this.computeScale();
    this.pagesEl.style.setProperty("--scale-factor", String(this.scale));
    for (let i = 0; i < this.pageEls.length; i++) {
      const s = this.sizes[i];
      const st = this.pageEls[i].style;
      st.width = `${Math.floor(s.w * this.scale)}px`;
      st.height = `${Math.floor(s.h * this.scale)}px`;
    }
    const target = this.pageEls[idx];
    if (target) this.el.scrollTop = anchorPage !== undefined && !keepOffset ? target.offsetTop - GAP : target.offsetTop + frac * target.offsetHeight;
    this.scheduleRender();
    this.onChange();
  }

  goToPage(i: number): void {
    if (!this.pageEls.length) return;
    const idx = Math.max(0, Math.min(this.pageEls.length - 1, i));
    this.el.scrollTop = this.pageEls[idx].offsetTop - GAP;
    this.current = idx;
    this.onChange();
  }

  private updateCurrent(): void {
    if (!this.pageEls.length) return;
    const y = this.el.scrollTop + this.el.clientHeight * 0.3;
    let lo = 0;
    let hi = this.pageEls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pageEls[mid].offsetTop <= y) lo = mid;
      else hi = mid - 1;
    }
    if (lo !== this.current) {
      this.current = lo;
      this.onChange();
    }
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      void this.renderVisible();
    });
  }

  private async renderVisible(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const gen = this.generation;
    const scale = this.scale;
    // Nærmeste sider først.
    const order = [...this.visible].sort((a, b) => Math.abs(a - this.current) - Math.abs(b - this.current));
    for (const i of order) {
      const r = this.rendered.get(i);
      if (r && Math.abs(r.scale - scale) < 1e-3) continue;
      await this.renderPage(doc, i, scale, gen);
      if (gen !== this.generation || scale !== this.scale) return;
    }
  }

  private async renderPage(doc: PDFDocumentProxy, i: number, scale: number, gen: number): Promise<void> {
    const pageEl = this.pageEls[i];
    const page = await doc.getPage(i + 1);
    if (gen !== this.generation || !this.visible.has(i)) return;

    const canvas = document.createElement("canvas");
    const job = await renderPageToCanvas(page, canvas, scale, window.devicePixelRatio || 1);
    const prev = this.rendered.get(i);
    prev?.cancel?.();
    const entry: Rendered = { scale, canvas: prev?.canvas ?? canvas, cancel: job.cancel, text: prev?.text };
    this.rendered.set(i, entry);
    try {
      await job.done;
    } catch (e) {
      console.error(`Side ${i + 1}`, e);
      return;
    }
    if (gen !== this.generation || this.rendered.get(i) !== entry || !this.visible.has(i)) {
      canvas.width = canvas.height = 0;
      return;
    }

    // Bytt inn det ferdige lerretet (ingen blank blink under tegning).
    prev?.text?.cancel();
    if (prev && prev.canvas !== canvas) prev.canvas.width = prev.canvas.height = 0;
    const textDiv = document.createElement("div");
    textDiv.className = "textLayer";
    pageEl.replaceChildren(canvas, textDiv);
    entry.canvas = canvas;
    entry.cancel = undefined;

    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textDiv,
      viewport: page.getViewport({ scale }),
    });
    entry.text = textLayer;
    textLayer.render().catch(() => {});
  }
}

const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];

function nextStep(current: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find((s) => s > current + 0.01) ?? STEPS[STEPS.length - 1];
  return [...STEPS].reverse().find((s) => s < current - 0.01) ?? STEPS[0];
}
