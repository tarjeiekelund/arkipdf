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

/** Retningen fra `a` til `b` i radianer. */
export function angleOf(a: Pt, b: Pt): number {
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

/**
 * Låser retningen fra `from` mot `to` til nærmeste `ref + k·step` og
 * projiserer `to` ned på den linjen (Shift under tegning).
 */
export function lockDirection(from: Pt, to: Pt, ref: number, step: number): Pt {
  const ang = ref + Math.round((angleOf(from, to) - ref) / step) * step;
  const u: Pt = [Math.cos(ang), Math.sin(ang)];
  const len = (to[0] - from[0]) * u[0] + (to[1] - from[1]) * u[1];
  return [from[0] + u[0] * len, from[1] + u[1] * len];
}

/** Skjæringen mellom linjene p + t·d og q + s·e (null om de er parallelle). */
export function lineIntersection(p: Pt, d: Pt, q: Pt, e: Pt): Pt | null {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-9 * Math.hypot(...d) * Math.hypot(...e)) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

function project(p: Pt, o: Pt, d: Pt): Pt {
  const len2 = d[0] * d[0] + d[1] * d[1];
  const t = ((p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1]) / len2;
  return [o[0] + d[0] * t, o[1] + d[1] * t];
}

/**
 * Shift mens et punkt dras: hjørnene hos naboene holdes på 90° (eller 45° mot
 * arket når naboen ikke har noen annen kant). Ligger punktet nær der begge
 * nabohjørnene blir rette, festes det der.
 */
export function lockVertex(points: Pt[], i: number, closed: boolean, p: Pt, tol: number): Pt {
  const n = points.length;
  const at = (j: number): Pt | null => (closed ? points[((j % n) + n) % n] : (points[j] ?? null));
  const idx = (j: number) => (closed ? ((j % n) + n) % n : j);
  const groups: Array<Array<{ o: Pt; d: Pt }>> = [];
  for (const step of [-1, 1]) {
    const nb = at(i + step);
    if (!nb || idx(i + step) === i) continue;
    const far = at(i + 2 * step);
    // Vinkelrett på nabokanten (ikke rett fram, som ville gitt en rett vinkel på 180°).
    const angles = far && idx(i + 2 * step) !== i ? [angleOf(far, nb) + Math.PI / 2] : [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4];
    groups.push(angles.map((a) => ({ o: nb, d: [Math.cos(a), Math.sin(a)] as Pt })));
  }
  if (!groups.length) return p;
  if (groups.length === 2) {
    let best: Pt | null = null;
    for (const a of groups[0])
      for (const b of groups[1]) {
        const x = lineIntersection(a.o, a.d, b.o, b.d);
        if (x && distance(x, p) <= tol && (!best || distance(x, p) < distance(best, p))) best = x;
      }
    if (best) return best;
  }
  let best = p;
  let bestD = Infinity;
  for (const g of groups)
    for (const l of g) {
      const q = project(p, l.o, l.d);
      if (distance(q, p) < bestD) {
        best = q;
        bestD = distance(q, p);
      }
    }
  return best;
}

/** Rektangel med første side a–b og bredde gitt av `c` (vinkelrett på a–b). */
export function rectFrom(a: Pt, b: Pt, c: Pt): Pt[] {
  const len = distance(a, b);
  if (!len) return [a, b, b, a];
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  const w = (c[0] - b[0]) * nx + (c[1] - b[1]) * ny;
  return [a, b, [b[0] + nx * w, b[1] + ny * w], [a[0] + nx * w, a[1] + ny * w]];
}

/** Punkter rundt en sirkel (for tegning og lagring som polygon). */
export function circlePoints(c: Pt, r: number, n = 72): Pt[] {
  return Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((i / n) * 2 * Math.PI), c[1] + r * Math.sin((i / n) * 2 * Math.PI)] as Pt);
}

/** Fortegnet areal: positivt mot klokka (PDF har y oppover). */
function signedArea(points: Pt[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/** Enhetsnormalen til venstre for kanten a→b. */
function leftNormal(a: Pt, b: Pt): Pt {
  const len = distance(a, b) || 1;
  return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
}

/**
 * Flytter kant `i` (fra punkt i til i+1) avstanden `d` langs normalen til
 * venstre. Endepunktene glir langs nabokantene, så de beholder retningen.
 */
export function offsetEdge(points: Pt[], i: number, d: number, closed: boolean): Pt[] {
  const n = points.length;
  const j = (i + 1) % n;
  const a = points[i];
  const b = points[j];
  const nrm = leftNormal(a, b);
  const dir: Pt = [b[0] - a[0], b[1] - a[1]];
  const a2: Pt = [a[0] + nrm[0] * d, a[1] + nrm[1] * d];
  const b2: Pt = [b[0] + nrm[0] * d, b[1] + nrm[1] * d];
  const prev = closed || i > 0 ? points[(i - 1 + n) % n] : null;
  const next = closed || j < n - 1 ? points[(j + 1) % n] : null;
  const out = points.map((p) => [p[0], p[1]] as Pt);
  out[i] = (prev && prev !== b && lineIntersection(a2, dir, prev, [a[0] - prev[0], a[1] - prev[1]])) || a2;
  out[j] = (next && next !== a && lineIntersection(a2, dir, next, [b[0] - next[0], b[1] - next[1]])) || b2;
  return out;
}

/**
 * Gir kant `i` lengden `len`: punkt i står fast. Åpen linje: resten av
 * linjen flyttes med. Lukket figur: også neste kant flyttes parallelt, så et
 * rektangel forblir et rektangel.
 */
export function setEdgeLength(points: Pt[], i: number, len: number, closed: boolean): Pt[] {
  const n = points.length;
  const j = (i + 1) % n;
  const cur = distance(points[i], points[j]);
  if (!cur) return points;
  const k = (len - cur) / cur;
  const dx = (points[j][0] - points[i][0]) * k;
  const dy = (points[j][1] - points[i][1]) * k;
  const move = new Set<number>(closed ? [j, (j + 1) % n] : Array.from({ length: n - j }, (_, x) => j + x));
  move.delete(i);
  return points.map((p, x) => (move.has(x) ? ([p[0] + dx, p[1] + dy] as Pt) : p));
}

/**
 * Forskyver en kontur avstanden `d`. Lukket figur: positiv `d` er utover.
 * Åpen linje: positiv `d` er til venstre i tegneretningen.
 */
export function offsetPath(points: Pt[], d: number, closed: boolean): Pt[] {
  const n = points.length;
  const sign = closed && signedArea(points) > 0 ? -1 : 1;
  const dist = closed ? d * sign : d;
  const edges = closed ? n : n - 1;
  const lines = Array.from({ length: edges }, (_, i) => {
    const a = points[i];
    const b = points[(i + 1) % n];
    const nrm = leftNormal(a, b);
    return { o: [a[0] + nrm[0] * dist, a[1] + nrm[1] * dist] as Pt, d: [b[0] - a[0], b[1] - a[1]] as Pt, nrm };
  });
  return points.map((p, i) => {
    const before = closed ? lines[(i - 1 + edges) % edges] : lines[i - 1];
    const after = lines[i % edges] && (closed || i < edges) ? lines[i] : null;
    const shift = (l: { nrm: Pt }) => [p[0] + l.nrm[0] * dist, p[1] + l.nrm[1] * dist] as Pt;
    if (before && after) return lineIntersection(before.o, before.d, after.o, after.d) ?? shift(after);
    return shift((before ?? after)!);
  });
}

/** Leser et tall skrevet på norsk eller engelsk («12,5» eller «12.5»). */
export function parseNumber(s: string): number | null {
  const t = s.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Sider fra tekst som «2, 4-6» eller «alle» (1-basert inn, 0-basert ut). */
export function parsePages(s: string, count: number): number[] | null {
  const t = s.trim().toLowerCase();
  if (t === "alle" || t === "all") return Array.from({ length: count }, (_, i) => i);
  const out = new Set<number>();
  for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > count || a > b) return null;
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
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
