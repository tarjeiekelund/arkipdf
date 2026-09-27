// Kontinuerlig sidevisning. Bare sidene som er synlige (pluss litt margin)
// tegnes, så også dokumenter med tusenvis av sider åpner umiddelbart.
//
// Hver side har et grunnbilde med begrenset oppløsning. Ved kraftig zoom på
// store tegninger ville et skarpt bilde av hele siden blitt altfor stort, så
// da tegnes i tillegg et «detaljbilde» av bare det utsnittet som vises.
import { buildLinkLayer, resolveDest, type LinkAction, type Target } from "./links";
import { isMeasureLayer } from "./measure-pdf";
import { pdfjs, renderPageToCanvas, renderRegion, type OptionalContent, type PDFDocumentProxy } from "./pdf";

/** Sidens geometri ved skala 1 med visningsrotasjon (pdf.js PageViewport). */
export type PageGeometry = ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["getViewport"]>;

export type ZoomMode = "auto" | "width" | "page" | number;
export type Tool = "select" | "hand";

const GAP = 16; // mellomrom mellom sider (px)
/** pdf.js regner i punkter (1/72"), skjermen i CSS-piksler (1/96"). 100 % = faktisk størrelse. */
export const CSS_UNITS = 96 / 72;
const MIN_SCALE = 0.05;
const MAX_SCALE = 32 * CSS_UNITS; // 3200 %
/** Grunnbildet av en side holdes lite; detaljer tegnes separat. */
const BASE_MAX_PIXELS = 8_000_000;
/** Detaljbildet dekker det synlige utsnittet pluss denne andelen på hver side. */
const DETAIL_MARGIN = 0.25;

/** Det søket trenger fra et ferdig tekstlag: ett span per tekstbit. */
export interface TextLayerInfo {
  textDivs: HTMLElement[];
  textContentItemsStr: string[];
}

interface Detail {
  canvas: HTMLCanvasElement;
  /** Utsnittet som andel av siden (0–1), så det følger med ved zoom. */
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  scale: number;
}

interface Rendered {
  scale: number;
  rotation: number;
  canvas: HTMLCanvasElement;
  cancel?: () => void;
  text?: { cancel: () => void } & TextLayerInfo;
  textReady?: boolean;
  detail?: Detail;
  detailCancel?: () => void;
}

export class Viewer {
  readonly el: HTMLDivElement;
  private pagesEl: HTMLDivElement;
  private doc: PDFDocumentProxy | null = null;
  /** Sidestørrelser i punkter, med sidens egen rotasjon, men uten visningsrotasjon. */
  private sizes: Array<{ w: number; h: number }> = [];
  private pageEls: HTMLDivElement[] = [];
  private rendered = new Map<number, Rendered>();
  private visible = new Set<number>();
  private observer: IntersectionObserver;
  private renderScheduled = false;
  private renderTimer = 0;
  private detailTimer = 0;
  private generation = 0;
  private mode: ZoomMode = "auto";
  private rot = 0;
  /** Lagoppsett der våre egne lagrede mål er skjult (de tegnes av målelaget). */
  private layers: OptionalContent | null = null;
  private toolMode: Tool = "select";
  private spaceHeld = false;
  private spacePanned = false;
  private pendingZoom = 1;
  private zoomAnchor: { x: number; y: number } | null = null;
  private zoomFrame = 0;
  scale = 1;
  current = 0;
  onChange: () => void = () => {};
  /** Kalles når tekstlaget for en side er klart (brukes til søketreff). */
  onTextLayer: ((page: number, layer: TextLayerInfo) => void) | null = null;
  /** Kalles for lenker til nettsider. */
  onOpenUrl: (url: string) => void = () => {};
  /** Kalles hver gang en side er tegnet, så andre lag (f.eks. mål) kan legges på. */
  onPageRendered: ((page: number, pageEl: HTMLDivElement, geometry: PageGeometry) => void) | null = null;

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
      { root: this.el, rootMargin: "150% 150%" },
    );

    let scrollFrame = 0;
    this.el.addEventListener("scroll", () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        this.updateCurrent();
        this.scheduleDetail();
      });
    });

    // Ctrl+musehjul og knip på styreflate: zoom mot punktet under pekeren.
    this.el.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey || !this.doc) return;
        e.preventDefault();
        const r = this.el.getBoundingClientRect();
        const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        this.queueZoom(Math.exp(-delta * 0.0018), { x: e.clientX - r.left, y: e.clientY - r.top });
      },
      { passive: false },
    );

    this.setupPanning();

    new ResizeObserver(() => {
      if (this.doc && typeof this.mode !== "number") this.applyZoom();
      else this.scheduleDetail();
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

  get rotation(): number {
    return this.rot;
  }

  /** Holdes mellomrom inne (midlertidig håndverktøy)? */
  get panKeyHeld(): boolean {
    return this.spaceHeld;
  }

  get tool(): Tool {
    return this.toolMode;
  }

  set tool(t: Tool) {
    this.toolMode = t;
    this.el.classList.toggle("hand", t === "hand" || this.spaceHeld);
    this.onChange();
  }

  async setDocument(doc: PDFDocumentProxy | null, startPage = 0): Promise<void> {
    const gen = ++this.generation;
    this.clear();
    this.doc = doc;
    this.rot = 0;
    if (!doc) return;

    const [first, layers] = await Promise.all([doc.getPage(1), hideMeasureLayer(doc)]);
    if (gen !== this.generation) return;
    this.layers = layers;
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
    const target = Math.max(0, Math.min(doc.numPages - 1, startPage));
    this.current = target;
    // Sidene har ingen størrelse ennå, så det finnes ikke noe punkt å holde fast.
    this.applyZoom(null);
    this.goToPage(target);
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
        this.applyZoom({ x: this.el.clientWidth / 2, y: 0 });
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
    this.dropDetail(r);
    r.canvas.width = r.canvas.height = 0;
    this.pageEls[i]?.replaceChildren();
    this.rendered.delete(i);
  }

  private dropDetail(r: Rendered): void {
    r.detailCancel?.();
    r.detailCancel = undefined;
    if (r.detail) {
      r.detail.canvas.remove();
      r.detail.canvas.width = r.detail.canvas.height = 0;
      r.detail = undefined;
    }
  }

  /** Sidestørrelse slik den vises (med visningsrotasjon). */
  private displaySize(i: number): { w: number; h: number } {
    const s = this.sizes[i] ?? this.sizes[0] ?? { w: 612, h: 792 };
    return this.rot % 180 ? { w: s.h, h: s.w } : s;
  }

  /**
   * Største ark i dokumentet. Tilpasset zoom regnes ut fra dette, så alle
   * sidene får samme målestokk seg imellom og zoomen ikke hopper når man
   * blar forbi et mindre ark i et tegningssett.
   */
  private referenceSize(): { w: number; h: number } {
    let w = 0;
    let h = 0;
    for (let i = 0; i < this.sizes.length; i++) {
      const s = this.displaySize(i);
      if (s.w > w) w = s.w;
      if (s.h > h) h = s.h;
    }
    return w && h ? { w, h } : this.displaySize(0);
  }

  private computeScale(): number {
    if (typeof this.mode === "number") return this.mode;
    const s = this.referenceSize();
    const availW = this.el.clientWidth - 2 * GAP;
    const availH = this.el.clientHeight - 2 * GAP;
    const fitW = availW / s.w;
    const fitPage = Math.min(fitW, availH / s.h);
    let scale: number;
    if (this.mode === "width") scale = fitW;
    else if (this.mode === "page") scale = fitPage;
    // «auto»: stående sider fyller bredden, men maks 125 %; liggende vises hele.
    else scale = s.w > s.h ? fitPage : Math.min(fitW, 1.25 * CSS_UNITS);
    return Math.max(MIN_SCALE, scale);
  }

  setZoom(mode: ZoomMode, anchor?: { x: number; y: number } | null): void {
    this.mode = typeof mode === "number" ? clampScale(mode) : mode;
    this.applyZoom(anchor);
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

  /** Samler opp musehjul-zoom og gjør høyst én omlegging per skjermbilde. */
  private queueZoom(factor: number, anchor: { x: number; y: number }): void {
    this.pendingZoom *= factor;
    this.zoomAnchor = anchor;
    if (this.zoomFrame) return;
    this.zoomFrame = requestAnimationFrame(() => {
      this.zoomFrame = 0;
      const f = this.pendingZoom;
      this.pendingZoom = 1;
      this.setZoom(this.scale * f, this.zoomAnchor ?? undefined);
    });
  }

  /** Siden som ligger under et punkt i visningen, og hvor på siden (0–1). */
  private pointToPage(x: number, y: number): { i: number; fx: number; fy: number } | null {
    if (!this.pageEls.length) return null;
    const py = this.el.scrollTop + y;
    const px = this.el.scrollLeft + x;
    let lo = 0;
    let hi = this.pageEls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pageEls[mid].offsetTop <= py) lo = mid;
      else hi = mid - 1;
    }
    const p = this.pageEls[lo];
    if (!p.offsetWidth || !p.offsetHeight) return null;
    return { i: lo, fx: (px - p.offsetLeft) / (p.offsetWidth || 1), fy: (py - p.offsetTop) / (p.offsetHeight || 1) };
  }

  /**
   * Setter størrelse på alle sider og holder punktet `anchor` (i visningens
   * koordinater) på samme sted i dokumentet. Uten anker brukes midten.
   */
  private applyZoom(anchor?: { x: number; y: number } | null): void {
    if (!this.doc) return;
    const a = anchor ?? { x: this.el.clientWidth / 2, y: this.el.clientHeight / 2 };
    const before = anchor === null ? null : this.pointToPage(a.x, a.y);

    const oldScale = this.scale;
    this.scale = this.computeScale();
    this.pagesEl.style.setProperty("--scale-factor", String(this.scale));
    for (let i = 0; i < this.pageEls.length; i++) {
      const s = this.displaySize(i);
      const st = this.pageEls[i].style;
      st.width = `${Math.floor(s.w * this.scale)}px`;
      st.height = `${Math.floor(s.h * this.scale)}px`;
    }
    if (before) {
      const p = this.pageEls[before.i];
      this.el.scrollLeft = p.offsetLeft + before.fx * p.offsetWidth - a.x;
      this.el.scrollTop = p.offsetTop + before.fy * p.offsetHeight - a.y;
    }
    // Under pågående zoom strekkes bildene; nye tegnes når zoomingen stopper.
    if (Math.abs(oldScale - this.scale) > 1e-6) {
      clearTimeout(this.renderTimer);
      this.renderTimer = window.setTimeout(() => this.scheduleRender(), 150);
    } else this.scheduleRender();
    this.updateCurrent();
    this.onChange();
  }

  rotate(delta: 90 | -90): void {
    if (!this.doc) return;
    this.rot = (this.rot + delta + 360) % 360;
    for (const i of [...this.rendered.keys()]) this.release(i);
    this.applyZoom();
    this.scheduleRender();
  }

  goToPage(i: number): void {
    if (!this.pageEls.length) return;
    const idx = Math.max(0, Math.min(this.pageEls.length - 1, i));
    this.el.scrollTop = this.pageEls[idx].offsetTop - GAP;
    this.current = idx;
    this.onChange();
  }

  /** Hopper til et mål (side og eventuelt posisjon på siden). */
  async goToTarget(t: Target): Promise<void> {
    if (!this.doc) return;
    if (t.y == null && t.x == null) return this.goToPage(t.page);
    const page = await this.doc.getPage(t.page + 1);
    const vp = page.getViewport({ scale: this.scale, rotation: (page.rotate + this.rot) % 360 });
    const [vx, vy] = vp.convertToViewportPoint(t.x ?? 0, t.y ?? vp.viewBox[3]);
    const p = this.pageEls[t.page];
    this.el.scrollTop = p.offsetTop + (t.y == null ? -GAP : vy - GAP);
    if (t.x != null && p.offsetWidth > this.el.clientWidth) this.el.scrollLeft = p.offsetLeft + vx - GAP;
    this.current = t.page;
    this.onChange();
  }

  /** Følger et lenkemål eller et bokmerke. */
  async navigate(dest: unknown): Promise<void> {
    if (!this.doc) return;
    const t = await resolveDest(this.doc, dest);
    if (t) await this.goToTarget(t);
  }

  private onLink = (action: LinkAction): void => {
    if (action.kind === "url") this.onOpenUrl(action.url);
    else if (action.kind === "target") void this.navigate(action.dest);
    else if (action.name === "NextPage") this.goToPage(this.current + 1);
    else if (action.name === "PrevPage") this.goToPage(this.current - 1);
    else if (action.name === "FirstPage") this.goToPage(0);
    else if (action.name === "LastPage") this.goToPage(this.pageCount - 1);
  };

  private updateCurrent(): void {
    if (!this.pageEls.length) return;
    // Helt nederst er siste side den gjeldende, selv om den er for kort til å nå toppen.
    const atEnd = this.el.scrollTop > 0 && this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 2;
    const i = atEnd ? this.pageEls.length - 1 : this.pointToPage(0, this.el.clientHeight * 0.3)?.i;
    if (i !== undefined && i !== this.current) {
      this.current = i;
      this.onChange();
    }
  }

  // ---------- Panorering ----------

  /**
   * Håndverktøy: dra med venstre musetast (når håndverktøyet er valgt eller
   * mellomrom holdes inne) eller med midtre musetast.
   */
  private setupPanning(): void {
    const el = this.el;
    // Hindre Windows' autorulling på midtre musetast.
    el.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    el.addEventListener("pointerdown", (e) => {
      const hand = this.toolMode === "hand" || this.spaceHeld;
      if (!(e.button === 1 || (e.button === 0 && hand))) return;
      if (e.button === 0 && (e.target as HTMLElement).closest(".linkLayer a")) return;
      e.preventDefault();
      el.focus({ preventScroll: true });
      const x0 = e.clientX;
      const y0 = e.clientY;
      const sx = el.scrollLeft;
      const sy = el.scrollTop;
      el.setPointerCapture(e.pointerId);
      el.classList.add("panning");
      const move = (ev: PointerEvent) => {
        el.scrollLeft = sx - (ev.clientX - x0);
        el.scrollTop = sy - (ev.clientY - y0);
        if (this.spaceHeld) this.spacePanned = true;
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        el.classList.remove("panning");
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  }

  /**
   * Mellomrom: holdes inne for å dra tegningen rundt. Slippes det uten at
   * man har dratt, blas det en skjermside ned (Shift: opp), som før.
   */
  handleSpace(e: KeyboardEvent): void {
    if (e.type === "keydown") {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.spacePanned = false;
        this.el.classList.add("hand");
      }
    } else if (this.spaceHeld) {
      this.spaceHeld = false;
      this.el.classList.toggle("hand", this.toolMode === "hand");
      if (!this.spacePanned) this.el.scrollBy({ top: (e.shiftKey ? -1 : 1) * this.el.clientHeight * 0.9 });
    }
  }

  // ---------- Tegning ----------

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
    const rot = this.rot;
    // Nærmeste sider først.
    const order = [...this.visible].sort((a, b) => Math.abs(a - this.current) - Math.abs(b - this.current));
    for (const i of order) {
      const r = this.rendered.get(i);
      if (r && Math.abs(r.scale - scale) < 1e-6 && r.rotation === rot) continue;
      await this.renderPage(doc, i, scale, rot, gen);
      if (gen !== this.generation || scale !== this.scale || rot !== this.rot) return;
    }
    this.scheduleDetail(0);
  }

  private async renderPage(doc: PDFDocumentProxy, i: number, scale: number, rot: number, gen: number): Promise<void> {
    const pageEl = this.pageEls[i];
    const page = await doc.getPage(i + 1);
    if (gen !== this.generation || !this.visible.has(i)) return;

    const canvas = document.createElement("canvas");
    const job = await renderPageToCanvas(page, canvas, scale, window.devicePixelRatio || 1, rot, BASE_MAX_PIXELS, this.layers);
    const prev = this.rendered.get(i);
    prev?.cancel?.();
    const entry: Rendered = { scale, rotation: rot, canvas: prev?.canvas ?? canvas, cancel: job.cancel, text: prev?.text, detail: prev?.detail };
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
    const children: Node[] = [canvas];
    // Et detaljbilde med samme rotasjon kan stå til et nytt er tegnet.
    if (entry.detail && prev?.rotation === rot) children.push(entry.detail.canvas);
    else if (prev) this.dropDetail(entry);
    children.push(textDiv);
    pageEl.replaceChildren(...children);
    entry.canvas = canvas;
    entry.cancel = undefined;
    this.onPageRendered?.(i, pageEl, page.getViewport({ scale: 1, rotation: (page.rotate + rot) % 360 }));

    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textDiv,
      viewport: page.getViewport({ scale, rotation: (page.rotate + rot) % 360 }),
    });
    entry.text = textLayer;
    entry.textReady = false;
    textLayer
      .render()
      .then(() => {
        if (entry.text !== textLayer || this.rendered.get(i) !== entry) return;
        entry.textReady = true;
        this.onTextLayer?.(i, textLayer);
      })
      .catch(() => {});

    buildLinkLayer(page, rot, this.onLink)
      .then((layer) => {
        if (layer && this.rendered.get(i) === entry && entry.canvas === canvas) pageEl.append(layer);
      })
      .catch(() => {});
  }

  /** Tegner detaljbilder for sider der grunnbildet ikke er skarpt nok. */
  private scheduleDetail(delay = 120): void {
    clearTimeout(this.detailTimer);
    this.detailTimer = window.setTimeout(() => void this.renderDetails(), delay);
  }

  private async renderDetails(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const gen = this.generation;
    const scale = this.scale;
    const rot = this.rot;
    const dpr = window.devicePixelRatio || 1;
    const view = this.el.getBoundingClientRect();

    for (const [i, r] of this.rendered) {
      if (r.scale !== scale || r.rotation !== rot) continue;
      const pageEl = this.pageEls[i];
      const size = this.displaySize(i);
      const fullW = size.w * scale;
      const fullH = size.h * scale;
      // Holder grunnbildet full oppløsning, trengs ingen detalj.
      if (fullW * fullH * dpr * dpr <= BASE_MAX_PIXELS * 1.01) {
        this.dropDetail(r);
        continue;
      }
      const pr = pageEl.getBoundingClientRect();
      const visL = Math.max(view.left, pr.left) - pr.left;
      const visT = Math.max(view.top, pr.top) - pr.top;
      const visR = Math.min(view.right, pr.right) - pr.left;
      const visB = Math.min(view.bottom, pr.bottom) - pr.top;
      if (visR <= visL || visB <= visT) {
        this.dropDetail(r);
        continue;
      }
      // Dekker nåværende detaljbilde allerede det synlige, i riktig skala?
      const d = r.detail;
      if (
        d &&
        Math.abs(d.scale - scale) < 1e-6 &&
        d.fx * fullW <= visL + 1 &&
        d.fy * fullH <= visT + 1 &&
        (d.fx + d.fw) * fullW >= visR - 1 &&
        (d.fy + d.fh) * fullH >= visB - 1
      )
        continue;

      const mw = (visR - visL) * DETAIL_MARGIN;
      const mh = (visB - visT) * DETAIL_MARGIN;
      const x = Math.max(0, Math.floor(visL - mw));
      const y = Math.max(0, Math.floor(visT - mh));
      const w = Math.min(fullW, Math.ceil(visR + mw)) - x;
      const h = Math.min(fullH, Math.ceil(visB + mh)) - y;

      const page = await doc.getPage(i + 1);
      if (gen !== this.generation || scale !== this.scale || rot !== this.rot || this.rendered.get(i) !== r) return;
      const canvas = document.createElement("canvas");
      canvas.className = "detail";
      r.detailCancel?.();
      const job = await renderRegion(page, canvas, scale, rot, { x, y, w, h }, dpr, undefined, this.layers);
      r.detailCancel = job.cancel;
      try {
        await job.done;
      } catch (e) {
        console.error(`Detalj side ${i + 1}`, e);
        continue;
      }
      if (gen !== this.generation || scale !== this.scale || rot !== this.rot || this.rendered.get(i) !== r) {
        canvas.width = canvas.height = 0;
        return;
      }
      r.detailCancel = undefined;
      Object.assign(canvas.style, {
        left: `${(x / fullW) * 100}%`,
        top: `${(y / fullH) * 100}%`,
        width: `${(w / fullW) * 100}%`,
        height: `${(h / fullH) * 100}%`,
      });
      const old = r.detail;
      r.detail = { canvas, fx: x / fullW, fy: y / fullH, fw: w / fullW, fh: h / fullH, scale };
      if (old) {
        old.canvas.replaceWith(canvas);
        old.canvas.width = old.canvas.height = 0;
      } else r.canvas.after(canvas);
    }
  }

  /** Tekstlaget for en side, hvis siden er tegnet og teksten er klar. */
  textLayer(i: number): TextLayerInfo | null {
    const r = this.rendered.get(i);
    return r?.textReady && r.text ? r.text : null;
  }

  /** Kjører `onTextLayer` på nytt for alle tegnede sider (f.eks. nytt søk). */
  refreshTextLayers(): void {
    for (const [i, r] of this.rendered) if (r.textReady && r.text) this.onTextLayer?.(i, r.text);
  }
}

/** Skjuler laget med lagrede mål, hvis dokumentet har det. */
async function hideMeasureLayer(doc: PDFDocumentProxy): Promise<OptionalContent | null> {
  try {
    const cfg = await doc.getOptionalContentConfig();
    let found = false;
    for (const [id, group] of cfg) {
      if (isMeasureLayer((group as { name?: string })?.name)) {
        cfg.setVisibility(id, false);
        found = true;
      }
    }
    return found ? cfg : null;
  } catch {
    return null;
  }
}

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 12, 16, 24, 32];

function nextStep(current: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find((s) => s > current + 0.01) ?? STEPS[STEPS.length - 1];
  return [...STEPS].reverse().find((s) => s < current - 0.01) ?? STEPS[0];
}
