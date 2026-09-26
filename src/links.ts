// Lenker og destinasjoner i PDF-en: klikkbare lenker på sidene, og
// oversetting av bokmerker/lenkemål til «side + posisjon».
import type { PDFDocumentProxy, PDFPageProxy } from "./pdf";

/** Et mål i dokumentet. `x`/`y` er i PDF-koordinater (punkter), hvis oppgitt. */
export interface Target {
  page: number;
  x?: number | null;
  y?: number | null;
}

/** Hva en lenke gjør når man klikker den. */
export type LinkAction = { kind: "target"; dest: unknown } | { kind: "url"; url: string } | { kind: "named"; name: string };

interface LinkAnnotation {
  subtype?: string;
  rect: number[];
  dest?: unknown;
  url?: string;
  unsafeUrl?: string;
  action?: string;
}

/** Bare nettadresser og e-post åpnes; aldri file:, javascript: o.l. */
export function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return ["http:", "https:", "mailto:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** Oversetter et lenkemål (navn eller eksplisitt mål) til side og posisjon. */
export async function resolveDest(doc: PDFDocumentProxy, dest: unknown): Promise<Target | null> {
  let explicit: unknown = dest;
  if (typeof dest === "string") explicit = await doc.getDestination(dest);
  if (!Array.isArray(explicit) || explicit.length < 2) return null;
  const [ref, kind, ...args] = explicit as [unknown, { name?: string } | undefined, ...Array<number | null>];
  let page: number;
  if (Number.isInteger(ref)) page = ref as number;
  else if (ref && typeof ref === "object") {
    try {
      page = await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
    } catch {
      return null;
    }
  } else return null;
  if (page < 0 || page >= doc.numPages) return null;

  switch (kind?.name) {
    case "XYZ":
      return { page, x: args[0], y: args[1] };
    case "FitH":
    case "FitBH":
      return { page, y: args[0] };
    case "FitV":
    case "FitBV":
      return { page, x: args[0] };
    case "FitR":
      return { page, x: args[0], y: args[3] };
    default:
      return { page };
  }
}

/**
 * Lager et lag med klikkbare områder over lenkene på en side. Posisjonene
 * er i prosent av siden, så laget følger med når man zoomer.
 */
export async function buildLinkLayer(page: PDFPageProxy, rotation: number, onLink: (action: LinkAction) => void): Promise<HTMLDivElement | null> {
  const annots = (await page.getAnnotations({ intent: "display" })) as LinkAnnotation[];
  const links = annots.filter((a) => a.subtype === "Link");
  if (!links.length) return null;
  const vp = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
  const layer = document.createElement("div");
  layer.className = "linkLayer";
  for (const a of links) {
    let action: LinkAction | null = null;
    const url = safeUrl(a.url ?? a.unsafeUrl);
    if (url) action = { kind: "url", url };
    else if (a.dest) action = { kind: "target", dest: a.dest };
    else if (a.action) action = { kind: "named", name: a.action };
    if (!action) continue;

    const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const el = document.createElement("a");
    el.href = "#";
    el.style.left = `${(left / vp.width) * 100}%`;
    el.style.top = `${(top / vp.height) * 100}%`;
    el.style.width = `${(Math.abs(x2 - x1) / vp.width) * 100}%`;
    el.style.height = `${(Math.abs(y2 - y1) / vp.height) * 100}%`;
    el.title = action.kind === "url" ? action.url : "Gå til";
    const act = action;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      onLink(act);
    });
    layer.append(el);
  }
  return layer;
}
