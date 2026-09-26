// Fullskjerm-presentasjon: én side om gangen, tilpasset skjermen.
import { renderPageToCanvas, type PDFDocumentProxy } from "./pdf";
import { isFullscreen, setFullscreen } from "./platform";

export class Presentation {
  private el: HTMLDivElement;
  private stage: HTMLDivElement;
  private counter: HTMLDivElement;
  private index = 0;
  private wasFullscreen = false;
  private hideTimer = 0;
  private counterTimer = 0;
  private cache = new Map<number, Promise<HTMLCanvasElement>>();
  private token = 0;
  active = false;
  onExit: (page: number) => void = () => {};

  constructor(private readonly doc: PDFDocumentProxy) {
    this.stage = document.createElement("div");
    this.stage.className = "present-stage";
    this.counter = document.createElement("div");
    this.counter.className = "present-counter";
    this.el = document.createElement("div");
    this.el.className = "present";
    this.el.append(this.stage, this.counter);

    this.el.addEventListener("click", (e) => (e.clientX < window.innerWidth * 0.25 ? this.prev() : this.next()));
    this.el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.prev();
    });
    this.el.addEventListener("wheel", (e) => (e.deltaY > 0 ? this.next() : this.prev()), { passive: true });
    this.el.addEventListener("mousemove", () => this.showCursor());
  }

  async start(page: number): Promise<void> {
    this.active = true;
    this.index = page;
    document.body.append(this.el);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onResize);
    this.wasFullscreen = await isFullscreen();
    if (!this.wasFullscreen) await setFullscreen(true);
    this.el.focus();
    this.showCursor();
    // Vent til vinduet faktisk har fått fullskjermstørrelse før første tegning.
    setTimeout(() => void this.show(), 120);
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onResize);
    clearTimeout(this.hideTimer);
    this.el.remove();
    this.cache.clear();
    if (!this.wasFullscreen) await setFullscreen(false);
    this.onExit(this.index);
  }

  private onResize = () => {
    this.cache.clear();
    void this.show();
  };

  private onKey = (e: KeyboardEvent) => {
    const k = e.key;
    let handled = true;
    if (k === "Escape" || ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "l")) void this.stop();
    else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"].includes(k)) this.next();
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"].includes(k)) this.prev();
    else if (k === "Home") this.go(0);
    else if (k === "End") this.go(this.doc.numPages - 1);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private showCursor(): void {
    this.el.classList.remove("hide-cursor");
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.el.classList.add("hide-cursor"), 1500);
  }

  next(): void {
    this.go(this.index + 1);
  }

  prev(): void {
    this.go(this.index - 1);
  }

  go(i: number): void {
    const n = Math.max(0, Math.min(this.doc.numPages - 1, i));
    if (n === this.index) return;
    this.index = n;
    void this.show();
  }

  private render(i: number): Promise<HTMLCanvasElement> {
    let p = this.cache.get(i);
    if (!p) {
      p = (async () => {
        const page = await this.doc.getPage(i + 1);
        const vp = page.getViewport({ scale: 1 });
        const scale = Math.min(window.innerWidth / vp.width, window.innerHeight / vp.height);
        const canvas = document.createElement("canvas");
        const job = await renderPageToCanvas(page, canvas, scale, window.devicePixelRatio || 1);
        await job.done;
        canvas.style.width = `${Math.floor(vp.width * scale)}px`;
        canvas.style.height = `${Math.floor(vp.height * scale)}px`;
        return canvas;
      })();
      this.cache.set(i, p);
      // Hold bare noen få ferdigtegnede sider i minnet.
      for (const k of this.cache.keys()) if (Math.abs(k - i) > 2) this.cache.delete(k);
    }
    return p;
  }

  private async show(): Promise<void> {
    const token = ++this.token;
    const i = this.index;
    this.counter.textContent = `${i + 1} / ${this.doc.numPages}`;
    this.counter.classList.add("show");
    clearTimeout(this.counterTimer);
    this.counterTimer = window.setTimeout(() => this.counter.classList.remove("show"), 1200);
    try {
      const canvas = await this.render(i);
      if (token !== this.token || !this.active) return;
      this.stage.replaceChildren(canvas);
      // Forhåndstegn neste side så bla-skiftet blir umiddelbart.
      if (i + 1 < this.doc.numPages) void this.render(i + 1);
    } catch (e) {
      console.error(e);
    }
  }
}
