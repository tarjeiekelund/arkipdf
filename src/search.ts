// Tekstsøk (Ctrl+F): finner treff i hele dokumentet, markerer dem i
// tekstlaget og hopper mellom dem.
import type { PDFDocumentProxy } from "./pdf";
import { button, h, icon } from "./ui";
import type { TextLayerInfo, Viewer } from "./viewer";

interface PageText {
  /** Start-posisjon i `text` for hver tekstbit (samme rekkefølge som tekstlagets span-er). */
  starts: number[];
  text: string;
}

interface Match {
  start: number;
  end: number;
}

export class Search {
  readonly el: HTMLDivElement;
  private input: HTMLInputElement;
  private counter: HTMLSpanElement;
  private doc: PDFDocumentProxy | null = null;
  private texts = new Map<number, Promise<PageText>>();
  /** Treff per side (undefined = ikke søkt gjennom ennå). */
  private matches: Array<Match[] | undefined> = [];
  private selected: { page: number; idx: number } | null = null;
  private query = "";
  private token = 0;
  private scanning = false;
  private scanned = 0;
  private anyText = false;
  private revealPage = -1;
  private highlighted = new Map<number, Set<number>>();
  private debounce = 0;

  constructor(private readonly viewer: Viewer) {
    this.input = h("input", { type: "text", placeholder: "Søk i dokumentet", "aria-label": "Søk i dokumentet", spellcheck: "false" });
    this.counter = h("span", { class: "search-count muted" });
    this.el = h(
      "div",
      { class: "searchbar", role: "search", hidden: true },
      h("span", { class: "search-icon", html: icon("search") }),
      this.input,
      this.counter,
      button("", "up", () => this.step(-1), { title: "Forrige treff (Shift+Enter)", className: "ghost" }),
      button("", "down", () => this.step(1), { title: "Neste treff (Enter / F3)", className: "ghost" }),
      button("", "close", () => this.close(), { title: "Lukk søk (Esc)", className: "ghost" }),
    );

    this.input.addEventListener("input", () => {
      clearTimeout(this.debounce);
      this.debounce = window.setTimeout(() => this.run(this.input.value), 200);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // Et nytt søk som ikke har startet ennå, kjøres med en gang.
        if (this.input.value !== this.query) {
          clearTimeout(this.debounce);
          this.run(this.input.value);
        } else this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });

    viewer.onTextLayer = (page, layer) => this.paint(page, layer);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  setDocument(doc: PDFDocumentProxy | null): void {
    this.doc = doc;
    this.texts.clear();
    this.highlighted.clear();
    const q = this.query;
    this.query = "";
    if (this.isOpen && q) this.run(q);
    else this.reset();
  }

  open(): void {
    if (!this.doc) return;
    this.el.hidden = false;
    this.input.focus();
    this.input.select();
  }

  close(): void {
    this.el.hidden = true;
    this.run("");
    this.viewer.el.focus();
  }

  private reset(): void {
    this.token++;
    this.matches = [];
    this.selected = null;
    this.scanning = false;
    this.scanned = 0;
    this.anyText = false;
    this.updateCounter();
  }

  private pageText(i: number): Promise<PageText> {
    let p = this.texts.get(i);
    if (!p) {
      p = this.doc!.getPage(i + 1)
        .then((page) => page.getTextContent())
        .then((content) => {
          const starts: number[] = [];
          let text = "";
          for (const item of content.items) {
            if (!("str" in item)) continue;
            starts.push(text.length);
            text += item.str;
            // Linjeskift blir mellomrom, så ord på hver sin linje ikke limes sammen.
            if (item.hasEOL && !text.endsWith(" ")) text += " ";
          }
          return { starts, text };
        });
      this.texts.set(i, p);
    }
    return p;
  }

  private run(query: string): void {
    this.reset();
    this.query = query;
    this.revealPage = -1;
    this.viewer.refreshTextLayers();
    const doc = this.doc;
    const trimmed = query.trim();
    if (!doc || !trimmed) {
      this.updateCounter();
      return;
    }
    const pattern = trimmed
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*");
    const re = new RegExp(pattern, "giu");
    const token = this.token;
    const n = doc.numPages;
    const startPage = this.viewer.current;
    this.scanning = true;
    this.updateCounter();

    // Søk fra siden du står på og videre, så første treff kommer raskt også
    // i store dokumenter. Resten av dokumentet søkes gjennom i bakgrunnen.
    void (async () => {
      let lastUpdate = 0;
      for (let k = 0; k < n; k++) {
        const i = (startPage + k) % n;
        const { text } = await this.pageText(i);
        if (token !== this.token) return;
        if (text.trim()) this.anyText = true;
        const found: Match[] = [];
        re.lastIndex = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          found.push({ start: m.index, end: m.index + m[0].length });
        }
        this.matches[i] = found;
        this.scanned++;
        if (found.length) {
          if (!this.selected) this.select(i, 0);
          else this.paintPage(i);
        }
        if (performance.now() - lastUpdate > 150) {
          lastUpdate = performance.now();
          this.updateCounter();
          await new Promise((r) => setTimeout(r));
          if (token !== this.token) return;
        }
      }
      this.scanning = false;
      this.updateCounter();
    })();
  }

  private total(): number {
    return this.matches.reduce((sum, m) => sum + (m?.length ?? 0), 0);
  }

  private updateCounter(): void {
    const total = this.total();
    const n = this.doc?.numPages ?? 0;
    let text = "";
    if (!this.query.trim()) text = "";
    else if (total === 0) text = this.scanning ? `Søker … ${Math.round((this.scanned / Math.max(1, n)) * 100)} %` : this.anyText ? "Ingen treff" : "Ingen søkbar tekst";
    else {
      let before = 0;
      if (this.selected) for (let p = 0; p < this.selected.page; p++) before += this.matches[p]?.length ?? 0;
      text = `${this.selected ? before + this.selected.idx + 1 : 0} av ${total}${this.scanning ? " …" : ""}`;
    }
    this.counter.textContent = text;
    this.el.classList.toggle("no-match", !!this.query.trim() && !this.scanning && total === 0);
  }

  step(dir: 1 | -1): void {
    if (!this.selected) return;
    const { page, idx } = this.selected;
    const here = this.matches[page] ?? [];
    if (idx + dir >= 0 && idx + dir < here.length) return this.select(page, idx + dir);
    const n = this.doc?.numPages ?? 0;
    for (let k = 1; k <= n; k++) {
      const p = (((page + dir * k) % n) + n) % n;
      const m = this.matches[p];
      if (m?.length) return this.select(p, dir > 0 ? 0 : m.length - 1);
    }
  }

  private select(page: number, idx: number): void {
    const prev = this.selected?.page;
    this.selected = { page, idx };
    this.updateCounter();
    if (prev !== undefined && prev !== page) this.paintPage(prev);
    this.revealPage = page;
    const layer = this.viewer.textLayer(page);
    if (layer) this.paint(page, layer);
    else this.viewer.goToPage(page);
  }

  private paintPage(page: number): void {
    const layer = this.viewer.textLayer(page);
    if (layer) this.paint(page, layer);
  }

  /** Legger markeringer inn i tekstlaget for én side. */
  private paint(page: number, layer: TextLayerInfo): void {
    const { textDivs, textContentItemsStr: strs } = layer;
    // Fjern gamle markeringer.
    const old = this.highlighted.get(page);
    if (old) for (const i of old) if (textDivs[i]) textDivs[i].textContent = strs[i];
    this.highlighted.delete(page);

    const matches = this.matches[page];
    if (!matches?.length || !this.query.trim()) return;
    void this.pageText(page).then(({ starts }) => {
      if (this.matches[page] !== matches) return;
      // Del opp hvert treff i biter per tekst-span.
      const parts = new Map<number, Array<{ s: number; e: number; selected: boolean }>>();
      matches.forEach((m, mi) => {
        const selected = this.selected?.page === page && this.selected.idx === mi;
        for (let i = 0; i < starts.length; i++) {
          const s0 = starts[i];
          const e0 = s0 + strs[i].length;
          if (e0 <= m.start || s0 >= m.end) continue;
          const list = parts.get(i) ?? [];
          list.push({ s: Math.max(m.start, s0) - s0, e: Math.min(m.end, e0) - s0, selected });
          parts.set(i, list);
        }
      });
      let selectedEl: HTMLElement | null = null;
      for (const [i, list] of parts) {
        const div = textDivs[i];
        if (!div) continue;
        const str = strs[i];
        div.textContent = "";
        let pos = 0;
        for (const part of list) {
          if (part.s > pos) div.append(str.slice(pos, part.s));
          const mark = h("span", { class: part.selected ? "highlight selected" : "highlight" }, str.slice(part.s, part.e));
          if (part.selected && !selectedEl) selectedEl = mark;
          div.append(mark);
          pos = part.e;
        }
        if (pos < str.length) div.append(str.slice(pos));
      }
      this.highlighted.set(page, new Set(parts.keys()));
      if (selectedEl && this.revealPage === page) {
        this.revealPage = -1;
        (selectedEl as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
      }
    });
  }
}
