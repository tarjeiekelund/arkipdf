// «Sorter sider»: rutenett av miniatyrer som kan dras, roteres og slettes.
import type { PageItem } from "./edit";
import type { ThumbCache } from "./pdf";
import { button, h, icon, toast } from "./ui";

export interface OrganizeCallbacks {
  save: (items: PageItem[]) => Promise<void>;
  saveAs: (items: PageItem[]) => Promise<void>;
  close: () => void;
}

export class Organizer {
  readonly el: HTMLDivElement;
  private grid: HTMLDivElement;
  private status: HTMLSpanElement;
  private items: PageItem[];
  private history: PageItem[][] = [];
  private selected = new Set<PageItem>();
  private anchor: PageItem | null = null;
  private cards = new Map<PageItem, HTMLDivElement>();
  private observer: IntersectionObserver;
  private marker: HTMLDivElement;
  private saveBtn: HTMLButtonElement;

  constructor(pageCount: number, private readonly thumbs: ThumbCache, private readonly cb: OrganizeCallbacks) {
    this.items = Array.from({ length: pageCount }, (_, i) => ({ src: i, rot: 0 }));
    this.status = h("span", { class: "muted" });
    this.saveBtn = button("Lagre", "save", () => void this.cb.save(this.items), { primary: true, title: "Lagre endringene i fila (Ctrl+S)" });

    const bar = h(
      "div",
      { class: "subbar" },
      h("strong", {}, "Sorter sider"),
      h("span", { class: "muted hint" }, "Dra sidene for å endre rekkefølge. Ctrl/Shift-klikk for å velge flere."),
      h("span", { class: "spacer" }),
      button("", "rotateLeft", () => this.rotate(-90), { title: "Roter valgte mot klokka" }),
      button("", "rotateRight", () => this.rotate(90), { title: "Roter valgte med klokka" }),
      button("Slett", "trash", () => this.remove(), { title: "Slett valgte sider (Delete)" }),
      h("span", { class: "sep" }),
      this.status,
      button("Avbryt", null, () => this.cb.close(), { title: "Lukk uten å lagre (Esc)" }),
      button("Lagre som…", null, () => void this.cb.saveAs(this.items), { title: "Lagre som ny fil (Ctrl+Shift+S)" }),
      this.saveBtn,
    );

    this.grid = h("div", { class: "grid", tabindex: "0" });
    this.marker = h("div", { class: "drop-marker" });
    this.el = h("div", { class: "organizer" }, bar, this.grid);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const img = e.target.querySelector("img")!;
          const src = Number((e.target as HTMLElement).dataset.src);
          this.observer.unobserve(e.target);
          void this.thumbs.get(src).then((u) => (img.src = u));
        }
      },
      { root: this.grid, rootMargin: "400px 0px" },
    );

    this.grid.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.grid.addEventListener("mousedown", (e) => {
      if (e.target === this.grid) this.select(null, e);
    });
    this.build();
  }

  get dirty(): boolean {
    return this.history.length > 0;
  }

  private snapshot(): void {
    this.history.push(this.items.map((x) => ({ ...x })));
    if (this.history.length > 100) this.history.shift();
  }

  undo(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.items = prev;
    this.selected.clear();
    this.build();
  }

  private build(): void {
    this.observer.disconnect();
    this.cards.clear();
    const frag = document.createDocumentFragment();
    this.items.forEach((it, pos) => {
      const img = h("img", { alt: "", draggable: "false" });
      img.style.transform = rotation(it.rot);
      const card = h(
        "div",
        { class: "card", "data-src": String(it.src) },
        h("div", { class: "thumb" }, img),
        h("div", { class: "label" }, h("span", { class: "pos" }, String(pos + 1)), it.src !== pos ? h("span", { class: "muted" }, ` (var ${it.src + 1})`) : null),
      );
      if (this.selected.has(it)) card.classList.add("selected");
      this.cards.set(it, card);
      frag.append(card);
      this.observer.observe(card);
    });
    this.grid.replaceChildren(frag);
    this.updateStatus();
  }

  private updateStatus(): void {
    const n = this.items.length;
    this.status.textContent = `${n} ${n === 1 ? "side" : "sider"}${this.selected.size ? ` · ${this.selected.size} valgt` : ""}${this.dirty ? " · ulagret" : ""}`;
    this.saveBtn.disabled = !this.dirty;
  }

  private refreshSelection(): void {
    for (const [it, card] of this.cards) card.classList.toggle("selected", this.selected.has(it));
    this.updateStatus();
  }

  private select(it: PageItem | null, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void {
    if (!it) {
      this.selected.clear();
    } else if (e.shiftKey && this.anchor) {
      const a = this.items.indexOf(this.anchor);
      const b = this.items.indexOf(it);
      if (!(e.ctrlKey || e.metaKey)) this.selected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(this.items[i]);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(it)) this.selected.delete(it);
      else this.selected.add(it);
      this.anchor = it;
    } else {
      this.selected.clear();
      this.selected.add(it);
      this.anchor = it;
    }
    this.refreshSelection();
  }

  selectAll(): void {
    this.items.forEach((it) => this.selected.add(it));
    this.refreshSelection();
  }

  rotate(delta: number): void {
    if (!this.selected.size) return;
    this.snapshot();
    for (const it of this.selected) {
      it.rot = (it.rot + delta) % 360;
      const img = this.cards.get(it)!.querySelector("img")!;
      img.style.transform = rotation(it.rot);
    }
    this.updateStatus();
  }

  remove(): void {
    if (!this.selected.size) return;
    if (this.selected.size >= this.items.length) {
      toast("Dokumentet må ha minst én side.", "error");
      return;
    }
    this.snapshot();
    this.items = this.items.filter((it) => !this.selected.has(it));
    this.selected.clear();
    this.build();
  }

  /** Flytter valgte sider ett hakk (tastatur: Ctrl+pil). */
  nudge(dir: -1 | 1): void {
    if (!this.selected.size) return;
    const idx = this.items.map((it, i) => (this.selected.has(it) ? i : -1)).filter((i) => i >= 0);
    const target = dir < 0 ? idx[0] - 1 : idx[idx.length - 1] + 2;
    if (target < 0 || target > this.items.length) return;
    this.moveSelected(target);
  }

  /** Flytter alle valgte sider slik at de havner foran posisjon `before`. */
  private moveSelected(before: number): void {
    const moving = this.items.filter((it) => this.selected.has(it));
    const shift = this.items.slice(0, before).filter((it) => this.selected.has(it)).length;
    const rest = this.items.filter((it) => !this.selected.has(it));
    const at = before - shift;
    const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (next.every((it, i) => it === this.items[i])) return;
    this.snapshot();
    this.items = next;
    this.build();
    this.cards.get(moving[0])?.scrollIntoView({ block: "nearest" });
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const card = (e.target as HTMLElement).closest(".card") as HTMLDivElement | null;
    if (!card) return;
    const it = [...this.cards].find(([, c]) => c === card)?.[0];
    if (!it) return;
    e.preventDefault();
    this.grid.focus();

    const wasSelected = this.selected.has(it);
    if (!wasSelected || e.shiftKey || e.ctrlKey || e.metaKey) this.select(it, e);

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let ghost: HTMLDivElement | null = null;
    let dropAt = -1;
    let scrollTimer = 0;
    let lastY = startY;

    const autoscroll = () => {
      const r = this.grid.getBoundingClientRect();
      const edge = 60;
      if (lastY < r.top + edge) this.grid.scrollTop -= 14;
      else if (lastY > r.bottom - edge) this.grid.scrollTop += 14;
      scrollTimer = requestAnimationFrame(autoscroll);
    };

    const move = (ev: PointerEvent) => {
      lastY = ev.clientY;
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        ghost = h("div", { class: "drag-ghost", html: `${icon("file")}<span>${this.selected.size} ${this.selected.size === 1 ? "side" : "sider"}</span>` });
        document.body.append(ghost);
        for (const s of this.selected) this.cards.get(s)?.classList.add("dragging");
        scrollTimer = requestAnimationFrame(autoscroll);
      }
      ghost!.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      dropAt = this.dropIndex(ev.clientX, ev.clientY);
    };

    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      cancelAnimationFrame(scrollTimer);
      ghost?.remove();
      this.marker.remove();
      if (dragging) {
        for (const c of this.cards.values()) c.classList.remove("dragging");
        if (dropAt >= 0) this.moveSelected(dropAt);
      } else if (wasSelected && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
        this.select(it, ev);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Finner innsettingspunktet nærmest pekeren og viser en markør der. */
  private dropIndex(x: number, y: number): number {
    let best = -1;
    let bestDist = Infinity;
    let bestRect: DOMRect | null = null;
    let after = false;
    const gridRect = this.grid.getBoundingClientRect();
    this.items.forEach((it, i) => {
      const r = this.cards.get(it)!.getBoundingClientRect();
      if (r.bottom < gridRect.top - 200 || r.top > gridRect.bottom + 200) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = Math.hypot((x - cx) / 2, y - cy);
      if (d < bestDist) {
        bestDist = d;
        best = i;
        bestRect = r;
        after = x > cx;
      }
    });
    if (best < 0 || !bestRect) return -1;
    const r = bestRect as DOMRect;
    const m = this.marker;
    m.style.left = `${(after ? r.right + 4 : r.left - 8) - gridRect.left + this.grid.scrollLeft}px`;
    m.style.top = `${r.top - gridRect.top + this.grid.scrollTop}px`;
    m.style.height = `${r.height}px`;
    if (!m.isConnected) this.grid.append(m);
    return after ? best + 1 : best;
  }

  handleKey(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === "Escape") this.cb.close();
    else if (ctrl && k.toLowerCase() === "s" && e.shiftKey) void this.cb.saveAs(this.items);
    else if (ctrl && k.toLowerCase() === "s") {
      if (this.dirty) void this.cb.save(this.items);
    } else if (ctrl && k.toLowerCase() === "z") this.undo();
    else if (ctrl && k.toLowerCase() === "a") this.selectAll();
    else if (k === "Delete") this.remove();
    else if (ctrl && k === "ArrowLeft") this.nudge(-1);
    else if (ctrl && k === "ArrowRight") this.nudge(1);
    else if (ctrl && k.toLowerCase() === "r") this.rotate(e.shiftKey ? -90 : 90);
    else return false;
    return true;
  }
}

/** Liggende miniatyrer krympes litt så de holder seg innenfor kortet. */
function rotation(deg: number): string {
  return `rotate(${deg}deg)${deg % 180 ? " scale(0.75)" : ""}`;
}
