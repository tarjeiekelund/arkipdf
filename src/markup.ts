// Markering (K): revisjonssky, pil og tekst på tegningene, og signatur.
//
// Punktene lagres i PDF-koordinater, så markeringene ligger fast på tegningen
// uansett zoom og rotasjon. Størrelsen (strek, buer, skrift) følger arket, så
// en markering ser lik ut på A4 og A1 når arket vises helt. Signaturen har
// derimot en vanlig håndskriftstørrelse. Lagres som vanlige PDF-kommentarer
// (se markup-pdf.ts).
import { distance, type Pt } from "./measure-math";
import {
  COLORS,
  arrowGeometry,
  cloudBulge,
  cloudCurves,
  displayRect,
  lineWidth,
  readMarkups,
  rectAround,
  textCorners,
  textLayout,
  toTextLocal,
  writeMarkups,
  type MarkupColor,
  type MarkupKind,
  type SignatureImage,
  type StoredMarkup,
  type TextLayout,
} from "./markup-pdf";
import { editSignature, loadSignature, signatureUrl } from "./signature";
import { button, h } from "./ui";
import type { PageGeometry, Viewer } from "./viewer";

interface Item extends StoredMarkup {
  id: number;
}

/** Markeringene i ett dokument, med angrehistorikk. */
export interface MarkupDoc {
  items: Item[];
  selected: number | null;
  history: Item[][];
  dirty: boolean;
  /** Slik markeringene var sist de ble lest fra eller lagret i fila. */
  saved: Item[];
}

const clone = (items: Item[]): Item[] => items.map((m) => ({ ...m, points: m.points.map((p) => [p[0], p[1]] as Pt) }));
const signature = (items: Item[]) => JSON.stringify(items.map((m) => [m.page, m.kind, m.points, m.color, m.u, m.text ?? "", m.rot ?? 0, m.img?.a ?? ""]));

function newMarkupDoc(): MarkupDoc {
  return { items: [], selected: null, history: [], dirty: false, saved: [] };
}

/** Kopi (for å kunne angre en endring av sidene). */
export function copyMarkupDoc(st: MarkupDoc): MarkupDoc {
  return { ...st, items: clone(st.items), saved: clone(st.saved), history: [] };
}

/** Sidene har fått ny rekkefølge: `order[i]` er den gamle indeksen til ny side `i`. */
export function reorderMarkupDoc(st: MarkupDoc, order: number[]): void {
  const moved = new Map(order.map((old, i) => [old, i]));
  const move = (items: Item[]) => items.filter((m) => moved.has(m.page)).map((m) => ({ ...m, page: moved.get(m.page)! }));
  st.items = move(st.items);
  st.saved = move(st.saved);
  if (!st.items.some((m) => m.id === st.selected)) st.selected = null;
  st.history = [];
}

interface Layer {
  el: HTMLDivElement;
  svg: SVGSVGElement;
  handles: HTMLDivElement;
  geom: PageGeometry;
}

const SVG = "http://www.w3.org/2000/svg";
const FONT = "Helvetica, Arial, sans-serif";
const TOOL_NAMES: Record<MarkupKind, string> = { cloud: "Sky", arrow: "Pil", text: "Tekst", sign: "Signatur" };
const TOOL_KEYS: Record<MarkupKind, string> = { cloud: "S", arrow: "P", text: "T", sign: "N" };
/** Signaturens bredde når den settes inn: 50 mm, som en vanlig håndskrevet signatur. */
const SIGN_WIDTH = (50 / 25.4) * 72;

let measureCtx: CanvasRenderingContext2D | null = null;
/** Tekstbredde i punkter med samme skrift som i PDF-en (Helvetica, eller Arial på Windows). */
function measureText(s: string, size: number): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return s.length * size * 0.55;
  measureCtx.font = `${size}px ${FONT}`;
  return measureCtx.measureText(s).width;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

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

export class Markup {
  readonly bar: HTMLDivElement;
  /** Lista over markeringene (til høyre, som lista over mål). */
  readonly panel: HTMLDivElement;
  private list: HTMLOListElement;
  private count: HTMLSpanElement;
  active = false;
  private tool: MarkupKind = "cloud";
  /** Fargen til markeringer, og blekkfargen til signaturer (huskes hver for seg). */
  private colors: { markup: MarkupColor; sign: MarkupColor } = {
    markup: (store.get("markupColor") as MarkupColor) in COLORS ? (store.get("markupColor") as MarkupColor) : "red",
    sign: (store.get("signColor") as MarkupColor) in COLORS ? (store.get("signColor") as MarkupColor) : "blue",
  };
  private s: MarkupDoc = newMarkupDoc();
  private nextId = 1;
  private layers = new Map<number, Layer>();
  private toolBefore: "select" | "hand" = "select";
  /** Ny sky eller pil som dras opp. */
  private drawing: { page: number; a: Pt; b: Pt; x: number; y: number } | null = null;
  /** Markering som flyttes (`node` null) eller endres i et håndtak. */
  private grab: { id: number; page: number; node: number | null; from: Pt; points: Pt[]; x: number; y: number; moved: boolean } | null = null;
  /** Trykk på tom flate med tekst- eller signaturverktøyet: settes inn når knappen slippes. */
  private pendingClick: { page: number; p: Pt; x: number; y: number } | null = null;
  private editor: { el: HTMLTextAreaElement; page: number; id: number | null; anchor: Pt; u: number; rot: number; done: boolean } | null = null;

  private toolButtons: Record<MarkupKind, HTMLButtonElement>;
  private swatches: Record<MarkupColor, HTMLButtonElement>;
  private hint: HTMLSpanElement;
  private saveBtn: HTMLButtonElement;
  private changeSignBtn: HTMLButtonElement;
  private lockBtn: HTMLButtonElement;

  onChange: () => void = () => {};
  /** Lagrer dokumentet (hovedprogrammet skriver mål og markeringer sammen). */
  onSave: (() => Promise<unknown>) | null = null;
  /** Lagrer en kopi der signaturene er en del av siden. */
  onSaveLocked: (() => Promise<unknown>) | null = null;

  constructor(private readonly viewer: Viewer) {
    const toolBtn = (k: MarkupKind, iconName: string) =>
      button(TOOL_NAMES[k], iconName, () => this.setTool(k), { title: `${TOOL_NAMES[k]} (${TOOL_KEYS[k]})`, className: "ghost tool" });
    this.toolButtons = { cloud: toolBtn("cloud", "cloud"), arrow: toolBtn("arrow", "arrow"), text: toolBtn("text", "text"), sign: toolBtn("sign", "sign") };
    const swatch = (c: MarkupColor) => {
      const b = h("button", { type: "button", class: "swatch", title: COLORS[c].name, "aria-label": COLORS[c].name });
      b.style.setProperty("--swatch", COLORS[c].css);
      b.addEventListener("click", () => this.setColor(c));
      return b;
    };
    this.swatches = { red: swatch("red"), blue: swatch("blue"), black: swatch("black") };
    this.hint = h("span", { class: "measure-hint muted" });
    this.saveBtn = button("Lagre", "save", () => void this.save(), { title: "Lagre markeringene i PDF-fila (Ctrl+S)", className: "save-btn" });
    this.changeSignBtn = button("Endre signatur…", null, () => void this.changeSignature(), { title: "Tegn signaturen på nytt, eller hent den fra et bilde", className: "ghost" });
    this.lockBtn = button("Lagre låst kopi…", null, () => void this.saveLocked(), {
      title: "Lagre en kopi der signaturene er en del av siden og ikke kan flyttes eller slettes (f.eks. før dokumentet sendes)",
      className: "ghost",
    });
    this.bar = h(
      "div",
      { class: "subbar markup-bar", hidden: true },
      h("strong", {}, "Merk"),
      h("span", { class: "tool-group" }, this.toolButtons.cloud, this.toolButtons.arrow, this.toolButtons.text, this.toolButtons.sign),
      h("span", { class: "sep" }),
      h("span", { class: "swatches", role: "group", "aria-label": "Farge" }, this.swatches.red, this.swatches.blue, this.swatches.black),
      this.changeSignBtn,
      h("span", { class: "spacer" }),
      this.hint,
      this.lockBtn,
      this.saveBtn,
      button("", "close", () => this.close(), { title: "Avslutt markering (Esc)", className: "ghost" }),
    );
    this.list = h("ol", { class: "measure-list" });
    this.count = h("span", {});
    this.panel = h(
      "div",
      { class: "measure-panel markup-panel", hidden: true },
      h(
        "header",
        {},
        h("strong", {}, "Markeringer ", this.count),
        button("", "trash", () => this.clearAll(), { title: "Fjern alle markeringer", className: "ghost" }),
      ),
      this.list,
    );
    this.setupPointer();
    const prev = viewer.onPageRendered;
    viewer.onPageRendered = (page, pageEl, geom) => {
      prev?.(page, pageEl, geom);
      this.attach(page, pageEl, geom);
    };
    this.setTool(this.tool);
  }

  private get color(): MarkupColor {
    return this.tool === "sign" ? this.colors.sign : this.colors.markup;
  }

  /** Signaturverktøyet er valgt. */
  get signing(): boolean {
    return this.active && this.tool === "sign";
  }

  // ---------- Dokument og modus ----------

  /** Nytt dokument: tom tilstand, og les markeringer som er lagret i fila. */
  setDocument(bytes: Uint8Array | null): void {
    const st = newMarkupDoc();
    this.useDocument(st);
    if (!bytes) return;
    readMarkups(bytes)
      .then((items) => {
        st.items = items.map((m) => ({ ...m, id: this.nextId++ }));
        st.saved = clone(st.items);
        st.dirty = false;
        if (this.s !== st) return;
        this.redrawAll();
        this.refreshBar();
        this.onChange();
      })
      .catch(() => {
        /* Uleselig eller kryptert: ingen markeringer. */
      });
  }

  get state(): MarkupDoc {
    return this.s;
  }

  get dirty(): boolean {
    return this.s.dirty;
  }

  useDocument(st: MarkupDoc): void {
    this.closeEditor(false);
    this.s = st;
    this.drawing = null;
    this.grab = null;
    this.pendingClick = null;
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
    this.viewer.el.classList.add("marking");
    this.bar.hidden = false;
    this.refreshBar();
    this.onChange();
  }

  close(): void {
    if (!this.active) return;
    this.closeEditor(true);
    this.cancelDrawing();
    this.active = false;
    this.viewer.el.classList.remove("marking");
    delete this.viewer.el.dataset.khover;
    this.viewer.tool = this.toolBefore;
    this.bar.hidden = true;
    this.panel.hidden = true;
    if (this.s.selected !== null) {
      this.s.selected = null;
      this.redrawAll();
    }
    this.onChange();
  }

  /** Velger verktøy. Signatur uten lagret signatur: tegn den først (avbrytes det, beholdes verktøyet). */
  async useTool(k: MarkupKind): Promise<void> {
    if (k === "sign" && !loadSignature() && !(await editSignature())) return;
    this.setTool(k);
  }

  private setTool(k: MarkupKind): void {
    if (k === "sign" && !loadSignature()) return void this.useTool(k);
    this.cancelDrawing();
    this.tool = k;
    for (const [key, b] of Object.entries(this.toolButtons)) b.classList.toggle("active", key === k);
    this.viewer.el.dataset.ktool = k;
    this.showColor();
    this.refreshBar();
    this.onChange();
  }

  private showColor(): void {
    for (const [key, b] of Object.entries(this.swatches)) {
      b.classList.toggle("active", key === this.color);
      b.setAttribute("aria-pressed", String(key === this.color));
    }
  }

  private async changeSignature(): Promise<void> {
    if (await editSignature(loadSignature())) this.setTool("sign");
  }

  private async saveLocked(): Promise<void> {
    this.closeEditor(true);
    await this.onSaveLocked?.();
  }

  private setColor(c: MarkupColor): void {
    if (this.tool === "sign") this.colors.sign = c;
    else this.colors.markup = c;
    store.set(this.tool === "sign" ? "signColor" : "markupColor", c);
    this.showColor();
    // Valgt markering får fargen også.
    const m = this.selectedItem();
    if (m && m.color !== c) {
      this.remember();
      m.color = c;
      this.redraw(m.page);
      this.markDirty();
    }
    if (this.editor) this.editor.el.style.color = COLORS[c].css;
  }

  /** Skriver markeringene inn i PDF-bytes (brukes når dokumentet lagres). */
  async writeTo(bytes: Uint8Array): Promise<Uint8Array> {
    this.closeEditor(true);
    return writeMarkups(bytes, this.s.items);
  }

  async save(): Promise<void> {
    this.closeEditor(true);
    await this.onSave?.();
  }

  private remember(): void {
    this.s.history.push(clone(this.s.items));
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
  }

  private markDirty(): void {
    const dirty = signature(this.s.items) !== signature(this.s.saved);
    const changed = dirty !== this.s.dirty;
    this.s.dirty = dirty;
    this.refreshBar();
    if (changed) this.onChange();
  }

  private refreshBar(): void {
    this.saveBtn.disabled = !this.s.dirty;
    this.saveBtn.classList.toggle("primary", this.s.dirty);
    this.saveBtn.title = this.s.dirty ? "Lagre markeringene i PDF-fila (Ctrl+S)" : "Markeringene er lagret i fila";
    this.changeSignBtn.hidden = this.tool !== "sign";
    this.lockBtn.hidden = !this.s.items.some((m) => m.kind === "sign");
    let t: string;
    const sel = this.selectedItem();
    if (this.editor) t = "Skriv teksten · Enter er ferdig · Shift+Enter gir ny linje · Esc avbryter";
    else if (sel) {
      t =
        sel.kind === "text"
          ? "Dra for å flytte · dobbeltklikk endrer teksten · Delete sletter"
          : sel.kind === "sign"
            ? "Dra for å flytte · dra i hjørnene for å endre størrelsen · Delete sletter"
            : "Dra for å flytte · dra i punktene for å endre · Delete sletter";
    } else if (this.tool === "sign") t = "Klikk der signaturen skal stå";
    else if (this.tool === "text") t = "Klikk der teksten skal stå";
    else t = this.tool === "cloud" ? "Dra opp skyen rundt det som er endret" : "Dra fra der pila starter til det den peker på";
    this.hint.textContent = t;
    this.hint.title = t;
    this.refreshPanel();
  }

  private refreshPanel(): void {
    const items = [...this.s.items].sort((a, b) => a.page - b.page);
    this.count.textContent = items.length ? `(${items.length})` : "";
    this.panel.hidden = !this.active || !items.length;
    if (this.panel.hidden) return;
    this.list.replaceChildren(
      ...items.map((m, i) => {
        const what = m.kind === "text" ? `«${(m.text ?? "").split(/\r?\n/)[0].slice(0, 40)}»` : TOOL_NAMES[m.kind];
        const dot = h("span", { class: "markup-dot" });
        dot.style.background = COLORS[m.color].css;
        const row = h(
          "li",
          { class: m.id === this.s.selected ? "selected" : "" },
          h("span", { class: "measure-nr" }, String(i + 1)),
          h("span", { class: "measure-desc" }, h("span", { class: "measure-value" }, dot, what), h("span", { class: "muted" }, `${m.kind === "text" ? "Tekst · " : ""}side ${m.page + 1}`)),
          button("", "close", () => this.remove(m.id), { title: "Fjern", className: "ghost" }),
        );
        row.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          if (m.page !== this.viewer.current) this.viewer.goToPage(m.page);
          this.select(m.id);
          this.viewer.el.focus({ preventScroll: true });
        });
        return row;
      }),
    );
  }

  private clearAll(): void {
    if (!this.s.items.length) return;
    const pages = new Set(this.s.items.map((m) => m.page));
    this.remember();
    this.s.items = [];
    this.s.selected = null;
    for (const p of pages) this.redraw(p);
    this.markDirty();
  }

  private selectedItem(): Item | undefined {
    return this.s.items.find((m) => m.id === this.s.selected);
  }

  private select(id: number | null): void {
    if (this.s.selected === id) return;
    const pages = new Set([this.selectedItem()?.page, this.s.items.find((m) => m.id === id)?.page]);
    this.s.selected = id;
    for (const p of pages) if (p !== undefined) this.redraw(p);
    this.refreshBar();
  }

  private remove(id: number): void {
    const m = this.s.items.find((x) => x.id === id);
    if (!m) return;
    this.remember();
    this.s.items = this.s.items.filter((x) => x.id !== id);
    if (this.s.selected === id) this.s.selected = null;
    this.redraw(m.page);
    this.markDirty();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === "Escape") {
      if (this.drawing || this.grab) this.cancelDrawing();
      else if (this.s.selected !== null) this.select(null);
      else this.close();
    } else if ((k === "Delete" || k === "Backspace") && this.s.selected !== null) this.remove(this.s.selected);
    else if (ctrl && k.toLowerCase() === "z") this.undo();
    else if (!ctrl && !e.altKey && k.toLowerCase() === "s") this.setTool("cloud");
    else if (!ctrl && !e.altKey && k.toLowerCase() === "p") this.setTool("arrow");
    else if (!ctrl && !e.altKey && k.toLowerCase() === "t") this.setTool("text");
    else if (!ctrl && !e.altKey && k.toLowerCase() === "n") void this.useTool("sign");
    else if (k === "Enter" && this.selectedItem()?.kind === "text") this.editText(this.selectedItem()!);
    else return false;
    return true;
  }

  // ---------- Mus ----------

  private setupPointer(): void {
    const el = this.viewer.el;
    el.addEventListener("pointerdown", (e) => {
      if (!this.active || e.button !== 0 || this.viewer.panKeyHeld || this.viewer.tool === "hand") return;
      if ((e.target as HTMLElement).closest(".markup-editor")) return;
      if (!(e.target as HTMLElement).closest(".page")) return;
      e.preventDefault();
      if (this.editor) {
        // Klikk utenfor teksten som skrives: den er ferdig.
        this.closeEditor(true);
        return;
      }
      el.focus({ preventScroll: true });
      const hit = this.hitPage(e);
      if (!hit) return;
      const target = this.hitTest(hit.page, hit.p);
      if (target) {
        const m = this.s.items.find((x) => x.id === target.id)!;
        this.select(target.id);
        this.grab = { id: m.id, page: m.page, node: target.node, from: hit.p, points: m.points.map((p) => [p[0], p[1]] as Pt), x: e.clientX, y: e.clientY, moved: false };
        el.setPointerCapture(e.pointerId);
        return;
      }
      this.select(null);
      if (this.tool === "text" || this.tool === "sign") {
        this.pendingClick = { page: hit.page, p: hit.p, x: e.clientX, y: e.clientY };
        return;
      }
      this.drawing = { page: hit.page, a: hit.p, b: hit.p, x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.active) return;
      if (this.grab) return this.drag(e, this.grab);
      if (this.drawing) {
        const hit = this.hitPage(e, this.drawing.page);
        if (hit) {
          this.drawing.b = hit.p;
          this.drawPreview(this.drawing.page);
        }
        return;
      }
      if (e.buttons || this.editor) return;
      const hit = this.hitPage(e);
      const t = hit ? this.hitTest(hit.page, hit.p) : null;
      el.dataset.khover = t ? (t.node !== null ? "node" : "body") : "";
    });
    el.addEventListener("pointerup", (e) => {
      if (!this.active) return;
      const g = this.grab;
      const d = this.drawing;
      const pt = this.pendingClick;
      this.grab = null;
      this.drawing = null;
      this.pendingClick = null;
      el.classList.remove("k-dragging");
      if (g?.moved) this.markDirty();
      if (d) {
        this.drawPreview(d.page);
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) this.add({ page: d.page, kind: this.tool, points: [d.a, d.b] });
        else this.hint.textContent = this.tool === "cloud" ? "Hold inne og dra for å tegne skyen" : "Hold inne og dra for å tegne pila";
      }
      if (pt && Math.hypot(e.clientX - pt.x, e.clientY - pt.y) <= 5) {
        if (this.tool === "sign") this.placeSignature(pt.page, pt.p);
        else this.newText(pt.page, pt.p);
      }
    });
    el.addEventListener("pointercancel", () => {
      if (this.grab?.moved) this.markDirty();
      this.cancelDrawing();
    });
    el.addEventListener("dblclick", (e) => {
      if (!this.active || this.editor) return;
      // Etter at musa ble holdt på en markering, går hendelsen til visningen; bruk den valgte markeringens side.
      const hit = this.hitPage(e) ?? (this.selectedItem() ? this.hitPage(e, this.selectedItem()!.page) : null);
      const t = hit && this.hitTest(hit.page, hit.p);
      const m = t && this.s.items.find((x) => x.id === t.id);
      if (m?.kind === "text") {
        e.preventDefault();
        this.editText(m);
      }
    });
  }

  private cancelDrawing(): void {
    const g = this.grab;
    const d = this.drawing;
    this.drawing = null;
    this.pendingClick = null;
    this.grab = null;
    this.viewer.el.classList.remove("k-dragging");
    if (g?.moved) {
      // Avbrutt flytting: tilbake til utgangspunktet.
      const m = this.s.items.find((x) => x.id === g.id);
      if (m) m.points = g.points;
      this.s.history.pop();
      this.redraw(g.page);
    }
    if (d) this.drawPreview(d.page);
  }

  /** Setter inn den lagrede signaturen med midten i p, og velger den så den kan flyttes og skaleres. */
  private placeSignature(page: number, p: Pt): void {
    const img = loadSignature();
    const layer = this.layers.get(page);
    if (!img || !layer) return;
    const rot = this.pageRotation(layer);
    // Ikke bredere enn 40 % av arket (slik det vises), for små sider.
    const pageW = rot % 180 ? layer.geom.height : layer.geom.width;
    const w = Math.min(SIGN_WIDTH, pageW * 0.4);
    const item = this.add({ page, kind: "sign", points: rectAround(p, w, (w * img.h) / img.w, rot), rot, img });
    if (item) this.select(item.id);
  }

  private add(m: Omit<StoredMarkup, "color" | "u">): Item | null {
    const layer = this.layers.get(m.page);
    if (!layer) return null;
    const item: Item = { ...m, id: this.nextId++, color: this.color, u: Math.hypot(layer.geom.width, layer.geom.height) / 1000 };
    this.remember();
    this.s.items.push(item);
    // Ikke valgt: da gjelder fargevalget neste markering, ikke den som nettopp ble tegnet.
    this.redraw(m.page);
    this.markDirty();
    return item;
  }

  private drag(e: PointerEvent, g: NonNullable<Markup["grab"]>): void {
    if (!g.moved) {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) <= 4) return;
      g.moved = true;
      this.remember();
      this.viewer.el.classList.add("k-dragging");
    }
    const m = this.s.items.find((x) => x.id === g.id);
    const hit = this.hitPage(e, g.page);
    if (!m || !hit) return;
    const [a, b] = g.points;
    const p = hit.p;
    if (g.node === null) {
      const dx = p[0] - g.from[0];
      const dy = p[1] - g.from[1];
      m.points = g.points.map((q) => [q[0] + dx, q[1] + dy] as Pt);
    } else if (m.kind === "arrow") m.points = g.node === 0 ? [p, b] : [a, p];
    else if (m.kind === "sign" && m.img) {
      // Motsatt hjørne ligger fast, og signaturen beholder formen.
      const fixed = this.handlePoints({ ...m, points: g.points })[[1, 0, 3, 2][g.node]];
      const ratio = (m.rot ?? 0) % 180 ? m.img.h / m.img.w : m.img.w / m.img.h; // bredde/høyde i PDF-koordinater
      let dx = p[0] - fixed[0];
      let dy = p[1] - fixed[1];
      const min = this.pointsPerPixel(g.page) * 12;
      const sx = Math.sign(dx) || 1;
      const sy = Math.sign(dy) || 1;
      dx = Math.max(Math.abs(dx), min * ratio);
      dy = Math.max(Math.abs(dy), min);
      if (dx / ratio > dy) dy = dx / ratio;
      else dx = dy * ratio;
      m.points = [fixed, [fixed[0] + sx * dx, fixed[1] + sy * dy]];
    }
    else if (m.kind === "cloud") {
      // Håndtak 0 og 1 er hjørnene a og b; 2 og 3 de to andre.
      if (g.node === 0) m.points = [p, b];
      else if (g.node === 1) m.points = [a, p];
      else if (g.node === 2) m.points = [[p[0], a[1]], [b[0], p[1]]];
      else m.points = [[a[0], p[1]], [p[0], b[1]]];
    }
    this.redraw(g.page);
  }

  /** Hva et trykk treffer: et håndtak på valgt markering, eller en markering. Øverste først. */
  private hitTest(page: number, p: Pt): { id: number; node: number | null } | null {
    const ppp = this.pointsPerPixel(page);
    const sel = this.selectedItem();
    if (sel && sel.page === page) {
      const handles = this.handlePoints(sel);
      const i = handles.findIndex((q) => distance(q, p) <= ppp * 8);
      if (i >= 0) return { id: sel.id, node: i };
    }
    for (let i = this.s.items.length - 1; i >= 0; i--) {
      const m = this.s.items[i];
      if (m.page !== page) continue;
      if (m.kind === "text") {
        const L = this.layout(m);
        const [x, y] = toTextLocal(p, m.points[0], m.rot);
        const tol = ppp * 3;
        if (x >= -tol && y >= -tol && x <= L.w + tol && y <= L.h + tol) return { id: m.id, node: null };
      } else if (m.kind === "arrow") {
        if (segDist(p, m.points[0], m.points[1]) <= Math.max(ppp * 6, lineWidth(m.u) * 2)) return { id: m.id, node: null };
      } else if (m.kind === "sign") {
        const [a, b] = m.points;
        const tol = ppp * 3;
        if (p[0] >= Math.min(a[0], b[0]) - tol && p[0] <= Math.max(a[0], b[0]) + tol && p[1] >= Math.min(a[1], b[1]) - tol && p[1] <= Math.max(a[1], b[1]) + tol) return { id: m.id, node: null };
      } else {
        const [a, b] = m.points;
        const x0 = Math.min(a[0], b[0]);
        const x1 = Math.max(a[0], b[0]);
        const y0 = Math.min(a[1], b[1]);
        const y1 = Math.max(a[1], b[1]);
        const bulge = cloudBulge(a, b, m.u);
        const edge = Math.min(Math.abs(p[0] - x0), Math.abs(p[0] - x1), Math.abs(p[1] - y0), Math.abs(p[1] - y1));
        const near = p[0] >= x0 - bulge - ppp * 6 && p[0] <= x1 + bulge + ppp * 6 && p[1] >= y0 - bulge - ppp * 6 && p[1] <= y1 + bulge + ppp * 6;
        if (near && edge <= bulge + ppp * 6) return { id: m.id, node: null };
      }
    }
    return null;
  }

  /** Fjerner markeringer som berører sladdede områder (de ville ellers blitt skrevet til fila igjen). */
  removeInAreas(areas: Array<{ page: number; rect: [number, number, number, number] }>): number {
    const box = (m: Item): Pt[] => (m.kind === "text" ? textCorners(m.points[0], m.rot, this.layout(m).w, this.layout(m).h) : m.points);
    const hit = (m: Item) =>
      areas.some((a) => {
        if (a.page !== m.page) return false;
        const pts = box(m);
        const x0 = Math.min(...pts.map((p) => p[0]));
        const x1 = Math.max(...pts.map((p) => p[0]));
        const y0 = Math.min(...pts.map((p) => p[1]));
        const y1 = Math.max(...pts.map((p) => p[1]));
        return x0 < a.rect[2] && x1 > a.rect[0] && y0 < a.rect[3] && y1 > a.rect[1];
      });
    const gone = this.s.items.filter(hit);
    if (!gone.length) return 0;
    const pages = new Set(gone.map((m) => m.page));
    this.s.items = this.s.items.filter((m) => !hit(m));
    if (!this.s.items.some((m) => m.id === this.s.selected)) this.s.selected = null;
    for (const p of pages) this.redraw(p);
    this.markDirty();
    return gone.length;
  }

  private handlePoints(m: StoredMarkup): Pt[] {
    if (m.kind === "arrow") return m.points;
    if (m.kind === "cloud" || m.kind === "sign") {
      const [a, b] = m.points;
      return [a, b, [a[0], b[1]], [b[0], a[1]]];
    }
    return [];
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
    const [x, y] = g.convertToPdfPoint(((e.clientX - r.left) / r.width) * g.width, ((e.clientY - r.top) / r.height) * g.height) as number[];
    return { page, p: [x, y] };
  }

  private pointsPerPixel(page: number): number {
    const layer = this.layers.get(page);
    if (!layer || !layer.el.isConnected) return 1;
    return layer.geom.width / (layer.el.getBoundingClientRect().width || 1);
  }

  /** Sidens egen rotasjon (/Rotate), uten visningens ekstra rotasjon. */
  private pageRotation(layer: Layer): number {
    return (((layer.geom.rotation - this.viewer.rotation) % 360) + 360) % 360;
  }

  // ---------- Tekst ----------

  private layout(m: Item): TextLayout {
    return textLayout(m.text ?? "", m.u, measureText);
  }

  private newText(page: number, p: Pt): void {
    const layer = this.layers.get(page);
    if (!layer) return;
    this.openEditor(page, null, p, Math.hypot(layer.geom.width, layer.geom.height) / 1000, this.pageRotation(layer), "");
  }

  private editText(m: Item): void {
    this.openEditor(m.page, m.id, m.points[0], m.u, m.rot ?? 0, m.text ?? "");
  }

  private openEditor(page: number, id: number | null, anchor: Pt, u: number, rot: number, text: string): void {
    this.closeEditor(true);
    const layer = this.layers.get(page);
    if (!layer) return;
    const ta = h("textarea", { class: "markup-editor", spellcheck: "true", rows: 1, "aria-label": "Tekst" });
    ta.value = text;
    const color = id !== null ? (this.s.items.find((m) => m.id === id)?.color ?? this.color) : this.color;
    ta.style.color = COLORS[color].css;
    ta.style.fontFamily = FONT;
    this.editor = { el: ta, page, id, anchor, u, rot, done: false };
    const fit = () => {
      const L = textLayout(ta.value || " ", u, measureText);
      const pxPerPt = (layer.el.getBoundingClientRect().width || layer.geom.width) / layer.geom.width;
      const [x, y] = layer.geom.convertToViewportPoint(anchor[0], anchor[1]) as Pt;
      ta.style.left = `${(x / layer.geom.width) * 100}%`;
      ta.style.top = `${(y / layer.geom.height) * 100}%`;
      ta.style.fontSize = `${L.size * pxPerPt}px`;
      ta.style.lineHeight = `${L.lineHeight * pxPerPt}px`;
      ta.style.padding = `${L.pad * pxPerPt}px`;
      ta.style.width = `${(L.w + L.size) * pxPerPt}px`;
      ta.style.height = `${L.h * pxPerPt}px`;
      ta.style.transform = `rotate(${(layer.geom.rotation - rot + 360) % 360}deg)`;
    };
    ta.addEventListener("input", fit);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.closeEditor(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeEditor(false);
      }
    });
    ta.addEventListener("blur", () => this.closeEditor(true));
    // Teksten som endres, skjules mens den skrives.
    if (id !== null) this.redraw(page);
    layer.el.append(ta);
    fit();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    this.refreshBar();
  }

  /** Avslutter tekstskrivingen; `commit` lagrer teksten (tom tekst sletter). */
  private closeEditor(commit: boolean): void {
    const ed = this.editor;
    if (!ed || ed.done) return;
    ed.done = true;
    this.editor = null;
    const text = ed.el.value.replace(/\s+$/, "");
    ed.el.remove();
    const m = ed.id !== null ? this.s.items.find((x) => x.id === ed.id) : undefined;
    if (commit) {
      if (m && !text.trim()) this.remove(m.id);
      else if (m && text !== m.text) {
        this.remember();
        m.text = text;
        this.markDirty();
      } else if (!m && text.trim()) {
        const item: Item = { id: this.nextId++, page: ed.page, kind: "text", points: [ed.anchor], color: this.color, u: ed.u, text, rot: ed.rot };
        this.remember();
        this.s.items.push(item);
        this.markDirty();
      }
    }
    this.redraw(ed.page);
    this.refreshBar();
    this.viewer.el.focus({ preventScroll: true });
  }

  // ---------- Tegning på sidene ----------

  private attach(page: number, pageEl: HTMLDivElement, geom: PageGeometry): void {
    let layer = this.layers.get(page);
    if (!layer) {
      const svg = svgEl("svg", { preserveAspectRatio: "none" });
      const handles = h("div", { class: "markup-handles" });
      const el = h("div", { class: "markupLayer" });
      el.append(svg, handles);
      layer = { el, svg, handles, geom };
      this.layers.set(page, layer);
    }
    layer.geom = geom;
    layer.svg.setAttribute("viewBox", `0 0 ${geom.width} ${geom.height}`);
    // Under målelaget, så måleetikettene ligger øverst.
    const measureLayer = pageEl.querySelector(".measureLayer");
    if (measureLayer) pageEl.insertBefore(layer.el, measureLayer);
    else pageEl.append(layer.el);
    this.redraw(page);
  }

  private redrawAll(): void {
    for (const page of this.layers.keys()) this.redraw(page);
  }

  private toView(layer: Layer, p: Pt): Pt {
    return layer.geom.convertToViewportPoint(p[0], p[1]) as Pt;
  }

  private redraw(page: number): void {
    const layer = this.layers.get(page);
    if (!layer) return;
    const nodes: SVGElement[] = [];
    const handles: HTMLElement[] = [];
    for (const m of this.s.items) {
      if (m.page !== page) continue;
      // Teksten som skrives om, vises i skrivefeltet.
      if (this.editor?.id === m.id) continue;
      const sel = m.id === this.s.selected;
      nodes.push(this.shape(layer, m, sel));
      if (sel) {
        for (const p of this.handlePoints(m)) {
          const [x, y] = this.toView(layer, p);
          const d = h("div", { class: "markup-handle" });
          d.style.left = `${(x / layer.geom.width) * 100}%`;
          d.style.top = `${(y / layer.geom.height) * 100}%`;
          handles.push(d);
        }
      }
    }
    const preview = svgEl("g", { class: "k-preview" });
    layer.svg.replaceChildren(...nodes, preview);
    layer.handles.replaceChildren(...handles);
    this.drawPreview(page);
  }

  private shape(layer: Layer, m: Item | (StoredMarkup & { id?: number }), selected: boolean): SVGElement {
    const color = COLORS[m.color].css;
    const lw = lineWidth(m.u);
    const g = svgEl("g", { class: `k-shape ${m.kind}${selected ? " selected" : ""}` });
    const v = (p: Pt) => this.toView(layer, p).map((n) => n.toFixed(2)).join(" ");
    if (m.kind === "sign") {
      const r = displayRect(m.points[0], m.points[1], m.rot);
      const [x, y] = this.toView(layer, r.topLeft);
      const rot = (layer.geom.rotation - (m.rot ?? 0) + 360) % 360;
      const t = svgEl("g", { transform: `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rot})` });
      if (selected) t.append(svgEl("rect", { x: -lw * 2, y: -lw * 2, width: r.w + lw * 4, height: r.h + lw * 4, class: "k-select" }));
      const url = m.img && this.signatureUrl(m.img, m.color, m.page);
      if (url) t.append(svgEl("image", { href: url, x: 0, y: 0, width: r.w, height: r.h, preserveAspectRatio: "none" }));
      g.append(t);
    } else if (m.kind === "cloud") {
      const [a, b] = m.points;
      const curves = cloudCurves(a, b, m.u);
      if (selected) {
        const pad = cloudBulge(a, b, m.u) + lw * 2;
        const corners: Pt[] = [[Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad], [Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad]];
        g.append(this.selectionBox(layer, [corners[0], [corners[1][0], corners[0][1]], corners[1], [corners[0][0], corners[1][1]]]));
      }
      if (curves.length) {
        const d = `M ${v(curves[0][0])} ${curves.map((c) => `C ${v(c[1])} ${v(c[2])} ${v(c[3])}`).join(" ")} Z`;
        g.append(svgEl("path", { d, fill: "none", stroke: color, "stroke-width": lw, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      }
    } else if (m.kind === "arrow") {
      const [a, b] = m.points;
      const geo = arrowGeometry(a, b, m.u);
      if (selected) g.append(svgEl("path", { d: `M ${v(a)} L ${v(b)}`, class: "k-halo", "stroke-width": lw * 5 }));
      g.append(svgEl("path", { d: `M ${v(a)} L ${v(geo.end)}`, stroke: color, "stroke-width": lw, "stroke-linecap": "round", fill: "none" }));
      g.append(svgEl("path", { d: `M ${geo.head.map(v).join(" L ")} Z`, fill: color }));
    } else {
      const L = textLayout(m.text ?? "", m.u, measureText);
      const [x, y] = this.toView(layer, m.points[0]);
      const rot = (layer.geom.rotation - (m.rot ?? 0) + 360) % 360;
      const t = svgEl("g", { transform: `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rot})` });
      if (selected) t.append(svgEl("rect", { x: -lw * 2, y: -lw * 2, width: L.w + lw * 4, height: L.h + lw * 4, class: "k-select" }));
      t.append(svgEl("rect", { x: 0, y: 0, width: L.w, height: L.h, fill: "#fff", stroke: color, "stroke-width": lw * 0.7 }));
      L.lines.forEach((line, i) => {
        const tx = svgEl("text", { x: L.pad, y: L.baselines[i], fill: color, "font-size": L.size, "font-family": FONT });
        tx.textContent = line;
        t.append(tx);
      });
      g.append(t);
    }
    return g;
  }

  /** Bildet av signaturen i blekkfargen; tegner siden på nytt når det er klart. */
  private signatureUrl(img: SignatureImage, color: MarkupColor, page: number): string | null {
    const url = signatureUrl(img, COLORS[color].css);
    if (typeof url === "string") return url;
    void url.then(() => this.redraw(page));
    return null;
  }

  private selectionBox(layer: Layer, corners: Pt[]): SVGElement {
    return svgEl("polygon", { points: corners.map((p) => this.toView(layer, p).join(",")).join(" "), class: "k-select" });
  }

  /** Sky eller pil som dras opp. */
  private drawPreview(page: number): void {
    const layer = this.layers.get(page);
    const g = layer?.svg.querySelector(".k-preview");
    if (!layer || !g) return;
    const d = this.drawing?.page === page ? this.drawing : null;
    if (!d || distance(d.a, d.b) < 1e-3) {
      g.replaceChildren();
      return;
    }
    const u = Math.hypot(layer.geom.width, layer.geom.height) / 1000;
    g.replaceChildren(this.shape(layer, { page, kind: this.tool, points: [d.a, d.b], color: this.color, u }, false));
  }
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
