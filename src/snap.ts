// Snapping under måling: finner hjørner, midtpunkter, skjæringspunkter og
// linjer i selve tegningen, så målene treffer veggene nøyaktig.
//
// Strekene hentes fra pdf.js' operatorliste (samme data som tegnes på
// skjermen) og legges i et rutenett for raske oppslag rundt musepekeren.
import { AnnotationMode, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist";
import type { Pt } from "./measure-math";

export type SnapKind = "vertex" | "mid" | "cross" | "line";

export interface SnapHit {
  p: Pt;
  kind: SnapKind;
}

/** Hvor mange streker vi tar med per side (svært tunge tegninger kuttes). */
const MAX_SEGMENTS = 400_000;
/** Rutestørrelse i PDF-punkter. */
const CELL = 24;
/** Midtpunkter bare for streker som er lange nok til å være interessante. */
const MID_MIN_LENGTH = 12;

type Matrix = [number, number, number, number, number, number];

const PAINT_OPS = new Set<number>([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
]);
// Kodene pdf.js bruker i stidata (DrawOPS).
const MOVE = 0;
const LINE = 1;
const CURVE = 2;
const QUAD = 3;
const CLOSE = 4;

function mul(m: Matrix, n: number[]): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export class SnapIndex {
  /** Streker som [x1, y1, x2, y2, …]. */
  private segs: Float64Array;
  private nSegs = 0;
  /** Punkter som [x, y, …] med type i `pointKinds`. */
  private pts: number[] = [];
  private pointKinds: SnapKind[] = [];
  private segCells = new Map<number, number[]>();
  private ptCells = new Map<number, number[]>();
  readonly truncated: boolean;

  private constructor(segs: number[], curveEnds: number[], truncated: boolean) {
    this.segs = Float64Array.from(segs);
    this.nSegs = segs.length / 4;
    this.truncated = truncated;
    const seen = new Set<string>();
    for (let i = 0; i < curveEnds.length; i += 2) this.addPoint(curveEnds[i], curveEnds[i + 1], "vertex", seen);
    for (let i = 0; i < this.nSegs; i++) {
      const [x1, y1, x2, y2] = this.seg(i);
      this.addPoint(x1, y1, "vertex", seen);
      this.addPoint(x2, y2, "vertex", seen);
      if (Math.hypot(x2 - x1, y2 - y1) >= MID_MIN_LENGTH) this.addPoint((x1 + x2) / 2, (y1 + y2) / 2, "mid", seen);
      // Streken registreres i alle ruter den kan berøre.
      const cx1 = Math.floor(Math.min(x1, x2) / CELL);
      const cx2 = Math.floor(Math.max(x1, x2) / CELL);
      const cy1 = Math.floor(Math.min(y1, y2) / CELL);
      const cy2 = Math.floor(Math.max(y1, y2) / CELL);
      for (let cx = cx1; cx <= cx2; cx++)
        for (let cy = cy1; cy <= cy2; cy++) {
          const k = key(cx, cy);
          let list = this.segCells.get(k);
          if (!list) this.segCells.set(k, (list = []));
          list.push(i);
        }
    }
  }

  get segmentCount(): number {
    return this.nSegs;
  }

  private seg(i: number): [number, number, number, number] {
    const o = i * 4;
    return [this.segs[o], this.segs[o + 1], this.segs[o + 2], this.segs[o + 3]];
  }

  private addPoint(x: number, y: number, kind: SnapKind, seen: Set<string>): void {
    const id = `${Math.round(x * 20)},${Math.round(y * 20)}`;
    if (seen.has(id)) return;
    seen.add(id);
    const idx = this.pointKinds.length;
    this.pts.push(x, y);
    this.pointKinds.push(kind);
    const k = key(Math.floor(x / CELL), Math.floor(y / CELL));
    let list = this.ptCells.get(k);
    if (!list) this.ptCells.set(k, (list = []));
    list.push(idx);
  }

  /** Leser strekene på en side. Tekst og bilder hoppes over. */
  static async build(page: PDFPageProxy): Promise<SnapIndex> {
    const ol = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
    const segs: number[] = [];
    const curveEnds: number[] = [];
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    let truncated = false;
    const apply = (x: number, y: number): Pt => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    const push = (a: Pt, b: Pt) => {
      if (segs.length / 4 >= MAX_SEGMENTS) {
        truncated = true;
        return;
      }
      if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) return;
      segs.push(a[0], a[1], b[0], b[1]);
    };

    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i];
      const args = ol.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = mul(ctm, Array.from(args[0] as ArrayLike<number>));
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.constructPath) {
        const [op, data] = args as [number, [ArrayLike<number> | undefined]];
        const path = data?.[0];
        if (!PAINT_OPS.has(op) || !path || typeof (path as ArrayLike<number>).length !== "number") continue;
        let cur: Pt | null = null;
        let start: Pt | null = null;
        for (let j = 0; j < path.length; ) {
          const code = path[j++];
          if (code === MOVE) {
            cur = start = apply(path[j], path[j + 1]);
            j += 2;
          } else if (code === LINE) {
            const p = apply(path[j], path[j + 1]);
            j += 2;
            if (cur) push(cur, p);
            cur = p;
          } else if (code === CURVE) {
            // Kurver: bare endepunktene er nyttige å snappe til.
            const p = apply(path[j + 4], path[j + 5]);
            j += 6;
            if (cur && curveEnds.length < MAX_SEGMENTS) curveEnds.push(cur[0], cur[1], p[0], p[1]);
            cur = p;
          } else if (code === QUAD) {
            cur = apply(path[j + 2], path[j + 3]);
            j += 4;
          } else if (code === CLOSE) {
            if (cur && start) push(cur, start);
            cur = start;
          } else break;
        }
      }
    }
    return new SnapIndex(segs, curveEnds, truncated);
  }

  /**
   * Beste snappunkt innenfor `tol` (PDF-punkter): hjørner foretrekkes
   * framfor skjæringspunkter, midtpunkter og til sist et vilkårlig punkt
   * på en linje.
   */
  query(p: Pt, tol: number): SnapHit | null {
    const [x, y] = p;
    const cx1 = Math.floor((x - tol) / CELL);
    const cx2 = Math.floor((x + tol) / CELL);
    const cy1 = Math.floor((y - tol) / CELL);
    const cy2 = Math.floor((y + tol) / CELL);
    // Fast prioritet som i CAD: hjørne > skjæring > midtpunkt > på linje.
    // Innenfor samme type vinner det nærmeste. Slik velges et veggjørne
    // framfor tette skraverings- eller rutenettlinjer rett ved siden av.
    let best: SnapHit | null = null;
    let bestTier = Infinity;
    let bestDist = Infinity;
    const consider = (q: Pt, kind: SnapKind) => {
      const d = Math.hypot(q[0] - x, q[1] - y);
      if (d > tol) return;
      const tier = TIER[kind];
      if (tier < bestTier || (tier === bestTier && d < bestDist)) {
        bestTier = tier;
        bestDist = d;
        best = { p: q, kind };
      }
    };

    const nearSegs = new Set<number>();
    for (let cx = cx1; cx <= cx2; cx++)
      for (let cy = cy1; cy <= cy2; cy++) {
        const k = key(cx, cy);
        for (const i of this.ptCells.get(k) ?? []) consider([this.pts[i * 2], this.pts[i * 2 + 1]], this.pointKinds[i]);
        for (const s of this.segCells.get(k) ?? []) nearSegs.add(s);
      }

    // Nærmeste punkt på hver strek i nærheten, og skjæringer mellom dem.
    const close: number[] = [];
    for (const s of nearSegs) {
      const q = closestOnSegment(this.seg(s), p);
      if (Math.hypot(q[0] - x, q[1] - y) <= tol) {
        close.push(s);
        consider(q, "line");
      }
    }
    if (close.length <= 60) {
      for (let a = 0; a < close.length; a++)
        for (let b = a + 1; b < close.length; b++) {
          const q = intersect(this.seg(close[a]), this.seg(close[b]));
          if (q) consider(q, "cross");
        }
    }
    return best;
  }
}

const TIER: Record<SnapKind, number> = { vertex: 0, cross: 1, mid: 2, line: 3 };

function key(cx: number, cy: number): number {
  return cx * 1_000_003 + cy;
}

function closestOnSegment([x1, y1, x2, y2]: [number, number, number, number], [px, py]: Pt): Pt {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return [x1 + t * dx, y1 + t * dy];
}

function intersect(a: [number, number, number, number], b: [number, number, number, number]): Pt | null {
  const [x1, y1, x2, y2] = a;
  const [x3, y3, x4, y4] = b;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}
