// Oppsett av pdf.js og felles hjelpere for å tegne sider.
// «legacy»-bygget har polyfills for nyere JS-funksjoner, så appen også
// fungerer med litt eldre WebView2-versjoner på Windows.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy, PDFPageProxy };
/** Hvilke lag som vises (f.eks. for å skjule våre egne mål i visningen). */
export type OptionalContent = Awaited<ReturnType<PDFDocumentProxy["getOptionalContentConfig"]>>;
export { pdfjs };

/**
 * Tegning med skjemafelt som egne HTML-felt (se Viewer): feltene tegnes ikke
 * på lerretet, og avkrysningsbokser o.l. får egne små lerreter i `canvasMap`.
 */
export interface FormRender {
  canvasMap: Map<string, HTMLCanvasElement>;
}

/** Uten skjemalag tegnes skjemafelt med verdiene som er fylt ut (ikke bare de i fila). */
function annotationOptions(forms?: FormRender | null) {
  return forms
    ? { annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS, annotationCanvasMap: forms.canvasMap }
    : { annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE };
}

/** Største antall piksler et lerret får ha (unngår minnesprekk ved kraftig zoom). */
export const MAX_CANVAS_PIXELS = 16_777_216;

export async function loadPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  // pdf.js overfører bufferet til arbeidstråden, så den får en egen kopi.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: "pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "pdfjs/standard_fonts/",
    wasmUrl: "pdfjs/wasm/",
    iccUrl: "pdfjs/iccs/",
  });
  return task.promise;
}

/**
 * Tegner en side til et lerret med gitt skala (CSS-piksler per PDF-punkt).
 * `pixelRatio` gir skarp tekst på skjermer med høy oppløsning. Kalleren
 * bestemmer selv visningsstørrelsen via CSS.
 */
export async function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
  pixelRatio = 1,
  rotation = 0,
  maxPixels = MAX_CANVAS_PIXELS,
  layers?: OptionalContent | null,
  forms?: FormRender | null,
): Promise<{ cancel: () => void; done: Promise<void> }> {
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
  let ratio = pixelRatio;
  const pixels = viewport.width * viewport.height * ratio * ratio;
  if (pixels > maxPixels) ratio = Math.sqrt(maxPixels / (viewport.width * viewport.height));

  canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio));

  const task = page.render({
    canvas,
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    background: "#ffffff",
    optionalContentConfigPromise: layers ? Promise.resolve(layers) : undefined,
    ...annotationOptions(forms),
  });
  return {
    cancel: () => task.cancel(),
    done: task.promise.catch((e: unknown) => {
      if (e instanceof pdfjs.RenderingCancelledException) return;
      throw e;
    }),
  };
}

/**
 * Tegner bare et utsnitt av en side. Brukes ved kraftig zoom på store
 * tegninger: da ville hele siden i full oppløsning blitt for stor, så vi
 * tegner i stedet det som faktisk vises, skarpt.
 *
 * `region` er i CSS-piksler innenfor siden ved gitt skala og rotasjon.
 */
export async function renderRegion(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
  rotation: number,
  region: { x: number; y: number; w: number; h: number },
  pixelRatio: number,
  maxPixels = MAX_CANVAS_PIXELS,
  layers?: OptionalContent | null,
  forms?: FormRender | null,
): Promise<{ cancel: () => void; done: Promise<void> }> {
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
  let ratio = pixelRatio;
  if (region.w * region.h * ratio * ratio > maxPixels) ratio = Math.sqrt(maxPixels / (region.w * region.h));
  canvas.width = Math.max(1, Math.round(region.w * ratio));
  canvas.height = Math.max(1, Math.round(region.h * ratio));
  const task = page.render({
    canvas,
    viewport,
    transform: [ratio, 0, 0, ratio, -region.x * ratio, -region.y * ratio],
    background: "#ffffff",
    optionalContentConfigPromise: layers ? Promise.resolve(layers) : undefined,
    ...annotationOptions(forms),
  });
  return {
    cancel: () => task.cancel(),
    done: task.promise.catch((e: unknown) => {
      if (e instanceof pdfjs.RenderingCancelledException) return;
      throw e;
    }),
  };
}

/** Enkel kø så ikke hundre miniatyrer tegnes samtidig. */
export class RenderQueue {
  private running = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly limit = 2) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

/** Tolker «1-3, 7, 10-» til sideindekser (0-basert). Kaster ved ugyldig tekst. */
export function parsePageRange(text: string, pageCount: number): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const raw of text.split(/[,;]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/);
    let from: number;
    let to: number;
    if (m) {
      from = m[1] ? parseInt(m[1], 10) : 1;
      to = m[2] ? parseInt(m[2], 10) : pageCount;
    } else if (/^\d+$/.test(part)) {
      from = to = parseInt(part, 10);
    } else {
      throw new Error(`Forstår ikke «${part}»`);
    }
    if (from < 1 || to > pageCount || from > to) {
      throw new Error(`«${part}» er utenfor 1–${pageCount}`);
    }
    for (let p = from; p <= to; p++) {
      if (!seen.has(p)) {
        seen.add(p);
        result.push(p - 1);
      }
    }
  }
  if (!result.length) throw new Error("Ingen sider valgt");
  return result;
}

/**
 * Miniatyrbilder, tegnet én gang per side og lagret som små JPEG-er så
 * tusenvis av sider ikke spiser minnet. Brukes av sidepanelet og sorteringen.
 */
export class ThumbCache {
  private urls = new Map<number, string>();
  private pending = new Map<number, Promise<string>>();
  private queue = new RenderQueue(2);

  constructor(private readonly doc: PDFDocumentProxy, private readonly width = 220) {}

  get(index: number): Promise<string> {
    const url = this.urls.get(index);
    if (url) return Promise.resolve(url);
    let p = this.pending.get(index);
    if (!p) {
      p = this.queue.run(async () => {
        const page = await this.doc.getPage(index + 1);
        const base = page.getViewport({ scale: 1 });
        const canvas = document.createElement("canvas");
        const r = await renderPageToCanvas(page, canvas, this.width / base.width, 1);
        await r.done;
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
        canvas.width = canvas.height = 0;
        const u = blob ? URL.createObjectURL(blob) : "";
        this.urls.set(index, u);
        this.pending.delete(index);
        return u;
      });
      this.pending.set(index, p);
    }
    return p;
  }

  dispose(): void {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
  }
}
