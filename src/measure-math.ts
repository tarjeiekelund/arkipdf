// Beregninger for måling: målestokk, avstand, areal og lesing av
// målestokk som er lagt inn i PDF-en (Revit, ArchiCAD, AutoCAD m.fl.).
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from "pdf-lib";

export type Pt = [number, number];

/** Én PDF-punkt (1/72") på arket, i meter. */
export const PAPER_METERS_PER_POINT = 0.0254 / 72;

/** Et område på en side med innebygd målestokk (PDF «viewport» med «Measure»). */
export interface PdfScaleRegion {
  bbox: [number, number, number, number];
  metersPerPoint: number;
  label: string;
}

const UNITS: Record<string, number> = {
  m: 1,
  meter: 1,
  meters: 1,
  mm: 0.001,
  cm: 0.01,
  dm: 0.1,
  km: 1000,
  in: 0.0254,
  '"': 0.0254,
  inch: 0.0254,
  ft: 0.3048,
  "'": 0.3048,
  feet: 0.3048,
  yd: 0.9144,
  mi: 1609.344,
};

export function unitToMeters(unit: string): number | null {
  return UNITS[unit.trim().toLowerCase()] ?? null;
}

/** Meter i virkeligheten per PDF-punkt for målestokk 1:`den`. */
export function metersPerPointForScale(den: number): number {
  return PAPER_METERS_PER_POINT * den;
}

/** Omtrentlig målestokk («1:100») for en faktor, når arket skrives ut 1:1. */
export function scaleLabel(metersPerPoint: number): string {
  const den = metersPerPoint / PAPER_METERS_PER_POINT;
  const nice = den >= 10 ? Math.round(den) : Math.round(den * 10) / 10;
  return `1:${nice.toLocaleString("nb-NO")}`;
}

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function pathLength(points: Pt[], closed = false): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += distance(points[i - 1], points[i]);
  if (closed && points.length > 2) sum += distance(points[points.length - 1], points[0]);
  return sum;
}

/** Korteste avstand fra `p` til linjestykket a–b. */
export function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return distance(p, [a[0] + t * dx, a[1] + t * dy]);
}

/** Korteste avstand fra `p` til en polylinje (lukket: også siste–første). */
export function pathDistance(p: Pt, points: Pt[], closed = false): number {
  let best = points.length ? distance(p, points[0]) : Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, segmentDistance(p, points[i - 1], points[i]));
  if (closed && points.length > 2) best = Math.min(best, segmentDistance(p, points[points.length - 1], points[0]));
  return best;
}

/**
 * Hvor et nytt punkt ved `p` skal inn i en polylinje: indeksen det settes inn
 * på (før punktet med den indeksen) og punktet flyttet inn på nærmeste kant.
 * Lukket: kanten fra siste til første punkt teller også (settes inn til slutt).
 */
export function insertionPoint(p: Pt, points: Pt[], closed = false): { index: number; p: Pt } {
  let best = { index: 1, p: points[0], d: Infinity };
  const n = points.length;
  const edges = closed && n > 2 ? n : n - 1;
  for (let i = 0; i < edges; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    const q: Pt = [a[0] + t * dx, a[1] + t * dy];
    const d = distance(p, q);
    if (d < best.d) best = { index: i + 1, p: q, d };
  }
  return { index: best.index, p: best.p };
}

/** Om `p` ligger inne i polygonet (strålekasting). */
export function insidePolygon(p: Pt, points: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Areal av et polygon (skolissformelen), alltid positivt. */
export function polygonArea(points: Pt[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** Tyngdepunkt for et polygon (for plassering av etiketten). */
export function centroid(points: Pt[]): Pt {
  const a = points.reduce((s, _, i) => {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    return s + (x1 * y2 - x2 * y1);
  }, 0);
  if (Math.abs(a) < 1e-9) {
    const n = points.length;
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Låser retningen fra `from` til nærmeste 45° (Shift under måling). */
export function snap45(from: Pt, to: Pt): Pt {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [from[0] + Math.cos(ang) * len, from[1] + Math.sin(ang) * len];
}

const fmt = (v: number, decimals: number) => v.toLocaleString("nb-NO", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** Lengde i meter, vist som «12,35 m» eller «850 mm». */
export function formatLength(meters: number, unit: "m" | "mm"): string {
  return unit === "mm" ? `${fmt(meters * 1000, 0)} mm` : `${fmt(meters, 2)} m`;
}

export function formatArea(m2: number): string {
  return `${fmt(m2, 2)} m²`;
}

/** Mål på selve arket (uten målestokk), i mm. */
export function formatPaper(points: number): string {
  return `${fmt(points * PAPER_METERS_PER_POINT * 1000, 1)} mm på arket`;
}

function text(obj: unknown): string | null {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return null;
}

/**
 * Leser innebygd målestokk fra PDF-en: sider kan ha en «VP»-liste med
 * områder (f.eks. en planvisning på arket) som hver har sin «Measure».
 * Returnerer områder per sideindeks.
 */
export async function readPdfScales(bytes: Uint8Array): Promise<Map<number, PdfScaleRegion[]>> {
  const result = new Map<number, PdfScaleRegion[]>();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  doc.getPages().forEach((page, index) => {
    const vps = page.node.lookupMaybe(PDFName.of("VP"), PDFArray);
    if (!vps) return;
    const regions: PdfScaleRegion[] = [];
    for (let i = 0; i < vps.size(); i++) {
      const vp = vps.lookupMaybe(i, PDFDict);
      const measure = vp?.lookupMaybe(PDFName.of("Measure"), PDFDict);
      const bboxArr = vp?.lookupMaybe(PDFName.of("BBox"), PDFArray);
      if (!measure || !bboxArr || bboxArr.size() < 4) continue;
      const subtype = measure.lookupMaybe(PDFName.of("Subtype"), PDFName);
      if (subtype && subtype.asString() !== "/RL") continue;
      const x = measure.lookupMaybe(PDFName.of("X"), PDFArray);
      const fmt0 = x?.lookupMaybe(0, PDFDict);
      const c = fmt0?.lookupMaybe(PDFName.of("C"), PDFNumber)?.asNumber();
      const unit = text(fmt0?.lookup(PDFName.of("U")));
      const perUnit = unit ? unitToMeters(unit) : null;
      if (!c || !perUnit) continue;
      const nums = [0, 1, 2, 3].map((k) => bboxArr.lookupMaybe(k, PDFNumber)?.asNumber() ?? 0);
      const bbox: [number, number, number, number] = [Math.min(nums[0], nums[2]), Math.min(nums[1], nums[3]), Math.max(nums[0], nums[2]), Math.max(nums[1], nums[3])];
      const metersPerPoint = c * perUnit;
      regions.push({ bbox, metersPerPoint, label: text(measure.lookup(PDFName.of("R"))) || scaleLabel(metersPerPoint) });
    }
    if (regions.length) result.set(index, regions);
  });
  return result;
}

/** Finner innebygd målestokk for et punkt; minste område vinner ved overlapp. */
export function regionAt(regions: PdfScaleRegion[] | undefined, p: Pt): PdfScaleRegion | null {
  if (!regions) return null;
  let best: PdfScaleRegion | null = null;
  let bestArea = Infinity;
  for (const r of regions) {
    const [x1, y1, x2, y2] = r.bbox;
    if (p[0] < x1 || p[0] > x2 || p[1] < y1 || p[1] > y2) continue;
    const a = (x2 - x1) * (y2 - y1);
    if (a < bestArea) {
      best = r;
      bestArea = a;
    }
  }
  return best;
}
