// Sladding: alt innhold under de merkede områdene fjernes fra fila for godt,
// og områdene dekkes med svart.
//
// - Tekst fjernes tegn for tegn: tegn som står i et område, byttes ut med en
//   ren forflytning, så resten av linjen står der den stod. Også usynlig tekst
//   (OCR, skjulte lag) fjernes.
// - Bilder får pikslene i området svertet i selve bildet. Bilder vi ikke kan
//   lese, og bilder som ligger helt inne i et område, fjernes.
// - Figurer (streker og flater) som ligger helt inne i et område, fjernes.
// - Kommentarer og skjemafelt som berører et område, fjernes.
// - Skjulte kopier av innholdet fjernes: miniatyrbilder av sidene og
//   Illustrator-data (PieceInfo), og alt som ikke lenger brukes.
//
// «Slett tekst» (`eraseText`) bruker det samme, men fjerner bare tekst og
// dekker ingenting over.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, decodePDFRawStream, rgb } from "pdf-lib";
import { collectGarbage, colorSpace, defaultDecode, filterNames, flateImage, jpegStream, pixels, type ImageCodec } from "./compress.ts";
import type { Pt } from "./measure-math.ts";
import { IDENTITY, applyEdits, apply, fmt, fontInfo, mul, pageContent, parseContent, type FontInfo, type Matrix, type Op } from "./textedit-pdf.ts";

/** Område i PDF-koordinater: [x0, y0, x1, y1] med x0 < x1 og y0 < y1. */
export type Rect = [number, number, number, number];

export interface RedactArea {
  page: number;
  rect: Rect;
}

export interface RedactStats {
  /** Tegn som er fjernet. */
  glyphs: number;
  /** Bilder som er svertet eller fjernet. */
  images: number;
  /** Figurer som er fjernet. */
  paths: number;
  /** Kommentarer og skjemafelt som er fjernet. */
  annotations: number;
}

const N = (s: string) => PDFName.of(s);
type Edit = { start: number; end: number; text: string };

const inside = (p: Pt, r: Rect, tol = 0.01) => p[0] >= r[0] - tol && p[0] <= r[2] + tol && p[1] >= r[1] - tol && p[1] <= r[3] + tol;
const bbox = (pts: Pt[]): Rect => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

const hex = (bytes: number[]) => `<${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}>`;

interface Ctx {
  doc: PDFDocument;
  rects: Rect[];
  stats: RedactStats;
  codec: ImageCodec;
  /** Bare tekst fjernes (bilder, figurer og kommentarer får stå). */
  textOnly: boolean;
}

interface Result {
  edits: Edit[];
  /** Nye ressurser når skjemaer eller bilder måtte kopieres (så bare denne siden endres). */
  resources: PDFDict | null;
}

async function processStream(c: Ctx, data: Uint8Array, resources: PDFDict | undefined, start: Matrix, depth: number): Promise<Result> {
  const ctx = c.doc.context;
  const ops = parseContent(data);
  const edits: Edit[] = [];
  let res = resources;
  let resCopied = false;
  const fonts = res?.lookupMaybe(N("Font"), PDFDict);
  const fontCache = new Map<string, FontInfo | null>();
  const getFont = (name: string) => {
    if (!fontCache.has(name)) {
      const d = fonts?.lookupMaybe(N(name), PDFDict);
      fontCache.set(name, d ? fontInfo(d) : null);
    }
    return fontCache.get(name) ?? null;
  };
  /** Legger et nytt XObject (kopi av skjema/bilde) i ressursene og gir navnet. */
  const addXObject = (base: string, ref: PDFRef): string => {
    if (!resCopied || !res) {
      const copied: PDFDict = res ? res.clone(ctx) : ctx.obj({});
      copied.set(N("XObject"), (copied.lookupMaybe(N("XObject"), PDFDict) ?? ctx.obj({})).clone(ctx));
      res = copied;
      resCopied = true;
    }
    const xs = res.lookupMaybe(N("XObject"), PDFDict)!;
    let k = 1;
    while (xs.has(N(`${base}_s${k}`))) k++;
    xs.set(N(`${base}_s${k}`), ref);
    return `${base}_s${k}`;
  };

  /** XObject-navnene innholdet fortsatt bruker (resten fjernes fra ressursene). */
  const usedX = new Set<string>();
  let ctm = start;
  const stack: Matrix[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let font: FontInfo | null = null;
  let fs = 0;
  let tc = 0;
  let tw = 0;
  let th = 1;
  let tl = 0;
  let rise = 0;
  // Figuren som bygges: byte-posisjon der den starter, punktene, og om den er en klippebane.
  let pathStart: number | null = null;
  let pathPts: Pt[] = [];
  let pathClip = false;

  const nextLine = () => {
    tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
    tm = tlm;
  };

  /** Viser tekst; tegn i et område byttes ut med en forflytning. */
  const show = (op: Op, parts: Array<Uint8Array | number>, prefix: string) => {
    const trm = mul(tm, ctm);
    const out: Array<number[] | number> = [];
    let changed = false;
    let x = 0;
    const pushNum = (n: number) => {
      const last = out[out.length - 1];
      if (typeof last === "number") out[out.length - 1] = last + n;
      else out.push(n);
    };
    const pushGlyph = (bytes: number[]) => {
      const last = out[out.length - 1];
      if (Array.isArray(last)) last.push(...bytes);
      else out.push([...bytes]);
    };
    for (const p of parts) {
      if (typeof p === "number") {
        pushNum(p);
        x += (-p / 1000) * fs * th;
        continue;
      }
      const step = font?.twoByte ? 2 : 1;
      for (let k = 0; k + step - 1 < p.length; k += step) {
        const code = step === 2 ? (p[k] << 8) | p[k + 1] : p[k];
        const w = font ? font.width(code) : 0.5;
        const adv = (w * fs + tc + (step === 1 && code === 32 ? tw : 0)) * th;
        // Midt i tegnet, litt over grunnlinjen.
        const center = apply(trm, x + (w * fs * th) / 2, rise + fs * 0.35);
        if (c.rects.some((r) => inside(center, r))) {
          changed = true;
          c.stats.glyphs++;
          if (fs * th) pushNum((-adv * 1000) / (fs * th));
        } else pushGlyph(Array.from(p.subarray(k, k + step)));
        x += adv;
      }
    }
    if (changed) {
      const arr = out.map((o) => (typeof o === "number" ? fmt(o) : hex(o))).join(" ");
      edits.push({ start: op.start, end: op.end, text: `${prefix}[${arr}] TJ` });
    }
    tm = mul([1, 0, 0, 1, x, 0], tm);
  };

  for (const op of ops) {
    const a = op.args;
    const nums = a.map((t) => (t.t === "num" ? t.v : NaN));
    const pt = (i: number): Pt => apply(ctm, nums[i], nums[i + 1]);
    switch (op.op) {
      case "q":
        stack.push(ctm);
        break;
      case "Q":
        ctm = stack.pop() ?? ctm;
        break;
      case "cm":
        if (nums.length >= 6 && nums.slice(-6).every(Number.isFinite)) ctm = mul(nums.slice(-6) as Matrix, ctm);
        break;
      // Figurer
      case "m":
      case "l":
      case "c":
      case "v":
      case "y":
      case "re":
        if (pathStart === null) {
          pathStart = op.start;
          pathPts = [];
          pathClip = false;
        }
        if (op.op === "re" && nums.length >= 4) {
          const [x0, y0, w, h] = nums;
          pathPts.push(apply(ctm, x0, y0), apply(ctm, x0 + w, y0), apply(ctm, x0 + w, y0 + h), apply(ctm, x0, y0 + h));
        } else for (let i = 0; i + 1 < nums.length; i += 2) if (Number.isFinite(nums[i])) pathPts.push(pt(i));
        break;
      case "h":
        break;
      case "W":
      case "W*":
        pathClip = true;
        break;
      case "S":
      case "s":
      case "f":
      case "F":
      case "f*":
      case "B":
      case "B*":
      case "b":
      case "b*":
      case "n": {
        // En tegnet figur som ligger helt inne i et område, fjernes (ikke klippebaner).
        if (!c.textOnly && pathStart !== null && op.op !== "n" && !pathClip && pathPts.length && c.rects.some((r) => pathPts.every((p) => inside(p, r)))) {
          edits.push({ start: pathStart, end: op.end, text: "" });
          c.stats.paths++;
        }
        pathStart = null;
        pathPts = [];
        pathClip = false;
        break;
      }
      // Tekst
      case "BT":
        tm = tlm = IDENTITY;
        break;
      case "Tf":
        if (a[0]?.t === "name") font = getFont(a[0].v);
        if (Number.isFinite(nums[1])) fs = nums[1];
        break;
      case "Tc":
        if (Number.isFinite(nums[0])) tc = nums[0];
        break;
      case "Tw":
        if (Number.isFinite(nums[0])) tw = nums[0];
        break;
      case "Tz":
        if (Number.isFinite(nums[0])) th = nums[0] / 100;
        break;
      case "TL":
        if (Number.isFinite(nums[0])) tl = nums[0];
        break;
      case "Ts":
        if (Number.isFinite(nums[0])) rise = nums[0];
        break;
      case "Td":
      case "TD":
        if (Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
          if (op.op === "TD") tl = -nums[1];
          tlm = mul([1, 0, 0, 1, nums[0], nums[1]], tlm);
          tm = tlm;
        }
        break;
      case "Tm":
        if (nums.length >= 6 && nums.slice(-6).every(Number.isFinite)) tm = tlm = nums.slice(-6) as Matrix;
        break;
      case "T*":
        nextLine();
        break;
      case "Tj":
        if (a[0]?.t === "str") show(op, [a[0].v], "");
        break;
      case "TJ":
        if (a[0]?.t === "arr") show(op, a[0].v.flatMap((t): Array<Uint8Array | number> => (t.t === "str" ? [t.v] : t.t === "num" ? [t.v] : [])), "");
        break;
      case "'":
        nextLine();
        if (a[0]?.t === "str") show(op, [a[0].v], "T* ");
        break;
      case '"':
        if (Number.isFinite(nums[0])) tw = nums[0];
        if (Number.isFinite(nums[1])) tc = nums[1];
        nextLine();
        if (a[2]?.t === "str") show(op, [a[2].v], `${fmt(tw)} Tw ${fmt(tc)} Tc T* `);
        break;
      // Skjemaer og bilder
      case "Do": {
        if (a[0]?.t !== "name") break;
        const name = a[0].v;
        usedX.add(name);
        const ref = res?.lookupMaybe(N("XObject"), PDFDict)?.get(N(name));
        const xo = ref instanceof PDFRef ? ctx.lookup(ref) : null;
        if (!(xo instanceof PDFRawStream) || !(ref instanceof PDFRef)) break;
        const sub = xo.dict.get(N("Subtype"));
        if (sub === N("Form")) {
          const m = xo.dict.lookupMaybe(N("Matrix"), PDFArray);
          const fm = (m && m.size() === 6 ? m.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0)) : IDENTITY) as Matrix;
          const formCtm = mul(fm, ctm);
          const b = xo.dict.lookupMaybe(N("BBox"), PDFArray)?.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0));
          const box = b && b.length === 4 ? bbox([apply(formCtm, b[0], b[1]), apply(formCtm, b[2], b[1]), apply(formCtm, b[2], b[3]), apply(formCtm, b[0], b[3])]) : null;
          if (box && !c.rects.some((r) => overlaps(box, r))) break;
          if (!c.textOnly && box && c.rects.some((r) => inside([box[0], box[1]], r) && inside([box[2], box[3]], r))) {
            edits.push({ start: op.start, end: op.end, text: "" });
            usedX.delete(name);
            c.stats.paths++;
            break;
          }
          if (depth > 8) break;
          let content: Uint8Array;
          try {
            content = xo.dict.has(N("Filter")) ? decodePDFRawStream(xo).decode() : xo.contents;
          } catch {
            // Uleselig skjema i området: fjern det heller enn å la innholdet stå.
            edits.push({ start: op.start, end: op.end, text: "" });
            usedX.delete(name);
            break;
          }
          const inner = await processStream(c, content, xo.dict.lookupMaybe(N("Resources"), PDFDict) ?? res, formCtm, depth + 1);
          if (!inner.edits.length && !inner.resources) break;
          const dict = xo.dict.clone(ctx);
          for (const k of ["Filter", "DecodeParms", "Length"]) dict.delete(N(k));
          if (inner.resources) dict.set(N("Resources"), inner.resources);
          const copy = ctx.flateStream(applyEdits(content, inner.edits));
          for (const [k, v] of dict.entries()) copy.dict.set(k, v);
          const copyName = addXObject(name, ctx.register(copy));
          edits.push({ start: op.start, end: op.end, text: `/${copyName} Do` });
          usedX.delete(name);
          usedX.add(copyName);
        } else if (sub === N("Image") && !c.textOnly) {
          const quad = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)];
          const box = bbox(quad);
          const hit = c.rects.filter((r) => overlaps(box, r));
          if (!hit.length) break;
          c.stats.images++;
          usedX.delete(name);
          if (hit.some((r) => quad.every((p) => inside(p, r)))) {
            edits.push({ start: op.start, end: op.end, text: "" });
            break;
          }
          const copy = await blackenImage(c, xo, ctm, hit);
          const copyName = copy ? addXObject(name, copy) : null;
          if (copyName) usedX.add(copyName);
          edits.push({ start: op.start, end: op.end, text: copyName ? `/${copyName} Do` : "" });
        }
        break;
      }
    }
  }
  // Bilder og skjemaer som ikke lenger tegnes her, skal ikke henge igjen i
  // ressursene (da ville de fortsatt ligget i fila).
  const xs = res?.lookupMaybe(N("XObject"), PDFDict);
  if (edits.length && xs && xs.keys().some((k) => !usedX.has(k.decodeText()))) {
    if (!resCopied) {
      const copied = res!.clone(ctx);
      copied.set(N("XObject"), xs.clone(ctx));
      res = copied;
      resCopied = true;
    }
    const own = res!.lookupMaybe(N("XObject"), PDFDict)!;
    for (const k of own.keys()) if (!usedX.has(k.decodeText())) own.delete(k);
  }
  return { edits, resources: resCopied ? res! : null };
}

/**
 * Sverter områdene i en kopi av bildet. Null hvis bildet ikke kan leses
 * (da fjernes det i stedet).
 */
async function blackenImage(c: Ctx, img: PDFRawStream, ctm: Matrix, rects: Rect[]): Promise<PDFRef | null> {
  const ctx = c.doc.context;
  const d = img.dict;
  const num = (k: string) => {
    const v = d.lookup(N(k));
    return v instanceof PDFNumber ? v.asNumber() : 0;
  };
  const w = num("Width");
  const h = num("Height");
  const inv = invert(ctm);
  if (!w || !h || !inv || num("BitsPerComponent") !== 8 || d.has(N("Mask")) || d.lookup(N("ImageMask"))?.toString() === "true") return null;
  const cs = colorSpace(ctx, d.lookup(N("ColorSpace")));
  if (!cs || !defaultDecode(d, cs)) return null;
  // Områdene i bildets piksler (bildet dekker enhetskvadratet, med y oppover).
  const regions = rects.map((r) => {
    const uv = [apply(inv, r[0], r[1]), apply(inv, r[2], r[1]), apply(inv, r[2], r[3]), apply(inv, r[0], r[3])];
    const [u0, v0, u1, v1] = bbox(uv);
    return [Math.max(0, Math.floor(u0 * w)), Math.max(0, Math.floor((1 - v1) * h)), Math.min(w, Math.ceil(u1 * w)), Math.min(h, Math.ceil((1 - v0) * h))];
  });
  const paint = (px: Uint8Array | Uint8ClampedArray, ch: number, value: number) => {
    for (const [x0, y0, x1, y1] of regions)
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let k = 0; k < ch; k++) px[(y * w + x) * ch + k] = k === 3 ? 255 : value;
  };
  const filters = filterNames(d);
  try {
    if (filters.length === 1 && filters[0] === "DCTDecode" && cs.kind !== "indexed") {
      const rgba = await c.codec.resize({ jpeg: img.contents, width: w, height: h }, w, h);
      paint(rgba, 4, 0);
      return ctx.register(jpegStream(ctx, d, cs, await c.codec.jpeg(rgba, w, h, 0.9), w, h));
    }
    if (filters.every((f) => f === "FlateDecode" || f === "LZWDecode")) {
      const ch = cs.kind === "indexed" ? 1 : cs.channels;
      const raw = pixels(img, w, h, ch);
      if (!raw) return null;
      const px = new Uint8Array(raw);
      // Fargetabell: bruk den mørkeste fargen i tabellen.
      let value = 0;
      if (cs.kind === "indexed") {
        const arr = d.lookup(N("ColorSpace")) as PDFArray;
        const table = arr.lookup(3);
        const bytes = table instanceof PDFRawStream ? decodePDFRawStream(table).decode() : table instanceof PDFString || table instanceof PDFHexString ? table.asBytes() : null;
        if (!bytes) return null;
        const n = bytes.length >= 3 ? 3 : 1;
        let best = Infinity;
        for (let i = 0; i * n < bytes.length; i++) {
          const sum = bytes[i * n] + (n === 3 ? bytes[i * n + 1] + bytes[i * n + 2] : 0);
          if (sum < best) {
            best = sum;
            value = i;
          }
        }
      }
      paint(px, ch, value);
      return ctx.register(flateImage(ctx, d, px, w, h));
    }
  } catch {
    return null;
  }
  return null;
}

/** Sladder områdene. Returnerer det nye dokumentet og hva som ble fjernet. */
export function redactPdf(bytes: Uint8Array, areas: RedactArea[], codec: ImageCodec): Promise<{ bytes: Uint8Array; stats: RedactStats }> {
  return remove(bytes, areas, codec, false);
}

const noCodec: ImageCodec = {
  resize: () => Promise.reject(new Error("ikke i bruk")),
  jpeg: () => Promise.reject(new Error("ikke i bruk")),
};

/**
 * «Slett tekst»: fjerner tegnene i områdene fra fila, uten å dekke over.
 * Resten av linjen står der den stod.
 */
export function eraseText(bytes: Uint8Array, areas: RedactArea[]): Promise<{ bytes: Uint8Array; stats: RedactStats }> {
  return remove(bytes, areas, noCodec, true);
}

async function remove(bytes: Uint8Array, areas: RedactArea[], codec: ImageCodec, textOnly: boolean): Promise<{ bytes: Uint8Array; stats: RedactStats }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new Error(`Dokumentet er kryptert og kan ikke ${textOnly ? "endres" : "sladdes"}.`);
  const ctx = doc.context;
  const stats: RedactStats = { glyphs: 0, images: 0, paths: 0, annotations: 0 };
  const pages = doc.getPages();
  const removedAnnots = new Set<string>();

  for (const [index, page] of pages.entries()) {
    const rects = areas.filter((a) => a.page === index).map((a) => a.rect);
    if (!rects.length) continue;
    const content = pageContent(page);
    if (!content) throw new Error(`Innholdet på side ${index + 1} kan ikke leses, så ${textOnly ? "teksten kan ikke slettes" : "det kan ikke sladdes trygt"}.`);
    const c: Ctx = { doc, rects, stats, codec, textOnly };
    const r = await processStream(c, content, page.node.Resources(), IDENTITY, 0);
    if (r.resources) page.node.set(N("Resources"), r.resources);
    const edited = applyEdits(content, r.edits);
    const enc = new TextEncoder();
    const wrapped = new Uint8Array(edited.length + 5);
    wrapped.set(enc.encode("q\n"), 0);
    wrapped.set(edited, 2);
    wrapped.set(enc.encode("\nQ\n"), edited.length + 2);
    page.node.set(N("Contents"), ctx.register(ctx.flateStream(wrapped)));
    if (textOnly) continue;

    // Kommentarer og skjemafelt i området.
    const annots = page.node.Annots();
    if (annots) {
      const keep: PDFRef[] = [];
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const a = annots.lookupMaybe(i, PDFDict);
        const box = a?.lookupMaybe(N("Rect"), PDFArray)?.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0));
        const rect: Rect | null = box && box.length === 4 ? [Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.max(box[0], box[2]), Math.max(box[1], box[3])] : null;
        if (rect && rects.some((x) => overlaps(rect, x))) {
          stats.annotations++;
          if (ref instanceof PDFRef) removedAnnots.add(ref.toString());
        } else if (ref instanceof PDFRef) keep.push(ref);
      }
      if (keep.length) page.node.set(N("Annots"), ctx.obj(keep));
      else page.node.delete(N("Annots"));
    }
    // Miniatyrbildet av siden viser innholdet.
    page.node.delete(N("Thumb"));
    for (const r of rects) page.drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color: rgb(0, 0, 0) });
  }

  // Skjemafelt som er fjernet, skal ikke stå igjen i skjemaet.
  const form = doc.catalog.lookupMaybe(N("AcroForm"), PDFDict);
  const fields = form?.lookupMaybe(N("Fields"), PDFArray);
  if (form && fields && removedAnnots.size) {
    const prune = (arr: PDFArray): PDFRef[] =>
      arr.asArray().filter((x): x is PDFRef => {
        if (!(x instanceof PDFRef)) return false;
        if (removedAnnots.has(x.toString())) return false;
        const f = ctx.lookup(x);
        const kids = f instanceof PDFDict ? f.lookupMaybe(N("Kids"), PDFArray) : undefined;
        if (!kids) return true;
        const left = prune(kids);
        (f as PDFDict).set(N("Kids"), ctx.obj(left));
        return left.length > 0;
      });
    form.set(N("Fields"), ctx.obj(prune(fields)));
  }
  // Illustrator o.l. legger en full, redigerbar kopi av innholdet i PieceInfo.
  if (!textOnly) {
    doc.catalog.delete(N("PieceInfo"));
    for (const page of pages) page.node.delete(N("PieceInfo"));
  }
  // Alt som ikke lenger brukes (gamle innholdsstrømmer, bilder, kommentarer) fjernes fra fila.
  collectGarbage(ctx);
  return { bytes: await doc.save(), stats };
}
