// Markering (sky, pil og tekst): geometri, lagring i PDF-fila og innlesing.
//
// Markeringene skrives som vanlige PDF-kommentarer, slik at de vises og kan
// redigeres i Acrobat, Bluebeam, Edge o.l.: sky som Square med skykant (BE /C),
// pil som Line med pilspiss, tekst som FreeText. Alle får ferdig tegnet
// utseende og legges i laget «Merknader (ArkiPDF)», som ArkiPDF skjuler i sin
// egen visning og tegner redigerbart i stedet. Dataene leses fra nøkkelen
// «ArkiPDFMarkup».
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  StandardFonts,
  appendBezierCurve,
  beginText,
  closePath,
  concatTransformationMatrix,
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

export type MarkupKind = "cloud" | "arrow" | "text";
export type MarkupColor = "red" | "blue" | "black";

export const COLORS: Record<MarkupColor, { rgb: [number, number, number]; css: string; name: string }> = {
  red: { rgb: [0.85, 0.16, 0.12], css: "#d9291f", name: "Rød" },
  blue: { rgb: [0.08, 0.4, 0.85], css: "#1466d9", name: "Blå" },
  black: { rgb: [0.1, 0.1, 0.1], css: "#1a1a1a", name: "Svart" },
};

export interface StoredMarkup {
  page: number;
  kind: MarkupKind;
  /** Sky: to motsatte hjørner. Pil: fra og til (spissen). Tekst: øvre venstre hjørne. */
  points: Pt[];
  color: MarkupColor;
  /** Størrelsesenhet i punkter (sidens diagonal / 1000), så markeringen passer arket. */
  u: number;
  text?: string;
  /** Sidens /Rotate da teksten ble skrevet; teksten står rett når siden vises. */
  rot?: number;
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

// ---------- Lesing og skriving ----------

const KINDS: MarkupKind[] = ["cloud", "arrow", "text"];

/** Leser markeringer som ArkiPDF har lagret i fila. */
export async function readMarkups(bytes: Uint8Array): Promise<StoredMarkup[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const out: StoredMarkup[] = [];
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
        if (d.kind === "text" && (typeof d.text !== "string" || !d.text.trim())) continue;
        out.push({
          page: index,
          kind: d.kind,
          points,
          color: d.color in COLORS ? d.color : "red",
          u: d.u,
          text: d.kind === "text" ? d.text : undefined,
          rot: Number.isFinite(d.rot) ? d.rot : 0,
        });
      } catch {
        /* Ødelagt oppføring hoppes over. */
      }
    }
  });
  return out;
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
      if (ap instanceof PDFRef) ctx.delete(ap);
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

  items.forEach((m, n) => {
    const page = pages[m.page];
    if (!page) return;
    const color = COLORS[m.color].rgb;
    const lw = lineWidth(m.u);
    const ops: PDFOperator[] = [pushGraphicsState()];
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
      [KEY]: PDFHexString.fromText(JSON.stringify({ v: 1, kind: m.kind, points: m.points, color: m.color, u: m.u, text: m.text, rot: m.rot })),
    };

    if (m.kind === "cloud") {
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
    const stream = ctx.formXObject(ops, { BBox: bbox, Matrix: [1, 0, 0, 1, 0, 0], Resources: { Font: { Helv: font.ref } } });
    dict.Rect = bbox;
    dict.AP = { N: ctx.register(stream) };
    if (m.kind !== "text") dict.Contents = PDFHexString.fromText(m.kind === "cloud" ? "Sky" : "Pil");
    page.node.addAnnot(ctx.register(ctx.obj(dict as never)));
  });
  return doc.save();
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
