// Lagring av mål i PDF-fila, og innlesing igjen.
//
// Målene skrives som vanlige PDF-målekommentarer (Line/PolyLine/Polygon med
// «Measure»), slik Acrobat og Bluebeam også gjør, med ferdig tegnet utseende
// og tall. De legges i et eget lag, «Mål (ArkiPDF)», så de kan slås av og på i
// andre programmer. ArkiPDF skjuler selve laget i sin visning og tegner målene
// som redigerbare i stedet; dataene leses fra en egen «BladMeasure»-nøkkel
// (navnet er fra da appen het Blad, og beholdes så eldre filer kan leses).
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  StandardFonts,
  beginText,
  closePath,
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
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  showText,
  stroke,
  type PDFFont,
  type PDFOperator,
} from "pdf-lib";
import { centroid, distance, pathLength, readPdfScales, type PdfScaleRegion, type Pt } from "./measure-math.ts";

export const LAYER_NAME = "Mål (ArkiPDF)";
/** Laget het dette før appen fikk navnet ArkiPDF. */
const OLD_LAYER_NAMES = ["Mål (Blad)"];

/** Om et lag i PDF-en er laget med våre mål (også fra tidligere versjoner). */
export function isMeasureLayer(name: string | null | undefined): boolean {
  return name === LAYER_NAME || OLD_LAYER_NAMES.includes(name ?? "");
}
const KEY = "BladMeasure";
const COLOR: [number, number, number] = [0.851, 0.282, 0.059];

export type Kind = "distance" | "length" | "area";

export interface ScaleData {
  metersPerPoint: number;
  label: string;
}

export interface StoredMeasurement {
  page: number;
  kind: Kind;
  points: Pt[];
  fixed: ScaleData | null;
}

export interface MeasureFileData {
  scales: Map<number, PdfScaleRegion[]>;
  measurements: StoredMeasurement[];
  pageScales: Map<number, ScaleData>;
  defaultScale: ScaleData | null;
}

/** Et mål som skal skrives, med ferdig formaterte etiketter. */
export interface WritableMeasurement extends StoredMeasurement {
  /** Målestokken som gjaldt da målet ble lagret (for «Measure»-oppføringen). */
  metersPerPoint: number | null;
  scaleLabel: string | null;
  text: string;
  subText?: string;
}

export function textOf(obj: unknown): string | null {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return null;
}

function isBladAnnot(dict: PDFDict | undefined): boolean {
  return !!dict && dict.has(PDFName.of(KEY));
}

/** Leser innebygd målestokk, lagrede mål og målestokkvalg. */
export async function readMeasureData(bytes: Uint8Array): Promise<MeasureFileData> {
  const scales = await readPdfScales(bytes);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const measurements: StoredMeasurement[] = [];
  doc.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict);
      const raw = textOf(dict?.lookup(PDFName.of(KEY)));
      if (!raw) continue;
      try {
        const d = JSON.parse(raw);
        if (!["distance", "length", "area"].includes(d.kind) || !Array.isArray(d.points)) continue;
        const points = (d.points as unknown[]).filter((p): p is Pt => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
        if (points.length < 2) continue;
        measurements.push({ page: index, kind: d.kind, points, fixed: validScale(d.fixed) });
      } catch {
        /* Ødelagt oppføring hoppes over. */
      }
    }
  });

  const pageScales = new Map<number, ScaleData>();
  let defaultScale: ScaleData | null = null;
  const settings = textOf(doc.catalog.lookup(PDFName.of(KEY)));
  if (settings) {
    try {
      const s = JSON.parse(settings);
      for (const [page, scale] of Array.isArray(s.pageScales) ? s.pageScales : []) {
        const v = validScale(scale);
        if (v && Number.isInteger(page)) pageScales.set(page, v);
      }
      defaultScale = validScale(s.defaultScale);
    } catch {
      /* ignorer */
    }
  }
  return { scales, measurements, pageScales, defaultScale };
}

function validScale(s: unknown): ScaleData | null {
  const v = s as ScaleData | null;
  return v && typeof v.metersPerPoint === "number" && v.metersPerPoint > 0 && typeof v.label === "string" ? { metersPerPoint: v.metersPerPoint, label: v.label } : null;
}

/** Skriver målene inn i PDF-en (erstatter mål som er lagret tidligere). */
export async function writeMeasurements(
  bytes: Uint8Array,
  items: WritableMeasurement[],
  pageScales: Map<number, ScaleData>,
  defaultScale: ScaleData | null,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new Error("Fila er kryptert og kan ikke endres.");
  const ctx = doc.context;
  const pages = doc.getPages();

  // Fjern mål som er lagret tidligere (og utseendet deres) før de nye legges inn.
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep: Array<PDFRef | PDFDict> = [];
    let removed = false;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = annots.lookupMaybe(i, PDFDict);
      if (!isBladAnnot(dict)) {
        keep.push(raw as PDFRef);
        continue;
      }
      removed = true;
      const ap = dict!.lookupMaybe(PDFName.of("AP"), PDFDict)?.get(PDFName.of("N"));
      if (ap instanceof PDFRef) ctx.delete(ap);
      if (raw instanceof PDFRef) ctx.delete(raw);
    }
    if (removed) {
      if (keep.length) page.node.set(PDFName.of("Annots"), ctx.obj(keep));
      else page.node.delete(PDFName.of("Annots"));
    }
  }

  const layer = items.length ? ensureLayer(doc, LAYER_NAME, isMeasureLayer) : null;
  const font = items.length ? await doc.embedFont(StandardFonts.Helvetica) : null;

  items.forEach((m, n) => {
    const page = pages[m.page];
    if (!page || !layer || !font) return;
    const { width, height } = page.getSize();
    const size = Math.max(7, Math.min(20, Math.hypot(width, height) / 220));
    const ap = appearance(m, font, size);
    const [x1, y1, x2, y2] = ap.bbox;
    const stream = ctx.formXObject(ap.ops, {
      BBox: [x1, y1, x2, y2],
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: { Font: { Helv: font.ref }, ExtGState: { GSa: { Type: "ExtGState", ca: 0.14 } } },
    });
    const apRef = ctx.register(stream);
    const subtype = m.kind === "distance" ? "Line" : m.kind === "length" ? "PolyLine" : "Polygon";
    const flat = m.points.flat();
    const dict: Record<string, unknown> = {
      Type: "Annot",
      Subtype: subtype,
      Rect: [x1, y1, x2, y2],
      Contents: PDFHexString.fromText(m.subText ? `${m.text} (${m.subText})` : m.text),
      NM: PDFString.of(`arkipdf-mal-${Date.now().toString(36)}-${n}`),
      T: PDFHexString.fromText("ArkiPDF"),
      F: 4,
      C: COLOR,
      BS: { W: 1.5, S: "S" },
      IT: m.kind === "distance" ? "LineDimension" : m.kind === "length" ? "PolyLineDimension" : "PolygonDimension",
      OC: layer,
      AP: { N: apRef },
      [KEY]: PDFHexString.fromText(JSON.stringify({ v: 1, kind: m.kind, points: m.points, fixed: m.fixed })),
    };
    if (m.kind === "distance") dict.L = flat;
    else dict.Vertices = flat;
    if (m.metersPerPoint) {
      dict.Measure = {
        Type: "Measure",
        Subtype: "RL",
        R: PDFHexString.fromText(m.scaleLabel ?? ""),
        X: [{ Type: "NumberFormat", U: PDFString.of("m"), C: m.metersPerPoint, D: 100 }],
        D: [{ Type: "NumberFormat", U: PDFString.of("m"), C: 1, D: 100 }],
        A: [{ Type: "NumberFormat", U: PDFString.of("m2"), C: 1, D: 100 }],
      };
    }
    page.node.addAnnot(ctx.register(ctx.obj(dict as never)));
  });

  // Målestokkvalg per side, så de er på plass neste gang fila åpnes.
  const settings = { v: 1, pageScales: [...pageScales], defaultScale };
  doc.catalog.set(PDFName.of(KEY), PDFHexString.fromText(JSON.stringify(settings)));
  return doc.save();
}

/**
 * Finner eller lager et lag (f.eks. «Mål (ArkiPDF)») og returnerer referansen.
 * Et lag som `isOurs` kjenner igjen under et gammelt navn, får det nye.
 */
export function ensureLayer(doc: PDFDocument, name: string, isOurs: (name: string | null) => boolean): PDFRef {
  const ctx = doc.context;
  let props = doc.catalog.lookupMaybe(PDFName.of("OCProperties"), PDFDict);
  if (!props) {
    props = ctx.obj({ OCGs: [], D: { Name: PDFString.of("Standard"), Order: [], ON: [] } }) as PDFDict;
    doc.catalog.set(PDFName.of("OCProperties"), props);
  }
  let ocgs = props.lookupMaybe(PDFName.of("OCGs"), PDFArray);
  if (!ocgs) {
    ocgs = ctx.obj([]) as PDFArray;
    props.set(PDFName.of("OCGs"), ocgs);
  }
  for (let i = 0; i < ocgs.size(); i++) {
    const ref = ocgs.get(i);
    const g = ocgs.lookupMaybe(i, PDFDict);
    if (ref instanceof PDFRef && g && isOurs(textOf(g.lookup(PDFName.of("Name"))))) {
      g.set(PDFName.of("Name"), PDFHexString.fromText(name));
      return ref;
    }
  }
  const ref = ctx.register(ctx.obj({ Type: "OCG", Name: PDFHexString.fromText(name) }));
  ocgs.push(ref);
  let d = props.lookupMaybe(PDFName.of("D"), PDFDict);
  if (!d) {
    d = ctx.obj({ Order: [], ON: [] }) as PDFDict;
    props.set(PDFName.of("D"), d);
  }
  for (const k of ["Order", "ON"]) {
    let arr = d.lookupMaybe(PDFName.of(k), PDFArray);
    if (!arr) {
      arr = ctx.obj([]) as PDFArray;
      d.set(PDFName.of(k), arr);
    }
    arr.push(ref);
  }
  return ref;
}

/** Tegner linjer, flate og etikett som PDF-operatorer (sidens koordinater). */
function appearance(m: WritableMeasurement, font: PDFFont, size: number): { ops: PDFOperator[]; bbox: [number, number, number, number] } {
  const pts = m.points;
  const ops: PDFOperator[] = [pushGraphicsState(), setLineJoin(1)];
  const path = () => {
    ops.push(moveTo(pts[0][0], pts[0][1]));
    for (let i = 1; i < pts.length; i++) ops.push(lineTo(pts[i][0], pts[i][1]));
    if (m.kind === "area") ops.push(closePath());
  };
  if (m.kind === "area") {
    ops.push(pushGraphicsState(), setGraphicsState("GSa"), setFillingRgbColor(...COLOR));
    path();
    ops.push(fill(), popGraphicsState());
  }
  ops.push(setStrokingRgbColor(...COLOR), setLineWidth(Math.max(0.75, size / 10)));
  path();
  ops.push(stroke());

  // Etikett: hvit boks med kant, verdien og eventuelt omkrets under.
  const at = m.kind === "area" ? centroid(pts) : midpointOf(pts);
  const small = size * 0.8;
  const w1 = font.widthOfTextAtSize(m.text, size);
  const w2 = m.subText ? font.widthOfTextAtSize(m.subText, small) : 0;
  const pad = size * 0.35;
  const bw = Math.max(w1, w2) + pad * 2;
  const bh = size * 1.2 + (m.subText ? small * 1.2 : 0) + pad;
  const bx = at[0] - bw / 2;
  const by = at[1] - bh / 2;
  ops.push(setFillingRgbColor(1, 1, 1), rectangle(bx, by, bw, bh), fill());
  ops.push(setStrokingRgbColor(...COLOR), setLineWidth(size / 14), rectangle(bx, by, bw, bh), stroke());
  ops.push(setFillingRgbColor(0.1, 0.12, 0.12), beginText(), setFontAndSize("Helv", size));
  ops.push(moveText(at[0] - w1 / 2, by + bh - pad / 2 - size), showText(font.encodeText(m.text)), endText());
  if (m.subText) {
    ops.push(setFillingRgbColor(0.36, 0.4, 0.39), beginText(), setFontAndSize("Helv", small));
    ops.push(moveText(at[0] - w2 / 2, by + pad / 2 + small * 0.25), showText(font.encodeText(m.subText)), endText());
  }
  ops.push(popGraphicsState());

  const xs = [...pts.map((p) => p[0]), bx, bx + bw];
  const ys = [...pts.map((p) => p[1]), by, by + bh];
  const margin = size / 4 + 2;
  return { ops, bbox: [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin] };
}

function midpointOf(points: Pt[]): Pt {
  const total = pathLength(points);
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = distance(points[i - 1], points[i]);
    if (acc + seg >= total / 2) {
      const t = seg ? (total / 2 - acc) / seg : 0;
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
    }
    acc += seg;
  }
  return points[0];
}
