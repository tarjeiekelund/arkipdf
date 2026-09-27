// «Reduser filstørrelse»: skalerer ned bilder til oppløsningen de faktisk vises
// i på arket, fjerner duplikater og ubrukte objekter. Vektorgrafikk og tekst
// røres ikke, så tegningene er like skarpe som før.
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
  type PDFObject,
  type PDFContext,
} from "pdf-lib";

export interface CompressOptions {
  /** Største oppløsning bilder beholder, i punkter per tomme på arket. */
  dpi: number;
  /** JPEG-kvalitet (0–1). */
  quality: number;
  /** Komprimer JPEG-er på nytt selv om de ikke skaleres ned (gir mest for skjerm). */
  reencode: boolean;
}

export const PRESETS = {
  screen: { dpi: 150, quality: 0.75, reencode: true },
  print: { dpi: 300, quality: 0.85, reencode: false },
} satisfies Record<string, CompressOptions>;

export type ImageSource =
  | { jpeg: Uint8Array; width: number; height: number }
  | { pixels: Uint8Array; width: number; height: number; channels: 1 | 3 };

/** Bildebehandlingen, byttet ut i testene (nettleseren bruker canvas). */
export interface ImageCodec {
  /** Dekoder og skalerer til w × h. Gir RGBA. */
  resize(src: ImageSource, w: number, h: number): Promise<Uint8ClampedArray>;
  /** Koder RGBA som JPEG. */
  jpeg(rgba: Uint8ClampedArray, w: number, h: number, quality: number): Promise<Uint8Array>;
}

export interface CompressStats {
  before: number;
  after: number;
  /** Bilder som ble mindre. */
  images: number;
  /** Bilder som ikke kunne behandles (f.eks. CMYK eller spesielle formater). */
  skipped: number;
  /** Like objekter som ble slått sammen. */
  duplicates: number;
  /** Ubrukte objekter som ble fjernet. */
  unused: number;
}

const N = (s: string) => PDFName.of(s);

export async function compressPdf(
  bytes: Uint8Array,
  opts: CompressOptions,
  codec: ImageCodec,
  onProgress?: (done: number, total: number) => void,
): Promise<{ bytes: Uint8Array; stats: CompressStats }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new Error("Dokumentet er passordbeskyttet/kryptert og kan ikke komprimeres.");
  const ctx = doc.context;
  const stats: CompressStats = { before: bytes.length, after: 0, images: 0, skipped: 0, duplicates: 0, unused: 0 };

  // Duplikater først, så et bilde som finnes flere ganger bare behandles én gang.
  stats.duplicates = dedupe(ctx);

  const scales = imageScales(doc, opts.dpi);
  const refs = [...scales.keys()];
  for (let i = 0; i < refs.length; i++) {
    onProgress?.(i, refs.length);
    const r = await shrinkImage(ctx, refs[i], scales.get(refs[i])!, opts, codec);
    if (r === "done") stats.images++;
    else if (r === "skipped") stats.skipped++;
  }
  onProgress?.(refs.length, refs.length);

  stats.duplicates += dedupe(ctx);
  compressPlainStreams(ctx);
  stats.unused = collectGarbage(ctx);
  const out = await doc.save({ useObjectStreams: true });
  stats.after = out.length;
  return { bytes: out, stats };
}

// ---------- Hvor store vises bildene? ----------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

/**
 * Skaleringsfaktoren hvert bilde tåler (1 = beholdes), ut fra hvor stort det
 * tegnes på sidene. Et bilde som brukes flere steder, får plass til det
 * største. Bilder som ikke tegnes fra sidenes innhold, er ikke med.
 */
export function imageScales(doc: PDFDocument, dpi: number): Map<PDFRef, number> {
  const ctx = doc.context;
  // PDFRef.of gir samme objekt for samme nummer, så referansene kan brukes som nøkler.
  const need = new Map<PDFRef, number>();
  let budget = 2_000_000; // operatorer, så en patologisk fil ikke henger

  const walk = (content: Uint8Array, resources: PDFDict | undefined, start: Matrix, depth: number) => {
    const xobjects = resources?.lookupMaybe(N("XObject"), PDFDict);
    let ctm = start;
    const stack: Matrix[] = [];
    scanContent(content, (op, args) => {
      if (--budget < 0) return false;
      if (op === "q") stack.push(ctm);
      else if (op === "Q") ctm = stack.pop() ?? ctm;
      else if (op === "cm" && args.length >= 6 && args.slice(-6).every((a) => typeof a === "number")) {
        ctm = mul(args.slice(-6) as Matrix, ctm);
      } else if (op === "Do" && xobjects && typeof args[0] === "string") {
        const ref = xobjects.get(N(args[0]));
        if (!(ref instanceof PDFRef)) return;
        const xo = ctx.lookup(ref);
        if (!(xo instanceof PDFRawStream)) return;
        const sub = xo.dict.get(N("Subtype"));
        if (sub === N("Image")) {
          const w = num(xo.dict, "Width");
          const h = num(xo.dict, "Height");
          if (!w || !h) return;
          // Enhetskvadratet tegnes som et parallellogram; sidene gir størrelsen i punkter.
          const sx = Math.hypot(ctm[0], ctm[1]) / 72 * dpi / w;
          const sy = Math.hypot(ctm[2], ctm[3]) / 72 * dpi / h;
          need.set(ref, Math.max(need.get(ref) ?? 0, sx, sy));
        } else if (sub === N("Form") && depth < 12) {
          const m = xo.dict.lookupMaybe(N("Matrix"), PDFArray);
          const fm = m && m.size() === 6 ? (m.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0)) as Matrix) : IDENTITY;
          const data = decoded(xo);
          if (data) walk(data, xo.dict.lookupMaybe(N("Resources"), PDFDict) ?? resources, mul(fm, ctm), depth + 1);
        }
      }
    });
  };

  for (const page of doc.getPages()) {
    const parts: Uint8Array[] = [];
    const contents = page.node.Contents();
    const list = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    for (const c of list) {
      const s = ctx.lookup(c);
      const d = s instanceof PDFRawStream ? decoded(s) : null;
      if (d) parts.push(d, new Uint8Array([10]));
    }
    walk(concat(parts), page.node.Resources(), IDENTITY, 0);
  }
  return need;
}

function num(dict: PDFDict, key: string): number {
  const v = dict.lookup(N(key));
  return v instanceof PDFNumber ? v.asNumber() : 0;
}

function decoded(s: PDFRawStream): Uint8Array | null {
  try {
    return s.dict.has(N("Filter")) ? decodePDFRawStream(s).decode() : s.contents;
  } catch {
    return null;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}

type Operand = number | string | null;

/**
 * Leser operatorene i en innholdsstrøm. Navn gis som streng (uten /), tall som
 * tall, alt annet som null. Returnerer callbacken false, stopper lesingen.
 */
export function scanContent(data: Uint8Array, onOp: (op: string, args: Operand[]) => boolean | void): void {
  const isWs = (c: number) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
  const isDelim = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  const n = data.length;
  let i = 0;
  let args: Operand[] = [];
  while (i < n) {
    const c = data[i];
    if (isWs(c)) { i++; continue; }
    if (c === 37) { while (i < n && data[i] !== 10 && data[i] !== 13) i++; continue; } // %
    if (c === 40) { // (streng)
      let depth = 0;
      for (; i < n; i++) {
        if (data[i] === 92) i++;
        else if (data[i] === 40) depth++;
        else if (data[i] === 41 && --depth === 0) break;
      }
      i++;
      args.push(null);
      continue;
    }
    if (c === 60) { // <hex> eller <<
      if (data[i + 1] === 60) { i += 2; continue; }
      while (i < n && data[i] !== 62) i++;
      i++;
      args.push(null);
      continue;
    }
    if (c === 62 && data[i + 1] === 62) { i += 2; continue; }
    if (c === 91 || c === 93 || c === 123 || c === 125 || c === 41 || c === 62) { i++; continue; }
    let j = i + 1;
    while (j < n && !isWs(data[j]) && !isDelim(data[j])) j++;
    if (c === 47) { // /Navn
      args.push(String.fromCharCode(...data.subarray(i + 1, j)).replace(/#([0-9a-fA-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))));
      i = j;
      continue;
    }
    const tok = String.fromCharCode(...data.subarray(i, Math.min(j, i + 64)));
    i = j;
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      const v = Number(tok);
      args.push(Number.isFinite(v) ? v : null);
      continue;
    }
    if (tok === "true" || tok === "false" || tok === "null") { args.push(null); continue; }
    if (tok === "ID") {
      // Innebygd bilde: hopp over binærdata fram til EI.
      i++;
      while (i < n - 1 && !(data[i] === 69 && data[i + 1] === 73 && isWs(data[i - 1]) && (i + 2 >= n || isWs(data[i + 2])))) i++;
      i += 2;
      args = [];
      continue;
    }
    if (onOp(tok, args) === false) return;
    args = [];
  }
}

// ---------- Bildene ----------

/** Hvor mye mindre enn original et bilde må bli for å skaleres ned. */
const MIN_SCALE = 0.9;
/** Bilder mindre enn dette lønner seg ikke å røre. */
const MIN_BYTES = 20_000;

type Result = "done" | "kept" | "skipped";

async function shrinkImage(ctx: PDFContext, ref: PDFRef, scale: number, opts: CompressOptions, codec: ImageCodec): Promise<Result> {
  const img = ctx.lookup(ref);
  if (!(img instanceof PDFRawStream) || img.contents.length < MIN_BYTES) return "kept";
  const d = img.dict;
  const w = num(d, "Width");
  const h = num(d, "Height");
  const downscale = scale < MIN_SCALE;
  if (!downscale && !opts.reencode) return "kept";
  const nw = downscale ? Math.max(1, Math.round(w * scale)) : w;
  const nh = downscale ? Math.max(1, Math.round(h * scale)) : h;

  // Masker, dekode-tabeller og uvanlige formater lar vi være.
  if (num(d, "BitsPerComponent") !== 8 || d.has(N("Mask")) || d.lookup(N("ImageMask"))?.toString() === "true") return "skipped";
  const filters = filterNames(d);
  const cs = colorSpace(ctx, d.lookup(N("ColorSpace")));
  if (!cs || !defaultDecode(d, cs)) return "skipped";

  const sm = d.lookup(N("SMask"));
  const smask = sm instanceof PDFRawStream ? sm : undefined;
  if (smask && smask.dict.has(N("Matte"))) return "skipped";

  let replacement: PDFRawStream | null = null;
  try {
    if (filters.length === 1 && filters[0] === "DCTDecode" && cs.kind !== "indexed") {
      if (!downscale && !opts.reencode) return "kept";
      const rgba = await codec.resize({ jpeg: img.contents, width: w, height: h }, nw, nh);
      replacement = jpegStream(ctx, d, cs, await codec.jpeg(rgba, nw, nh, opts.quality), nw, nh);
    } else if (filters.every((f) => f === "FlateDecode" || f === "LZWDecode")) {
      if (!downscale) return "kept";
      const raw = pixels(img, w, h, cs.kind === "indexed" ? 1 : cs.channels);
      if (!raw) return "skipped";
      if (cs.kind === "indexed") {
        // Fargetabell: nærmeste nabo beholder fargene, og bildet forblir tapsfritt.
        replacement = flateImage(ctx, d, nearest(raw, w, h, 1, nw, nh), nw, nh);
      } else if (fewColors(raw, cs.channels)) {
        // Grafikk og strek tåler ikke JPEG-støy; skaler og behold tapsfritt.
        const rgba = await codec.resize({ pixels: raw, width: w, height: h, channels: cs.channels }, nw, nh);
        replacement = flateImage(ctx, d, fromRgba(rgba, cs.channels), nw, nh);
      } else {
        const rgba = await codec.resize({ pixels: raw, width: w, height: h, channels: cs.channels }, nw, nh);
        replacement = jpegStream(ctx, d, cs, await codec.jpeg(rgba, nw, nh, opts.quality), nw, nh);
      }
    } else return "skipped";
  } catch {
    return "skipped";
  }

  if (!replacement || replacement.contents.length > img.contents.length * 0.9) return "kept";
  if (smask && downscale) await shrinkMask(ctx, d, smask, nw, nh, codec);
  ctx.assign(ref, replacement);
  return "done";
}

type ColorInfo = { kind: "rgb" | "gray" | "indexed"; channels: 1 | 3 };

function colorSpace(ctx: PDFContext, cs: PDFObject | undefined): ColorInfo | null {
  if (cs === N("DeviceRGB") || cs === N("CalRGB")) return { kind: "rgb", channels: 3 };
  if (cs === N("DeviceGray") || cs === N("CalGray")) return { kind: "gray", channels: 1 };
  if (cs instanceof PDFArray && cs.size() >= 2) {
    const kind = cs.lookup(0);
    if (kind === N("ICCBased")) {
      const icc = cs.lookup(1);
      const n = icc instanceof PDFRawStream ? num(icc.dict, "N") : 0;
      return n === 3 ? { kind: "rgb", channels: 3 } : n === 1 ? { kind: "gray", channels: 1 } : null;
    }
    if (kind === N("CalRGB")) return { kind: "rgb", channels: 3 };
    if (kind === N("CalGray")) return { kind: "gray", channels: 1 };
    if (kind === N("Indexed")) return colorSpace(ctx, cs.lookup(1)) ? { kind: "indexed", channels: 1 } : null;
  }
  return null;
}

/** Mangler /Decode, eller har den standardverdien (vanlig i eksport fra Adobe)? */
function defaultDecode(d: PDFDict, cs: ColorInfo): boolean {
  const dec = d.lookup(N("Decode"));
  if (dec === undefined) return true;
  if (!(dec instanceof PDFArray)) return false;
  const want = cs.kind === "indexed" ? [0, 255] : Array.from({ length: cs.channels * 2 }, (_, i) => i % 2);
  const got = dec.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : NaN));
  return got.length === want.length && got.every((v, i) => v === want[i]);
}

function filterNames(d: PDFDict): string[] {
  const f = d.lookup(N("Filter"));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : "?"));
  return [];
}

/** Rå pikselverdier for et Flate/LZW-bilde, med PNG-prediktor tatt høyde for. */
function pixels(img: PDFRawStream, w: number, h: number, channels: number): Uint8Array | null {
  const data = decodePDFRawStream(img).decode();
  const parms = img.dict.lookup(N("DecodeParms"));
  const pd = parms instanceof PDFArray ? parms.lookup(parms.size() - 1) : parms;
  const predictor = pd instanceof PDFDict ? num(pd, "Predictor") : 0;
  const row = w * channels;
  if (predictor >= 10) return unpredictPng(data, row, channels, h);
  if (predictor > 1) return null;
  return data.length >= row * h ? data.subarray(0, row * h) : null;
}

export function unpredictPng(data: Uint8Array, row: number, bpp: number, h: number): Uint8Array | null {
  if (data.length < (row + 1) * h) return null;
  const out = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) {
    const type = data[y * (row + 1)];
    const src = y * (row + 1) + 1;
    const o = y * row;
    for (let x = 0; x < row; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[o - row + x] : 0;
      const c = x >= bpp && y > 0 ? out[o - row + x - bpp] : 0;
      let v = data[src + x];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[o + x] = v & 255;
    }
  }
  return out;
}

/** Grafikk (få farger) eller foto? Ser på et utvalg av pikslene. */
function fewColors(px: Uint8Array, channels: number): boolean {
  const n = px.length / channels;
  const step = Math.max(1, Math.floor(n / 20000));
  const seen = new Set<number>();
  for (let i = 0; i < n; i += step) {
    const o = i * channels;
    seen.add(channels === 3 ? (px[o] << 16) | (px[o + 1] << 8) | px[o + 2] : px[o]);
    if (seen.size > 256) return false;
  }
  return true;
}

function nearest(px: Uint8Array, w: number, h: number, ch: number, nw: number, nh: number): Uint8Array {
  const out = new Uint8Array(nw * nh * ch);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / nw));
      for (let c = 0; c < ch; c++) out[(y * nw + x) * ch + c] = px[(sy * w + sx) * ch + c];
    }
  }
  return out;
}

function fromRgba(rgba: Uint8ClampedArray, channels: 1 | 3): Uint8Array {
  const n = rgba.length / 4;
  const out = new Uint8Array(n * channels);
  for (let i = 0; i < n; i++) {
    if (channels === 1) out[i] = rgba[i * 4];
    else {
      out[i * 3] = rgba[i * 4];
      out[i * 3 + 1] = rgba[i * 4 + 1];
      out[i * 3 + 2] = rgba[i * 4 + 2];
    }
  }
  return out;
}

/** Nøklene som beskriver selve bildet og skal følge med over i den nye strømmen. */
const KEEP = ["Type", "Subtype", "SMask", "Intent", "Interpolate", "OC", "Metadata", "StructParent", "ID", "Name", "Alternates", "OPI"];

function copyKeys(from: PDFDict, to: PDFDict, colorSpace: PDFObject | undefined): void {
  for (const k of KEEP) {
    const v = from.get(N(k));
    if (v !== undefined) to.set(N(k), v);
  }
  if (colorSpace) to.set(N("ColorSpace"), colorSpace);
}

function jpegStream(ctx: PDFContext, d: PDFDict, cs: ColorInfo, jpeg: Uint8Array, w: number, h: number): PDFRawStream {
  // Canvas lager alltid RGB-JPEG. Et RGB-bilde beholder fargerommet sitt (f.eks. ICC-profilen).
  const space = cs.kind === "rgb" ? d.get(N("ColorSpace")) : N("DeviceRGB");
  const dict = ctx.obj({ Width: w, Height: h, BitsPerComponent: 8, Filter: "DCTDecode", Length: jpeg.length });
  copyKeys(d, dict, space);
  return PDFRawStream.of(dict, jpeg);
}

function flateImage(ctx: PDFContext, d: PDFDict, px: Uint8Array, w: number, h: number): PDFRawStream {
  const s = ctx.flateStream(px, { Width: w, Height: h, BitsPerComponent: 8 });
  copyKeys(d, s.dict, d.get(N("ColorSpace")));
  return s;
}

/** Skalerer den myke masken (gjennomsiktigheten) ned sammen med bildet. */
async function shrinkMask(ctx: PDFContext, img: PDFDict, mask: PDFRawStream, nw: number, nh: number, codec: ImageCodec): Promise<void> {
  const w = num(mask.dict, "Width");
  const h = num(mask.dict, "Height");
  if (w <= nw && h <= nh) return;
  if (num(mask.dict, "BitsPerComponent") !== 8 || !defaultDecode(mask.dict, { kind: "gray", channels: 1 })) return;
  try {
    const f = filterNames(mask.dict);
    let rgba: Uint8ClampedArray;
    if (f.length === 1 && f[0] === "DCTDecode") rgba = await codec.resize({ jpeg: mask.contents, width: w, height: h }, nw, nh);
    else if (f.every((x) => x === "FlateDecode" || x === "LZWDecode")) {
      const raw = pixels(mask, w, h, 1);
      if (!raw) return;
      rgba = await codec.resize({ pixels: raw, width: w, height: h, channels: 1 }, nw, nh);
    } else return;
    const s = ctx.flateStream(fromRgba(rgba, 1), { Type: "XObject", Subtype: "Image", Width: nw, Height: nh, BitsPerComponent: 8, ColorSpace: "DeviceGray" });
    if (s.contents.length >= mask.contents.length) return;
    // Masken kan være delt med andre bilder; lag en ny i stedet for å endre den.
    img.set(N("SMask"), ctx.register(s));
  } catch {
    // Beholder den opprinnelige masken.
  }
}

// ---------- Tapsfritt: duplikater, ubrukte objekter, ukomprimerte strømmer ----------

/** Typer ordbøker det er trygt å dele mellom sider. */
const SHAREABLE = new Set(["/Font", "/FontDescriptor", "/ExtGState", "/Encoding"]);

/**
 * Slår sammen like strømmer (bilder, fonter, skjemaer) og like fontordbøker.
 * Vanlig i sammenslåtte tegningssett, der hvert ark har sin kopi av logo,
 * tittelfelt og fonter. Gjentas til ingenting endrer seg, siden like fonter
 * først blir like når fontfilene deres er slått sammen.
 */
export function dedupe(ctx: PDFContext): number {
  let total = 0;
  for (let round = 0; round < 6; round++) {
    const canon = new Map<string, PDFRef>();
    const replace = new Map<PDFRef, PDFRef>();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      let key: string | null = null;
      if (obj instanceof PDFRawStream) {
        const type = obj.dict.get(N("Type"))?.toString();
        if (type === "/XRef" || type === "/ObjStm") continue;
        key = `S${obj.dict.toString()}|${obj.contents.length}|${hash(obj.contents)}`;
      } else if (obj instanceof PDFDict && SHAREABLE.has(obj.get(N("Type"))?.toString() ?? "")) {
        key = `D${obj.toString()}`;
      }
      if (key === null) continue;
      const first = canon.get(key);
      if (!first) canon.set(key, ref);
      else if (sameObject(ctx.lookup(first), obj)) replace.set(ref, first);
    }
    if (!replace.size) break;
    total += replace.size;
    rewriteRefs(ctx, replace);
    for (const ref of replace.keys()) ctx.delete(ref);
  }
  return total;
}

function sameObject(a: PDFObject | undefined, b: PDFObject): boolean {
  if (a instanceof PDFRawStream && b instanceof PDFRawStream) {
    if (a.contents.length !== b.contents.length) return false;
    for (let i = 0; i < a.contents.length; i++) if (a.contents[i] !== b.contents[i]) return false;
    return true;
  }
  return !!a && a.toString() === b.toString();
}

function hash(data: Uint8Array): number {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(data.length / 65536));
  for (let i = 0; i < data.length; i += step) h = Math.imul(h ^ data[i], 0x01000193);
  return h >>> 0;
}

function rewriteRefs(ctx: PDFContext, replace: Map<PDFRef, PDFRef>): void {
  const fix = (v: PDFObject | undefined): PDFObject | undefined => (v instanceof PDFRef ? replace.get(v) : undefined);
  const visit = (obj: PDFObject | undefined) => {
    if (obj instanceof PDFRawStream) visit(obj.dict);
    else if (obj instanceof PDFDict) {
      for (const [k, v] of obj.entries()) {
        const r = fix(v);
        if (r) obj.set(k, r);
        else visit(v);
      }
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const r = fix(obj.get(i));
        if (r) obj.set(i, r);
        else visit(obj.get(i));
      }
    }
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj);
  const t = ctx.trailerInfo as Record<string, PDFObject | undefined>;
  for (const k of ["Root", "Info"]) {
    const r = fix(t[k]);
    if (r) t[k] = r;
  }
}

/** Fjerner objekter som ikke kan nås fra dokumentroten (rester etter tidligere redigering). */
export function collectGarbage(ctx: PDFContext): number {
  const seen = new Set<PDFRef>();
  const queue: PDFObject[] = [];
  const t = ctx.trailerInfo as Record<string, PDFObject | undefined>;
  for (const k of ["Root", "Info"]) if (t[k]) queue.push(t[k]!);
  while (queue.length) {
    const obj = queue.pop()!;
    if (obj instanceof PDFRef) {
      if (seen.has(obj)) continue;
      seen.add(obj);
      const v = ctx.lookup(obj);
      if (v) queue.push(v);
    } else if (obj instanceof PDFRawStream) queue.push(obj.dict);
    else if (obj instanceof PDFDict) for (const [, v] of obj.entries()) queue.push(v);
    else if (obj instanceof PDFArray) queue.push(...obj.asArray());
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref)) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}

/** Flate-komprimerer strømmer som er lagret ukomprimert. */
function compressPlainStreams(ctx: PDFContext): void {
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.has(N("Filter")) || obj.contents.length < 1024) continue;
    // Metadata (XMP) skal kunne leses uten dekoding.
    if (obj.dict.get(N("Type")) === N("Metadata")) continue;
    const s = ctx.flateStream(obj.contents);
    for (const [k, v] of obj.dict.entries()) if (k !== N("Length")) s.dict.set(k, v);
    if (s.contents.length < obj.contents.length * 0.9) ctx.assign(ref, s);
  }
}

// ---------- Bildebehandling i nettleseren ----------

export const browserCodec: ImageCodec = {
  async resize(src, w, h) {
    let bitmap: ImageBitmap;
    const opts: ImageBitmapOptions = { resizeWidth: w, resizeHeight: h, resizeQuality: "high", colorSpaceConversion: "none", premultiplyAlpha: "none" };
    if ("jpeg" in src) {
      bitmap = await createImageBitmap(new Blob([src.jpeg as BlobPart], { type: "image/jpeg" }), opts);
    } else {
      const n = src.width * src.height;
      const rgba = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) {
        const o = i * src.channels;
        rgba[i * 4] = src.pixels[o];
        rgba[i * 4 + 1] = src.pixels[src.channels === 3 ? o + 1 : o];
        rgba[i * 4 + 2] = src.pixels[src.channels === 3 ? o + 2 : o];
        rgba[i * 4 + 3] = 255;
      }
      bitmap = await createImageBitmap(new ImageData(rgba, src.width, src.height), opts);
    }
    const canvas = new OffscreenCanvas(w, h);
    const c = canvas.getContext("2d", { willReadFrequently: true })!;
    c.drawImage(bitmap, 0, 0);
    bitmap.close();
    return c.getImageData(0, 0, w, h).data;
  },
  async jpeg(rgba, w, h, quality) {
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    return new Uint8Array(await blob.arrayBuffer());
  },
};
