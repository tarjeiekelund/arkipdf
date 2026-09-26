// Fullskjerm-presentasjon: én side om gangen, tilpasset skjermen.
//
// I tillegg til vanlig bla-funksjon kan man zoome inn på et utsnitt av en
// tegning (Ctrl+musehjul, knip eller +/−), dra rundt i den, hoppe direkte
// til en side (skriv sidetallet + Enter), vise svart/hvit skjerm (B/W) og
// bruke en laserpeker (L).
import { renderPageToCanvas, renderRegion, type PDFDocumentProxy } from "./pdf";
import { enterPresentationScreen } from "./platform";

const MAX_ZOOM = 16;

interface Base {
  canvas: HTMLCanvasElement;
  /** Visningsstørrelse i CSS-piksler når siden er tilpasset skjermen. */
  w: number;
  h: number;
  fitScale: number;
}

export class Presentation {
  private el: HTMLDivElement;
  private sheet: HTMLDivElement;
  private counter: HTMLDivElement;
  private help: HTMLDivElement;
  private blank: HTMLDivElement;
  private laser: HTMLDivElement;
  private index = 0;
  private restore: (() => Promise<void>) | null = null;
  private hideTimer = 0;
  private counterTimer = 0;
  private detailTimer = 0;
  private cache = new Map<number, Promise<Base>>();
  private token = 0;
  private base: Base | null = null;
  private detail: HTMLCanvasElement | null = null;
  private detailCancel: (() => void) | null = null;
  /** Zoom (1 = hele siden) og hvilket punkt på siden (0–1) som er midt på skjermen. */
  private zoom = 1;
  private cx = 0.5;
  private cy = 0.5;
  private typed = "";
  private laserOn = false;
  private dragged = false;
  active = false;
  onExit: (page: number) => void = () => {};

  constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly rotation = 0,
  ) {
    this.sheet = div("present-sheet");
    this.counter = div("present-counter");
    this.blank = div("present-blank");
    this.laser = div("present-laser");
    this.help = div("present-help");
    this.help.innerHTML = `
      <h2>Presentasjon</h2>
      <dl>
        <dt>→ ↓ PgDn Mellomrom Enter</dt><dd>Neste side</dd>
        <dt>← ↑ PgUp Backspace</dt><dd>Forrige side</dd>
        <dt>12 + Enter</dt><dd>Gå til side 12</dd>
        <dt>Home / End</dt><dd>Første / siste side</dd>
        <dt>Ctrl+musehjul, + / −</dt><dd>Zoom inn/ut på tegningen</dd>
        <dt>Dra med musa, piltaster</dt><dd>Flytt rundt når du har zoomet</dd>
        <dt>0</dt><dd>Hele siden igjen</dd>
        <dt>B / W</dt><dd>Svart / hvit skjerm</dd>
        <dt>L</dt><dd>Laserpeker av/på</dd>
        <dt>Esc</dt><dd>Avslutt</dd>
      </dl>
      <p>Trykk ? for å lukke denne hjelpen.</p>`;
    this.help.hidden = true;
    this.blank.hidden = true;
    this.laser.hidden = true;
    this.el = div("present");
    this.el.tabIndex = -1;
    this.el.append(this.sheet, this.blank, this.laser, this.counter, this.help);

    this.el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!this.dragged) this.prev();
    });
    this.el.addEventListener("wheel", this.onWheel, { passive: false });
    this.el.addEventListener("pointerdown", this.onPointerDown);
    this.el.addEventListener("pointermove", (e) => {
      this.showCursor();
      if (this.laserOn) this.laser.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    });
  }

  /** Starter på gitt side, eventuelt på en annen skjerm (f.eks. projektor). */
  async start(page: number, screenId: string | null = null): Promise<void> {
    this.active = true;
    this.index = page;
    document.body.append(this.el);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onResize);
    this.restore = await enterPresentationScreen(screenId);
    this.el.focus();
    this.showCursor();
    this.flash("Esc avslutter · ? viser snarveier", 2500);
    // Vent til vinduet faktisk har fått fullskjermstørrelse før første tegning.
    setTimeout(() => void this.show(true), 150);
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onResize);
    clearTimeout(this.hideTimer);
    clearTimeout(this.detailTimer);
    this.detailCancel?.();
    this.el.remove();
    this.cache.clear();
    await this.restore?.();
    this.onExit(this.index);
  }

  private onResize = () => {
    this.cache.clear();
    void this.show();
  };

  // ---------- Tastatur og mus ----------

  private onKey = (e: KeyboardEvent) => {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    if (k === "Escape" || (ctrl && k.toLowerCase() === "l")) {
      if (!this.help.hidden) this.help.hidden = true;
      else void this.stop();
    } else if (/^[0-9]$/.test(k) && !ctrl && (this.typed || k !== "0")) {
      this.typed = (this.typed + k).slice(0, 5);
      this.flash(`Gå til side ${this.typed} … (Enter)`, 4000);
    } else if (k === "0" && !ctrl) this.resetZoom();
    else if (k === "Enter" && this.typed) {
      const n = parseInt(this.typed, 10);
      this.typed = "";
      this.go(n - 1, true);
    } else if (k === "?" || k === "F1") this.help.hidden = !this.help.hidden;
    else if (k === "b" || k === "B" || k === ".") this.toggleBlank("black");
    else if (k === "w" || k === "W" || k === ",") this.toggleBlank("white");
    else if (k === "l" || k === "L") this.toggleLaser();
    else if (k === "+" || k === "=" || e.code === "NumpadAdd") this.zoomAt(this.zoom * 1.5);
    else if (k === "-" || e.code === "NumpadSubtract") this.zoomAt(this.zoom / 1.5);
    else if (this.zoom > 1 && k.startsWith("Arrow")) {
      const step = 0.15 / this.zoom;
      if (k === "ArrowLeft") this.cx -= step;
      if (k === "ArrowRight") this.cx += step;
      if (k === "ArrowUp") this.cy -= step;
      if (k === "ArrowDown") this.cy += step;
      this.layout();
    } else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"].includes(k)) this.next();
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"].includes(k)) this.prev();
    else if (k === "Home") this.go(0);
    else if (k === "End") this.go(this.doc.numPages - 1);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (handled && !/^[0-9]$/.test(k) && k !== "Enter") this.typed = "";
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoomAt(this.zoom * Math.exp(-delta * 0.0018), e.clientX, e.clientY);
    } else if (this.zoom > 1 && this.base) {
      // Zoomet inn: musehjulet flytter utsnittet.
      this.cx += e.deltaX / (this.base.w * this.zoom);
      this.cy += e.deltaY / (this.base.h * this.zoom);
      this.layout();
    } else if (Math.abs(e.deltaY) > 4) {
      if (e.deltaY > 0) this.next();
      else this.prev();
    }
  };

  /** Klikk blar (venstre fjerdedel: tilbake). Når man har zoomet, drar man i stedet. */
  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.dragged = false;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const cx0 = this.cx;
    const cy0 = this.cy;
    this.el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) this.dragged = true;
      if (this.dragged && this.zoom > 1 && this.base) {
        this.el.classList.add("panning");
        this.cx = cx0 - (ev.clientX - x0) / (this.base.w * this.zoom);
        this.cy = cy0 - (ev.clientY - y0) / (this.base.h * this.zoom);
        this.layout();
      }
    };
    const up = (ev: PointerEvent) => {
      this.el.removeEventListener("pointermove", move);
      this.el.removeEventListener("pointerup", up);
      this.el.classList.remove("panning");
      if (this.dragged || this.zoom > 1 || !this.help.hidden) return;
      if (!this.blank.hidden) return this.toggleBlank(null);
      if (ev.clientX < window.innerWidth * 0.25) this.prev();
      else this.next();
    };
    this.el.addEventListener("pointermove", move);
    this.el.addEventListener("pointerup", up);
  };

  private showCursor(): void {
    this.el.classList.remove("hide-cursor");
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.el.classList.add("hide-cursor"), 1500);
  }

  private flash(text: string, ms = 1200): void {
    this.counter.textContent = text;
    this.counter.classList.add("show");
    clearTimeout(this.counterTimer);
    this.counterTimer = window.setTimeout(() => this.counter.classList.remove("show"), ms);
  }

  private toggleBlank(color: "black" | "white" | null): void {
    const same = !this.blank.hidden && this.blank.dataset.color === color;
    if (!color || same) {
      this.blank.hidden = true;
      return;
    }
    this.blank.dataset.color = color;
    this.blank.hidden = false;
  }

  private toggleLaser(): void {
    this.laserOn = !this.laserOn;
    this.laser.hidden = !this.laserOn;
    this.el.classList.toggle("laser", this.laserOn);
    this.flash(this.laserOn ? "Laserpeker på (L slår av)" : "Laserpeker av");
  }

  // ---------- Navigering ----------

  next(): void {
    this.go(this.index + 1);
  }

  prev(): void {
    this.go(this.index - 1);
  }

  go(i: number, announce = false): void {
    this.toggleBlank(null);
    const n = Math.max(0, Math.min(this.doc.numPages - 1, i));
    if (n === this.index) {
      if (announce) this.flash(`${n + 1} / ${this.doc.numPages}`);
      return;
    }
    this.index = n;
    void this.show();
  }

  // ---------- Zoom ----------

  private resetZoom(): void {
    this.zoom = 1;
    this.cx = this.cy = 0.5;
    this.layout();
  }

  /** Zoomer mot et skjermpunkt (standard: midten), så punktet blir liggende. */
  private zoomAt(z: number, sx = window.innerWidth / 2, sy = window.innerHeight / 2): void {
    const b = this.base;
    if (!b) return;
    const nz = Math.max(1, Math.min(MAX_ZOOM, z));
    // Punktet på siden som ligger under (sx, sy) nå:
    const px = this.cx + (sx - window.innerWidth / 2) / (b.w * this.zoom);
    const py = this.cy + (sy - window.innerHeight / 2) / (b.h * this.zoom);
    this.zoom = nz;
    this.cx = px - (sx - window.innerWidth / 2) / (b.w * nz);
    this.cy = py - (sy - window.innerHeight / 2) / (b.h * nz);
    this.layout();
    if (nz > 1) this.flash(`${Math.round(nz * 100)} %`);
  }

  /** Plasserer siden etter zoom og utsnitt, og ber om et skarpt detaljbilde. */
  private layout(): void {
    const b = this.base;
    if (!b) return;
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const z = this.zoom;
    // Hold utsnittet innenfor siden; er siden mindre enn skjermen, sentrer den.
    const clamp = (c: number, size: number, screen: number) => {
      const half = screen / (2 * size * z);
      return half >= 0.5 ? 0.5 : Math.max(half, Math.min(1 - half, c));
    };
    this.cx = clamp(this.cx, b.w, sw);
    this.cy = clamp(this.cy, b.h, sh);
    const left = sw / 2 - this.cx * b.w * z;
    const top = sh / 2 - this.cy * b.h * z;
    const st = this.sheet.style;
    st.width = `${b.w}px`;
    st.height = `${b.h}px`;
    st.transform = `translate(${left}px, ${top}px) scale(${z})`;
    this.el.classList.toggle("zoomed", z > 1);

    clearTimeout(this.detailTimer);
    this.detailCancel?.();
    if (z > 1) this.detailTimer = window.setTimeout(() => void this.renderDetail(), 150);
    else this.dropDetail();
  }

  private dropDetail(): void {
    this.detailCancel?.();
    this.detailCancel = null;
    if (this.detail) {
      this.detail.remove();
      this.detail.width = this.detail.height = 0;
      this.detail = null;
    }
  }

  /** Tegner det synlige utsnittet i full oppløsning oppå det forstørrede grunnbildet. */
  private async renderDetail(): Promise<void> {
    const b = this.base;
    if (!b || this.zoom <= 1) return;
    const token = this.token;
    const z = this.zoom;
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const fullW = b.w * z;
    const fullH = b.h * z;
    const x = Math.max(0, Math.floor(this.cx * fullW - sw / 2));
    const y = Math.max(0, Math.floor(this.cy * fullH - sh / 2));
    const w = Math.min(fullW, Math.ceil(this.cx * fullW + sw / 2)) - x;
    const h = Math.min(fullH, Math.ceil(this.cy * fullH + sh / 2)) - y;
    const page = await this.doc.getPage(this.index + 1);
    const canvas = document.createElement("canvas");
    canvas.className = "detail";
    const job = await renderRegion(page, canvas, b.fitScale * z, this.rotation, { x, y, w, h }, window.devicePixelRatio || 1);
    this.detailCancel = job.cancel;
    await job.done.catch(() => {});
    if (token !== this.token || z !== this.zoom || this.base !== b || !this.active) {
      canvas.width = canvas.height = 0;
      return;
    }
    this.detailCancel = null;
    Object.assign(canvas.style, {
      left: `${(x / fullW) * 100}%`,
      top: `${(y / fullH) * 100}%`,
      width: `${(w / fullW) * 100}%`,
      height: `${(h / fullH) * 100}%`,
    });
    const old = this.detail;
    this.detail = canvas;
    if (old) {
      old.replaceWith(canvas);
      old.width = old.height = 0;
    } else this.sheet.append(canvas);
  }

  // ---------- Tegning ----------

  private render(i: number): Promise<Base> {
    let p = this.cache.get(i);
    if (!p) {
      p = (async () => {
        const page = await this.doc.getPage(i + 1);
        const vp = page.getViewport({ scale: 1, rotation: (page.rotate + this.rotation) % 360 });
        const fitScale = Math.min(window.innerWidth / vp.width, window.innerHeight / vp.height);
        const canvas = document.createElement("canvas");
        canvas.className = "base";
        const job = await renderPageToCanvas(page, canvas, fitScale, window.devicePixelRatio || 1, this.rotation);
        await job.done;
        return { canvas, w: Math.floor(vp.width * fitScale), h: Math.floor(vp.height * fitScale), fitScale };
      })();
      this.cache.set(i, p);
      // Hold bare noen få ferdigtegnede sider i minnet.
      for (const k of this.cache.keys()) if (Math.abs(k - i) > 2) this.cache.delete(k);
    }
    return p;
  }

  private async show(first = false): Promise<void> {
    const token = ++this.token;
    const i = this.index;
    if (!first) this.flash(`${i + 1} / ${this.doc.numPages}`);
    try {
      const base = await this.render(i);
      if (token !== this.token || !this.active) return;
      this.dropDetail();
      this.base = base;
      this.zoom = 1;
      this.cx = this.cy = 0.5;
      this.sheet.replaceChildren(base.canvas);
      this.layout();
      // Forhåndstegn neste side så bla-skiftet blir umiddelbart.
      if (i + 1 < this.doc.numPages) void this.render(i + 1);
    } catch (e) {
      console.error(e);
    }
  }
}

function div(className: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = className;
  return d;
}
