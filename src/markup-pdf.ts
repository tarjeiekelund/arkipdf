// Markering (sky, pil, tekst og signatur): geometri, lagring i PDF-fila og innlesing.
//
// Markeringene skrives som vanlige PDF-kommentarer, slik at de vises og kan
// redigeres i Acrobat, Bluebeam, Edge o.l.: sky som Square med skykant (BE /C),
// pil som Line med pilspiss, tekst som FreeText, signatur som Stamp med
// signaturen som bilde (blekkfarge med gjennomsiktighet), og markert,
// understreket og gjennomstreket tekst som Highlight, Underline og StrikeOut
// med QuadPoints. Alle får ferdig tegnet
// utseende og legges i laget «Merknader (ArkiPDF)», som ArkiPDF skjuler i sin
// egen visning og tegner redigerbart i stedet. Dataene leses fra nøkkelen
// «ArkiPDFMarkup».
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  StandardFonts,
  appendBezierCurve,
  beginText,
  closePath,
  concatTransformationMatrix,
  decodePDFRawStream,
  drawObject,
  endText,
  fill,
  lineTo,
  moveText,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  showText,
  stroke,
  type PDFFont,
  type PDFOperator,
} from "pdf-lib";
import { ensureLayer, textOf } from "./measure-pdf.ts";
import type { Pt } from "./measure-math.ts";

export const MARKUP_LAYER = "Merknader (ArkiPDF)";
const KEY = "ArkiPDFMarkup";

export function isMarkupLayer(name: string | null | undefined): boolean {
  return name === MARKUP_LAYER;
}

export type TextMarkupKind = "highlight" | "underline" | "strike";
export type MarkupKind = "cloud" | "arrow" | "text" | "sign" | TextMarkupKind;
export type MarkupColor = "red" | "orange" | "yellow" | "green" | "blue" | "black";

export const COLORS: Record<MarkupColor, { rgb: [number, number, number]; css: string; name: string }> = {
  red: { rgb: [0.85, 0.16, 0.12], css: "#d9291f", name: "Rød" },
  orange: { rgb: [0.95, 0.55, 0.1], css: "#f28c1a", name: "Oransje" },
  yellow: { rgb: [0.98, 0.84, 0.1], css: "#fad61a", name: "Gul" },
  green: { rgb: [0.2, 0.68, 0.25], css: "#33ad40", name: "Grønn" },
  blue: { rgb: [0.08, 0.4, 0.85], css: "#1466d9", name: "Blå" },
  black: { rgb: [0.1, 0.1, 0.1], css: "#1a1a1a", name: "Svart" },
};

/** Fargene for markert, understreket og gjennomstreket tekst (som i en penal). */
export const TEXT_COLORS: MarkupColor[] = ["red", "orange", "yellow", "green", "blue"];

export const isTextMarkup = (k: MarkupKind): k is TextMarkupKind => k === "highlight" || k === "underline" || k === "strike";

/** Markeringsfargen: lys nok til at teksten under synes (tegnes med «multipliser»). */
export function highlightRgb(c: MarkupColor): [number, number, number] {
  return COLORS[c].rgb.map((v) => 1 - (1 - v) * 0.55) as [number, number, number];
}

export function highlightCss(c: MarkupColor): string {
  return `#${highlightRgb(c).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Signaturen som bilde: hvor mye blekk det er i hver piksel. */
export interface SignatureImage {
  w: number;
  h: number;
  /** Dekningen (0–255) per piksel, rad for rad ovenfra, zlib-komprimert og i base64. */
  a: string;
}

export interface StoredMarkup {
  page: number;
  kind: MarkupKind;
  /**
   * Sky og signatur: to motsatte hjørner. Pil: fra og til (spissen). Tekst: øvre venstre hjørne.
   * Markert tekst: fire hjørner per linje (øvre venstre, øvre høyre, nedre venstre, nedre høyre
   * slik teksten står), samme rekkefølge som QuadPoints.
   */
  points: Pt[];
  color: MarkupColor;
  /** Størrelsesenhet i punkter (sidens diagonal / 1000), så markeringen passer arket. */
  u: number;
  text?: string;
  /** Sidens /Rotate da teksten eller signaturen ble lagt inn; den står rett når siden vises. */
  rot?: number;
  img?: SignatureImage;
}

// ---------- Geometri (PDF-koordinater) ----------

export const lineWidth = (u: number) => Math.max(0.5, u * 1.1);
export const fontSize = (u: number) => Math.max(6, u * 10);
const headLength = (u: number) => u * 12;

/** Enhetsvektorer for «høyre» og «ned» slik siden vises, i PDF-koordinater. */
export function displayAxes(rot = 0): { ex: Pt; ey: Pt } {
  switch (((rot % 360) + 360) % 360) {
    case 90:
      return { ex: [0, 1], ey: [1, 0] };
    case 180:
      return { ex: [-1, 0], ey: [0, 1] };
    case 270:
      return { ex: [0, -1], ey: [-1, 0] };
    default:
      return { ex: [1, 0], ey: [0, -1] };
  }
}

type Bezier = [Pt, Pt, Pt, Pt];

/**
 * Revisjonssky rundt rektangelet a–b: halvsirkler langs kantene, buet utover.
 * Gir kubiske Bézier-kurver (to per bue).
 */
export function cloudCurves(a: Pt, b: Pt, u: number): Bezier[] {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  const corners: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const chord = u * 16;
  const k = 0.5523;
  const out: Bezier[] = [];
  for (let e = 0; e < 4; e++) {
    const p = corners[e];
    const q = corners[(e + 1) % 4];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-6) continue;
    const n = Math.max(2, Math.round(len / chord));
    const d: Pt = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    // Mot klokka rundt rektangelet peker normalen (d.y, -d.x) utover.
    const nrm: Pt = [d[1], -d[0]];
    const r = len / n / 2;
    for (let i = 0; i < n; i++) {
      // Endepunktene regnes fra hjørnet, så nabobuene møtes nøyaktig.
      const at = (f: number): Pt => (f >= 1 ? q : [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]);
      const s = at(i / n);
      const t = at((i + 1) / n);
      const m: Pt = [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2];
      const top: Pt = [m[0] + nrm[0] * r, m[1] + nrm[1] * r];
      out.push([s, [s[0] + nrm[0] * k * r, s[1] + nrm[1] * k * r], [top[0] - d[0] * k * r, top[1] - d[1] * k * r], top]);
      out.push([top, [top[0] + d[0] * k * r, top[1] + d[1] * k * r], [t[0] + nrm[0] * k * r, t[1] + nrm[1] * k * r], t]);
    }
  }
  return out;
}

/** Hvor langt skyens buer stikker ut fra rektangelet (for utsnitt og treff). */
export function cloudBulge(a: Pt, b: Pt, u: number): number {
  const w = Math.abs(b[0] - a[0]);
  const h = Math.abs(b[1] - a[1]);
  const chord = u * 16;
  const r = (len: number) => (len > 0 ? len / Math.max(2, Math.round(len / chord)) / 2 : 0);
  return Math.max(r(w), r(h));
}

/** Pil fra a til b: der streken slutter, og trekanten i spissen. */
export function arrowGeometry(a: Pt, b: Pt, u: number): { end: Pt; head: [Pt, Pt, Pt] } {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const d: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const hl = Math.min(headLength(u), len * 0.6);
  const hw = hl * 0.38;
  const base: Pt = [b[0] - d[0] * hl, b[1] - d[1] * hl];
  const nrm: Pt = [-d[1], d[0]];
  return {
    end: [b[0] - d[0] * hl * 0.8, b[1] - d[1] * hl * 0.8],
    head: [b, [base[0] + nrm[0] * hw, base[1] + nrm[1] * hw], [base[0] - nrm[0] * hw, base[1] - nrm[1] * hw]],
  };
}

export interface TextLayout {
  lines: string[];
  size: number;
  pad: number;
  lineHeight: number;
  /** Bredde og høyde i punkter (slik siden vises). */
  w: number;
  h: number;
  /** Grunnlinjen til hver linje, målt ned fra toppen av boksen. */
  baselines: number[];
}

/** Tekstboksens mål. `measure` gir bredden av en tekst i punkter ved gitt størrelse. */
export function textLayout(text: string, u: number, measure: (s: string, size: number) => number): TextLayout {
  const size = fontSize(u);
  const pad = size * 0.4;
  const lineHeight = size * 1.25;
  const lines = text.split(/\r?\n/);
  const w = Math.max(size, ...lines.map((l) => measure(l, size))) + pad * 2;
  const h = pad * 2 + size * 1.05 + (lines.length - 1) * lineHeight;
  return { lines, size, pad, lineHeight, w, h, baselines: lines.map((_, i) => pad + size * 0.82 + i * lineHeight) };
}

/** Hjørnene til tekstboksen i PDF-koordinater (øvre venstre, øvre høyre, nedre høyre, nedre venstre). */
export function textCorners(anchor: Pt, rot: number | undefined, w: number, h: number): Pt[] {
  const { ex, ey } = displayAxes(rot);
  const at = (x: number, y: number): Pt => [anchor[0] + ex[0] * x + ey[0] * y, anchor[1] + ex[1] * x + ey[1] * y];
  return [at(0, 0), at(w, 0), at(w, h), at(0, h)];
}

/** Punktet p i tekstboksens egne koordinater (x mot høyre, y nedover fra øvre venstre hjørne). */
export function toTextLocal(p: Pt, anchor: Pt, rot: number | undefined): Pt {
  const { ex, ey } = displayAxes(rot);
  const dx = p[0] - anchor[0];
  const dy = p[1] - anchor[1];
  return [dx * ex[0] + dy * ex[1], dx * ey[0] + dy * ey[1]];
}

/**
 * Rektangelet a–b slik siden vises: øvre venstre hjørne og bredde og høyde
 * (i punkter) langs «høyre» og «ned» (se `displayAxes`).
 */
export function displayRect(a: Pt, b: Pt, rot: number | undefined): { topLeft: Pt; w: number; h: number } {
  const { ex, ey } = displayAxes(rot);
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  const w = ex[0] ? dx : dy;
  const h = ex[0] ? dy : dx;
  const c: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return { topLeft: [c[0] - (ex[0] * w + ey[0] * h) / 2, c[1] - (ex[1] * w + ey[1] * h) / 2], w, h };
}

/** Rektangelet (to motsatte hjørner) for en signatur med gitt bredde og høyde slik siden vises, sentrert i c. */
export function rectAround(c: Pt, w: number, h: number, rot: number | undefined): [Pt, Pt] {
  const { ex, ey } = displayAxes(rot);
  const hx = Math.abs(ex[0] * w + ey[0] * h) / 2;
  const hy = Math.abs(ex[1] * w + ey[1] * h) / 2;
  return [[c[0] - hx, c[1] - hy], [c[0] + hx, c[1] + hy]];
}

/** Linjene i markert tekst: fire hjørner hver (se `StoredMarkup.points`). */
export function quadsOf(points: Pt[]): Array<[Pt, Pt, Pt, Pt]> {
  const out: Array<[Pt, Pt, Pt, Pt]> = [];
  for (let i = 0; i + 3 < points.length; i += 4) out.push([points[i], points[i + 1], points[i + 2], points[i + 3]]);
  return out;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * Streken under eller gjennom en linje: fra og til, og tykkelsen. Rektanglene
 * fra tekstlaget går fra under nedstrekene til over versalene, så grunnlinjen
 * ligger omtrent en femdel opp og midten av småbokstavene litt under midten.
 */
export function textLine(q: [Pt, Pt, Pt, Pt], kind: "underline" | "strike"): { a: Pt; b: Pt; width: number } {
  const [tl, tr, bl, br] = q;
  const t = kind === "underline" ? 0.12 : 0.42;
  const h = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]);
  return { a: lerp(bl, tl, t), b: lerp(br, tr, t), width: Math.max(0.5, h * 0.07) };
}

// ---------- Signaturbildet ----------

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** zlib-komprimering, samme format som FlateDecode i PDF. */
export const deflate = (bytes: Uint8Array) => pipe(bytes, new CompressionStream("deflate"));
export const inflate = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream("deflate"));

/** Dekningen per piksel (w × h byte). */
export async function signatureAlpha(img: SignatureImage): Promise<Uint8Array> {
  return inflate(fromBase64(img.a));
}

/** Signaturbildet fra dekningen per piksel. */
export async function makeSignatureImage(alpha: Uint8Array, w: number, h: number): Promise<SignatureImage> {
  return { w, h, a: toBase64(await deflate(alpha)) };
}

// ---------- Lesing og skriving ----------

const KINDS: MarkupKind[] = ["cloud", "arrow", "text", "sign", "highlight", "underline", "strike"];

/** Leser markeringer som ArkiPDF har lagret i fila. */
export async function readMarkups(bytes: Uint8Array): Promise<StoredMarkup[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const out: StoredMarkup[] = [];
  const masks: Promise<void>[] = [];
  doc.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const raw = textOf(annots.lookupMaybe(i, PDFDict)?.lookup(PDFName.of(KEY)));
      if (!raw) continue;
      try {
        const d = JSON.parse(raw);
        if (!KINDS.includes(d.kind) || !Array.isArray(d.points) || !(d.u > 0)) continue;
        const points = (d.points as unknown[]).filter((p): p is Pt => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
        if (points.length < (d.kind === "text" ? 1 : 2)) continue;
        if (isTextMarkup(d.kind) && (points.length < 4 || points.length % 4)) continue;
        if (d.kind === "text" && (typeof d.text !== "string" || !d.text.trim())) continue;
        const item: StoredMarkup = {
          page: index,
          kind: d.kind,
          points,
          color: d.color in COLORS ? d.color : "red",
          u: d.u,
          text: d.kind === "text" || (isTextMarkup(d.kind) && typeof d.text === "string") ? d.text : undefined,
          rot: Number.isFinite(d.rot) ? d.rot : 0,
        };
        if (d.kind === "sign") {
          const mask = signatureMask(annots.lookupMaybe(i, PDFDict)!);
          if (!mask) continue;
          masks.push(readMask(mask).then((img) => void (item.img = img)));
        }
        out.push(item);
      } catch {
        /* Ødelagt oppføring hoppes over. */
      }
    }
  });
  await Promise.all(masks);
  return out;
}

/** Signaturbildets gjennomsiktighet (SMask) i utseendet til en signatur. */
function signatureMask(annot: PDFDict): PDFRawStream | null {
  const ap = annot.lookupMaybe(PDFName.of("AP"), PDFDict)?.lookup(PDFName.of("N"));
  if (!(ap instanceof PDFRawStream)) return null;
  const xobjects = ap.dict.lookupMaybe(PDFName.of("Resources"), PDFDict)?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  for (const [, ref] of xobjects?.entries() ?? []) {
    const img = annot.context.lookup(ref);
    const mask = img instanceof PDFRawStream ? img.dict.lookup(PDFName.of("SMask")) : null;
    if (mask instanceof PDFRawStream) return mask;
  }
  return null;
}

async function readMask(mask: PDFRawStream): Promise<SignatureImage> {
  const d = mask.dict;
  const num = (k: string) => Number(d.lookup(PDFName.of(k))?.toString());
  const w = num("Width");
  const h = num("Height");
  const filter = d.lookup(PDFName.of("Filter"));
  // Slik ArkiPDF skrev den: bruk de komprimerte bytene som de er.
  if (filter?.toString() === "/FlateDecode" && !d.has(PDFName.of("DecodeParms")) && num("BitsPerComponent") === 8) {
    return { w, h, a: toBase64(mask.contents) };
  }
  return makeSignatureImage(decodePDFRawStream(mask).decode(), w, h);
}

/** Skriver markeringene inn i PDF-en (erstatter markeringer som er lagret tidligere). */
export async function writeMarkups(bytes: Uint8Array, items: StoredMarkup[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new Error("Fila er kryptert og kan ikke endres.");
  const ctx = doc.context;
  const pages = doc.getPages();

  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep: PDFRef[] = [];
    let removed = false;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = annots.lookupMaybe(i, PDFDict);
      if (!dict?.has(PDFName.of(KEY))) {
        keep.push(raw as PDFRef);
        continue;
      }
      removed = true;
      const ap = dict.lookupMaybe(PDFName.of("AP"), PDFDict)?.get(PDFName.of("N"));
      if (ap instanceof PDFRef) {
        // Signaturbildet og masken følger med.
        const form = ctx.lookup(ap);
        const xobjects = form instanceof PDFRawStream ? form.dict.lookupMaybe(PDFName.of("Resources"), PDFDict)?.lookupMaybe(PDFName.of("XObject"), PDFDict) : undefined;
        for (const [, ref] of xobjects?.entries() ?? []) {
          if (!(ref instanceof PDFRef)) continue;
          const img = ctx.lookup(ref);
          const mask = img instanceof PDFRawStream ? img.dict.get(PDFName.of("SMask")) : undefined;
          if (mask instanceof PDFRef) ctx.delete(mask);
          ctx.delete(ref);
        }
        ctx.delete(ap);
      }
      if (raw instanceof PDFRef) ctx.delete(raw);
    }
    if (removed) {
      if (keep.length) page.node.set(PDFName.of("Annots"), ctx.obj(keep));
      else page.node.delete(PDFName.of("Annots"));
    }
  }
  if (!items.length) return doc.save();

  const layer = ensureLayer(doc, MARKUP_LAYER, isMarkupLayer);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const now = pdfDate(new Date());
  // Samme signatur flere steder lagres bare én gang.
  const masks = new Map<string, PDFRef>();
  const images = new Map<string, PDFRef>();
  const signatureRef = (img: SignatureImage, color: MarkupColor): PDFRef => {
    const key = `${color}:${img.a}`;
    let ref = images.get(key);
    if (ref) return ref;
    let mask = masks.get(img.a);
    if (!mask) {
      const s = ctx.stream(fromBase64(img.a), { Type: "XObject", Subtype: "Image", Width: img.w, Height: img.h, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "FlateDecode" });
      mask = ctx.register(s);
      masks.set(img.a, mask);
    }
    // Selve bildet er bare blekkfargen; masken gir formen.
    const rgb = COLORS[color].rgb.map((c) => Math.round(c * 255));
    const px = new Uint8Array(img.w * img.h * 3);
    for (let i = 0; i < px.length; i += 3) px.set(rgb, i);
    ref = ctx.register(ctx.flateStream(px, { Type: "XObject", Subtype: "Image", Width: img.w, Height: img.h, ColorSpace: "DeviceRGB", BitsPerComponent: 8, SMask: mask }));
    images.set(key, ref);
    return ref;
  };

  items.forEach((m, n) => {
    const page = pages[m.page];
    if (!page) return;
    const color = COLORS[m.color].rgb;
    const lw = lineWidth(m.u);
    const ops: PDFOperator[] = [pushGraphicsState()];
    const resources: Record<string, unknown> = { Font: { Helv: font.ref } };
    let bbox: [number, number, number, number];
    const dict: Record<string, unknown> = {
      Type: "Annot",
      NM: PDFString.of(`arkipdf-merk-${Date.now().toString(36)}-${n}`),
      T: PDFHexString.fromText("ArkiPDF"),
      M: PDFString.of(now),
      CreationDate: PDFString.of(now),
      F: 4,
      C: color,
      OC: layer,
      // Signaturbildet leses fra utseendet (se `signatureMask`), så det ikke ligger dobbelt i fila.
      [KEY]: PDFHexString.fromText(JSON.stringify({ v: 1, kind: m.kind, points: m.points, color: m.color, u: m.u, text: m.text, rot: m.rot })),
    };

    if (isTextMarkup(m.kind)) {
      const quads = quadsOf(m.points);
      if (!quads.length) return;
      const all = quads.flat();
      if (m.kind === "highlight") {
        const c = highlightRgb(m.color);
        ops.push(setGraphicsState("Mul"), setFillingRgbColor(...c));
        // Hjørnene rundt: øvre venstre, øvre høyre, nedre høyre, nedre venstre.
        for (const [tl, tr, bl, br] of quads) ops.push(moveTo(...tl), lineTo(...tr), lineTo(...br), lineTo(...bl), closePath(), fill());
        resources.ExtGState = { Mul: { Type: "ExtGState", BM: "Multiply" } };
        dict.C = c;
      } else {
        ops.push(setStrokingRgbColor(...color));
        for (const q of quads) {
          const l = textLine(q, m.kind);
          ops.push(setLineWidth(l.width), moveTo(...l.a), lineTo(...l.b), stroke());
        }
      }
      const xs = all.map((p) => p[0]);
      const ys = all.map((p) => p[1]);
      bbox = [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1];
      Object.assign(dict, {
        Subtype: m.kind === "highlight" ? "Highlight" : m.kind === "underline" ? "Underline" : "StrikeOut",
        QuadPoints: all.flat(),
        Contents: PDFHexString.fromText(m.text ?? ""),
      });
    } else if (m.kind === "sign") {
      if (!m.img) return;
      const [a, b] = m.points;
      const r = displayRect(a, b, m.rot);
      const { ex, ey } = displayAxes(m.rot);
      // Bildets enhetskvadrat: x mot høyre og y oppover slik siden vises, fra nedre venstre hjørne.
      const bl: Pt = [r.topLeft[0] + ey[0] * r.h, r.topLeft[1] + ey[1] * r.h];
      ops.push(concatTransformationMatrix(ex[0] * r.w, ex[1] * r.w, -ey[0] * r.h, -ey[1] * r.h, bl[0], bl[1]), drawObject("Sig"));
      resources.XObject = { Sig: signatureRef(m.img, m.color) };
      bbox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      Object.assign(dict, { Subtype: "Stamp", Name: "ArkiPDFSignatur" });
    } else if (m.kind === "cloud") {
      const [a, b] = m.points;
      const curves = cloudCurves(a, b, m.u);
      ops.push(setStrokingRgbColor(...color), setLineWidth(lw), setLineJoin(1), setLineCap(1));
      if (curves.length) {
        ops.push(moveTo(...curves[0][0]));
        for (const c of curves) ops.push(appendBezierCurve(c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]));
        ops.push(closePath(), stroke());
      }
      const pad = cloudBulge(a, b, m.u) + lw;
      const rect: [number, number, number, number] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      bbox = [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad];
      Object.assign(dict, { Subtype: "Square", BS: { W: lw, S: "S" }, BE: { S: "C", I: 1 }, RD: [pad, pad, pad, pad] });
    } else if (m.kind === "arrow") {
      const [a, b] = m.points;
      const g = arrowGeometry(a, b, m.u);
      ops.push(setStrokingRgbColor(...color), setFillingRgbColor(...color), setLineWidth(lw), setLineCap(1));
      ops.push(moveTo(...a), lineTo(...g.end), stroke());
      ops.push(moveTo(...g.head[0]), lineTo(...g.head[1]), lineTo(...g.head[2]), closePath(), fill());
      const xs = [a[0], ...g.head.map((p) => p[0])];
      const ys = [a[1], ...g.head.map((p) => p[1])];
      bbox = [Math.min(...xs) - lw, Math.min(...ys) - lw, Math.max(...xs) + lw, Math.max(...ys) + lw];
      Object.assign(dict, { Subtype: "Line", L: [a[0], a[1], b[0], b[1]], LE: ["None", "ClosedArrow"], IC: color, BS: { W: lw, S: "S" } });
    } else {
      const text = m.text ?? "";
      const safe = (s: string) => [...s].map((ch) => (canEncode(font, ch) ? ch : "?")).join("");
      const L = textLayout(text, m.u, (s, size) => font.widthOfTextAtSize(safe(s), size));
      const corners = textCorners(m.points[0], m.rot, L.w, L.h);
      const { ex, ey } = displayAxes(m.rot);
      // Tegn i tekstboksens egne koordinater (y oppover fra nedre venstre hjørne).
      const bl = corners[3];
      ops.push(concatTransformationMatrix(ex[0], ex[1], -ey[0], -ey[1], bl[0], bl[1]));
      ops.push(setFillingRgbColor(1, 1, 1), rectangle(0, 0, L.w, L.h), fill());
      ops.push(setStrokingRgbColor(...color), setLineWidth(lw * 0.7), rectangle(0, 0, L.w, L.h), stroke());
      ops.push(setFillingRgbColor(...color));
      L.lines.forEach((line, i) => {
        if (!line) return;
        // Etter BT er tekstmatrisen nullstilt, så Td er absolutt.
        ops.push(beginText(), setFontAndSize("Helv", L.size), moveText(L.pad, L.h - L.baselines[i]), showText(font.encodeText(safe(line))), endText());
      });
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      bbox = [Math.min(...xs) - lw, Math.min(...ys) - lw, Math.max(...xs) + lw, Math.max(...ys) + lw];
      const [r, g, b] = color;
      Object.assign(dict, {
        Subtype: "FreeText",
        Contents: PDFHexString.fromText(text),
        DA: PDFString.of(`/Helv ${L.size.toFixed(2)} Tf ${r} ${g} ${b} rg`),
        Q: 0,
        BS: { W: lw * 0.7, S: "S" },
      });
      if (m.rot) dict.Rotate = ((m.rot % 360) + 360) % 360;
    }
    ops.push(popGraphicsState());
    const stream = ctx.formXObject(ops, { BBox: bbox, Matrix: [1, 0, 0, 1, 0, 0], Resources: resources as never });
    dict.Rect = bbox;
    dict.AP = { N: ctx.register(stream) };
    if (m.kind === "cloud" || m.kind === "arrow" || m.kind === "sign") dict.Contents = PDFHexString.fromText(m.kind === "cloud" ? "Sky" : m.kind === "arrow" ? "Pil" : "Signatur");
    page.node.addAnnot(ctx.register(ctx.obj(dict as never)));
  });
  return doc.save();
}

/**
 * «Låser» signaturene: tegner dem inn i sidens innhold og fjerner kommentarene,
 * så de ikke kan flyttes eller slettes i andre PDF-lesere. Andre markeringer
 * blir stående som kommentarer.
 */
export async function flattenSignatures(bytes: Uint8Array): Promise<{ bytes: Uint8Array; count: number }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new Error("Fila er kryptert og kan ikke endres.");
  const ctx = doc.context;
  let count = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep: PDFRef[] = [];
    let changed = false;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = annots.lookupMaybe(i, PDFDict);
      let kind: unknown;
      try {
        kind = JSON.parse(textOf(dict?.lookup(PDFName.of(KEY))) ?? "null")?.kind;
      } catch {
        /* ikke vår */
      }
      const ap = dict?.lookupMaybe(PDFName.of("AP"), PDFDict)?.get(PDFName.of("N"));
      if (kind !== "sign" || !(ap instanceof PDFRef)) {
        keep.push(raw as PDFRef);
        continue;
      }
      // Utseendet har BBox = Rect og ingen matrise, så det tegnes rett i sidens koordinater.
      const name = page.node.newXObject("ArkiSig", ap);
      page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState());
      if (raw instanceof PDFRef) ctx.delete(raw);
      changed = true;
      count++;
    }
    if (changed) {
      if (keep.length) page.node.set(PDFName.of("Annots"), ctx.obj(keep));
      else page.node.delete(PDFName.of("Annots"));
    }
  }
  return { bytes: count ? await doc.save() : bytes, count };
}

function canEncode(font: PDFFont, ch: string): boolean {
  try {
    font.encodeText(ch);
    return true;
  } catch {
    return false;
  }
}

/** Dato på PDF-formatet D:ÅÅÅÅMMDDttmmss. */
function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
