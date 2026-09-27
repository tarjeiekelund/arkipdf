// Redigering av tekst i PDF-en: en tekstlinje byttes ut med ny tekst.
//
// En PDF har ingen «tekst å redigere», bare kommandoer som tegner bokstaver på
// bestemte steder. Vi leser derfor sidens innhold (også skjemaer/XObjects som
// tittelfelt ofte ligger i) med full oversikt over tekstposisjonen, finner
// kommandoene som tegner den valgte linjen, og bytter dem ut med en ren
// forflytning like lang som teksten var. Da forsvinner den gamle teksten helt
// fra fila, mens tekst som kommer etter i samme kommando-blokk blir stående der
// den var. Den nye teksten tegnes på samme sted, i samme størrelse, farge og
// retning, med samme font når den finnes i Windows.
import fontkit from "@pdf-lib/fontkit";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { collectGarbage } from "./compress.ts";
import type { Pt } from "./measure-math.ts";

/** En tekstlinje slik pdf.js fant den (PDF-koordinater, uten sidens /Rotate). */
export interface TextLine {
  page: number;
  text: string;
  /** Grunnlinjens startpunkt. */
  origin: Pt;
  /** Retningen teksten går (enhetsvektor). */
  dir: Pt;
  /** Lengden langs grunnlinjen. */
  length: number;
  /** Skriftstørrelse (punkter). */
  size: number;
}

export interface EditResult {
  bytes: Uint8Array;
  /** Antall tegnekommandoer som ble fjernet (0: den gamle teksten ble dekket over). */
  removed: number;
  /** Fonten den nye teksten ble skrevet med. */
  font: string;
  /** Fonten i PDF-en (uten delsett-prefiks), f.eks. «Arial-BoldMT». */
  originalFont: string | null;
}

/** Finner fontfila for en PDF-font (f.eks. i Windows); null gir Helvetica/Arial. */
export type FontLoader = (baseFont: string) => Promise<Uint8Array | null>;

const N = (s: string) => PDFName.of(s);
export type Matrix = [number, number, number, number, number, number];
export const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
export const apply = (m: Matrix, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// ---------- Innholdsstrømmer med posisjoner ----------

export type Tok =
  | { t: "num"; v: number; s: number; e: number }
  | { t: "name"; v: string; s: number; e: number }
  | { t: "str"; v: Uint8Array; s: number; e: number }
  | { t: "arr"; v: Tok[]; s: number; e: number }
  | { t: "other"; s: number; e: number };

export interface Op {
  op: string;
  args: Tok[];
  /** Fra første operand til slutten av operatoren. */
  start: number;
  end: number;
}

const isWs = (c: number) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

/** Deler en innholdsstrøm i operatorer med operander og byte-posisjoner. */
export function parseContent(data: Uint8Array): Op[] {
  const ops: Op[] = [];
  let i = 0;
  const n = data.length;
  const skipWs = () => {
    while (i < n) {
      if (isWs(data[i])) i++;
      else if (data[i] === 37) while (i < n && data[i] !== 10 && data[i] !== 13) i++;
      else break;
    }
  };
  const readString = (): Uint8Array => {
    const out: number[] = [];
    let depth = 1;
    i++;
    while (i < n) {
      const c = data[i++];
      if (c === 92) {
        const d = data[i++];
        if (d === 110) out.push(10);
        else if (d === 114) out.push(13);
        else if (d === 116) out.push(9);
        else if (d === 98) out.push(8);
        else if (d === 102) out.push(12);
        else if (d === 13) {
          if (data[i] === 10) i++;
        } else if (d === 10) {
          /* linjeskift fortsetter strengen */
        } else if (d >= 48 && d <= 55) {
          let v = d - 48;
          for (let k = 0; k < 2 && data[i] >= 48 && data[i] <= 55; k++) v = v * 8 + (data[i++] - 48);
          out.push(v & 255);
        } else out.push(d);
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return new Uint8Array(out);
  };
  const readHex = (): Uint8Array => {
    i++;
    let hex = "";
    while (i < n && data[i] !== 62) {
      if (!isWs(data[i])) hex += String.fromCharCode(data[i]);
      i++;
    }
    i++;
    if (hex.length % 2) hex += "0";
    const out = new Uint8Array(hex.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16) || 0;
    return out;
  };
  const readToken = (): Tok | { t: "op"; v: string; s: number; e: number } | null => {
    skipWs();
    if (i >= n) return null;
    const s = i;
    const c = data[i];
    if (c === 40) {
      const v = readString();
      return { t: "str", v, s, e: i };
    }
    if (c === 60 && data[i + 1] === 60) {
      // Ordbok (f.eks. i BDC): hopp over til matchende >>.
      let depth = 0;
      while (i < n) {
        if (data[i] === 60 && data[i + 1] === 60) {
          depth++;
          i += 2;
        } else if (data[i] === 62 && data[i + 1] === 62) {
          i += 2;
          if (--depth === 0) break;
        } else if (data[i] === 40) readString();
        else i++;
      }
      return { t: "other", s, e: i };
    }
    if (c === 60) {
      const v = readHex();
      return { t: "str", v, s, e: i };
    }
    if (c === 91) {
      i++;
      const items: Tok[] = [];
      for (;;) {
        skipWs();
        if (i >= n) break;
        if (data[i] === 93) {
          i++;
          break;
        }
        const t = readToken();
        if (!t) break;
        if (t.t !== "op") items.push(t);
      }
      return { t: "arr", v: items, s, e: i };
    }
    if (c === 47) {
      i++;
      while (i < n && !isWs(data[i]) && !isDelim(data[i])) i++;
      return { t: "name", v: String.fromCharCode(...data.subarray(s + 1, i)).replace(/#([0-9a-fA-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))), s, e: i };
    }
    if (c === 41 || c === 62 || c === 93 || c === 123 || c === 125) {
      i++;
      return { t: "other", s, e: i };
    }
    while (i < n && !isWs(data[i]) && !isDelim(data[i])) i++;
    if (i === s) i++;
    const word = String.fromCharCode(...data.subarray(s, Math.min(i, s + 64)));
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      const v = Number(word);
      if (Number.isFinite(v)) return { t: "num", v, s, e: i };
    }
    if (word === "true" || word === "false" || word === "null") return { t: "other", s, e: i };
    return { t: "op", v: word, s, e: i };
  };

  let args: Tok[] = [];
  while (i < n) {
    const t = readToken();
    if (!t) break;
    if (t.t !== "op") {
      args.push(t);
      continue;
    }
    if (t.v === "BI") {
      // Innebygd bilde: hopp til EI.
      while (i < n - 1 && !(data[i] === 69 && data[i + 1] === 73 && isWs(data[i - 1]) && (i + 2 >= n || isWs(data[i + 2])))) i++;
      i += 2;
      args = [];
      continue;
    }
    ops.push({ op: t.v, args, start: args.length ? args[0].s : t.s, end: t.e });
    args = [];
  }
  return ops;
}

// ---------- Fonter og tekstbredde ----------

export interface FontInfo {
  baseFont: string;
  twoByte: boolean;
  /** Bredde i tekstrom-enheter (1 = skriftstørrelsen) for en kode. */
  width: (code: number) => number;
}

function num(v: unknown): number {
  return v instanceof PDFNumber ? v.asNumber() : 0;
}

export function fontInfo(dict: PDFDict): FontInfo {
  const sub = dict.get(N("Subtype"))?.toString();
  const baseFont = (dict.lookup(N("BaseFont")) as PDFName | undefined)?.decodeText?.() ?? "";
  if (sub === "/Type0") {
    const desc = dict.lookupMaybe(N("DescendantFonts"), PDFArray)?.lookupMaybe(0, PDFDict);
    const dw = desc?.has(N("DW")) ? num(desc.lookup(N("DW"))) : 1000;
    const widths = new Map<number, number>();
    const w = desc?.lookupMaybe(N("W"), PDFArray);
    if (w) {
      const a = w.asArray().map((x) => dict.context.lookup(x));
      for (let k = 0; k < a.length; ) {
        const first = num(a[k]);
        const next = a[k + 1];
        if (next instanceof PDFArray) {
          next.asArray().forEach((x, j) => widths.set(first + j, num(dict.context.lookup(x))));
          k += 2;
        } else {
          const last = num(next);
          const width = num(a[k + 2]);
          for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, width);
          k += 3;
        }
      }
    }
    return { baseFont: (desc?.lookup(N("BaseFont")) as PDFName | undefined)?.decodeText?.() ?? baseFont, twoByte: true, width: (c) => (widths.get(c) ?? dw) / 1000 };
  }
  const first = num(dict.lookup(N("FirstChar")));
  const widths = dict.lookupMaybe(N("Widths"), PDFArray)?.asArray().map((x) => num(dict.context.lookup(x))) ?? [];
  const missing = num(dict.lookupMaybe(N("FontDescriptor"), PDFDict)?.lookup(N("MissingWidth")));
  // Type3 måles i sitt eget glyfrom (FontMatrix), andre fonter i tusendeler.
  const fm = dict.lookupMaybe(N("FontMatrix"), PDFArray);
  const scale = sub === "/Type3" && fm ? num(fm.lookup(0)) : 0.001;
  const fallback = widths.length ? missing : 550; // Standardfonter uten /Widths: omtrent en halv em.
  return { baseFont, twoByte: false, width: (c) => (widths[c - first] ?? fallback) * scale };
}

// ---------- Tolking ----------

interface State {
  ctm: Matrix;
  fill: [number, number, number];
}

interface Found {
  /** Startpunkt og retning (x-akse) for teksten slik den tegnes, og skriftstørrelse. */
  at: Pt;
  angle: number;
  size: number;
  color: [number, number, number];
  font: string;
  white: boolean;
}

/** En tekstkommando slik den tegnes: start- og sluttpunkt på grunnlinjen. */
export interface Run {
  a: Pt;
  b: Pt;
  size: number;
  /** Usynlig: i et avslått lag, eller tegnemodus «usynlig» (f.eks. OCR-tekst). */
  hidden: boolean;
  color: [number, number, number];
}

/** Det som følger med gjennom tolkingen av en side og skjemaene på den. */
interface Walk {
  doc: PDFDocument;
  /** Linjen som skal byttes ut (null: bare les tekstkommandoene). */
  line: TextLine | null;
  found: { first: Found | null };
  runs: Run[] | null;
  hiddenGroups: Set<string>;
}

/** Om tekst fra a til b ligger på linjen. */
export function onLine(line: TextLine, a: Pt, b: Pt): boolean {
  const nrm: Pt = [-line.dir[1], line.dir[0]];
  const tol = line.size * 0.5;
  const rel = (p: Pt) => [(p[0] - line.origin[0]) * line.dir[0] + (p[1] - line.origin[1]) * line.dir[1], (p[0] - line.origin[0]) * nrm[0] + (p[1] - line.origin[1]) * nrm[1]];
  const [ua, va] = rel(a);
  const [ub, vb] = rel(b);
  if (Math.abs(va) > tol || Math.abs(vb) > tol) return false;
  const lo = Math.min(ua, ub);
  const hi = Math.max(ua, ub);
  const mid = (lo + hi) / 2;
  return mid >= -tol && mid <= line.length + tol && lo >= -line.size * 1.5 && hi <= line.length + line.size * 1.5;
}

/** Lagene (OCG) som er slått av i dokumentets standardvisning. */
export function hiddenGroups(doc: PDFDocument): Set<string> {
  const out = new Set<string>();
  const props = doc.catalog.lookupMaybe(N("OCProperties"), PDFDict);
  const d = props?.lookupMaybe(N("D"), PDFDict);
  if (!props || !d) return out;
  const refs = (arr: PDFArray | undefined) => (arr?.asArray() ?? []).filter((x): x is PDFRef => x instanceof PDFRef).map((r) => r.toString());
  if (d.get(N("BaseState")) === N("OFF")) {
    const on = new Set(refs(d.lookupMaybe(N("ON"), PDFArray)));
    for (const r of refs(props.lookupMaybe(N("OCGs"), PDFArray))) if (!on.has(r)) out.add(r);
  } else for (const r of refs(d.lookupMaybe(N("OFF"), PDFArray))) out.add(r);
  return out;
}

/** Om et lag (OCG) eller en lagregel (OCMD) er synlig. */
export function groupVisible(ctx: PDFDocument["context"], obj: unknown, hidden: Set<string>): boolean {
  if (!(obj instanceof PDFRef)) return true;
  const d = ctx.lookup(obj);
  if (!(d instanceof PDFDict)) return true;
  if (d.get(N("Type")) !== N("OCMD")) return !hidden.has(obj.toString());
  const ocgs = d.get(N("OCGs"));
  const list = (ctx.lookup(ocgs) instanceof PDFArray ? (ctx.lookup(ocgs) as PDFArray).asArray() : [ocgs]).filter((x): x is PDFRef => x instanceof PDFRef);
  const vis = list.map((r) => !hidden.has(r.toString()));
  const policy = d.get(N("P"))?.toString() ?? "/AnyOn";
  if (!vis.length) return true;
  if (policy === "/AllOn") return vis.every(Boolean);
  if (policy === "/AnyOff") return vis.some((v) => !v);
  if (policy === "/AllOff") return vis.every((v) => !v);
  return vis.some(Boolean);
}

interface StreamResult {
  edits: Array<{ start: number; end: number; text: string }>;
  removed: number;
  /** Nye ressurser når et XObject måtte kopieres (så bare denne siden endres). */
  resources: PDFDict | null;
}

export function toRgb(args: Tok[]): [number, number, number] | null {
  const v = args.filter((a) => a.t === "num").map((a) => (a as { v: number }).v);
  if (v.length === 1) return [v[0], v[0], v[0]];
  if (v.length === 3) return [v[0], v[1], v[2]];
  if (v.length === 4) return [(1 - v[0]) * (1 - v[3]), (1 - v[1]) * (1 - v[3]), (1 - v[2]) * (1 - v[3])];
  return null;
}

/** Skriver et tall kompakt for innholdsstrømmen. */
export const fmt = (x: number) => (Math.abs(x) < 1e-6 ? "0" : String(Math.round(x * 1000) / 1000));

function processStream(data: Uint8Array, resources: PDFDict | undefined, start: State, hiddenStart: boolean, w: Walk, depth: number): StreamResult {
  const { doc, line, found } = w;
  const ctx = doc.context;
  const ops = parseContent(data);
  const edits: StreamResult["edits"] = [];
  let removed = 0;
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

  let gs: State = { ctm: start.ctm, fill: start.fill };
  const stack: State[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let font: FontInfo | null = null;
  let fs = 0;
  let tc = 0;
  let tw = 0;
  let th = 1;
  let tl = 0;
  let rise = 0;
  let tr = 0;
  const oc: boolean[] = [];
  const isHidden = () => hiddenStart || tr === 3 || tr === 7 || oc.some(Boolean);
  const properties = res?.lookupMaybe(N("Properties"), PDFDict);

  /** Hvor langt en streng flytter tekstposisjonen (tekstrom-enheter). */
  const advance = (s: Uint8Array): number => {
    if (!font) return 0;
    let tx = 0;
    if (font.twoByte) {
      for (let k = 0; k + 1 < s.length; k += 2) tx += (font.width((s[k] << 8) | s[k + 1]) * fs + tc) * th;
    } else {
      for (const c of s) tx += (font.width(c) * fs + tc + (c === 32 ? tw : 0)) * th;
    }
    return tx;
  };

  const show = (op: Op, parts: Array<Uint8Array | number>, prefix: string) => {
    const trm = mul(tm, gs.ctm);
    let tx = 0;
    for (const p of parts) tx += typeof p === "number" ? (-p / 1000) * fs * th : advance(p);
    const a = apply(trm, 0, rise);
    const b = apply(trm, tx, rise);
    const hasText = parts.some((p) => typeof p !== "number" && p.length);
    const hidden = isHidden();
    const sy = Math.hypot(trm[2], trm[3]);
    if (hasText && w.runs) w.runs.push({ a, b, size: fs * sy, hidden, color: gs.fill });
    // Skjult tekst (avslåtte lag, OCR-tekst) røres ikke.
    if (hasText && line && !hidden && onLine(line, a, b)) {
      // Stilen hentes fra første tekst på linjen, men hvit tekst (ofte skjult
      // under annen tekst, fra maler) viker for synlig tekst.
      const white = Math.min(...gs.fill) > 0.94;
      if (!found.first || (found.first.white && !white)) {
        found.first = { at: a, angle: (Math.atan2(trm[1], trm[0]) * 180) / Math.PI, size: fs * sy, color: gs.fill, font: font?.baseFont ?? "", white };
      }
      // Bytt ut med en ren forflytning like lang som teksten: da står
      // etterfølgende tekst i samme blokk der den var.
      const move = fs * th ? `[${fmt((-tx * 1000) / (fs * th))}] TJ` : "";
      edits.push({ start: op.start, end: op.end, text: `${prefix}${move}` });
      removed++;
    }
    tm = mul([1, 0, 0, 1, tx, 0], tm);
  };
  const nextLine = () => {
    tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
    tm = tlm;
  };

  for (const op of ops) {
    const a = op.args;
    const nums = a.map((x) => (x.t === "num" ? x.v : NaN));
    switch (op.op) {
      case "q":
        stack.push(gs);
        break;
      case "Q":
        gs = stack.pop() ?? gs;
        break;
      case "cm":
        if (nums.length >= 6 && nums.slice(-6).every(Number.isFinite)) gs = { ...gs, ctm: mul(nums.slice(-6) as Matrix, gs.ctm) };
        break;
      case "g":
      case "rg":
      case "k":
      case "sc":
      case "scn": {
        const c = toRgb(a);
        if (c) gs = { ...gs, fill: c };
        break;
      }
      case "Tr":
        if (Number.isFinite(nums[0])) tr = nums[0];
        break;
      case "BDC":
        oc.push(a[0]?.t === "name" && a[0].v === "OC" && a[1]?.t === "name" ? !groupVisible(ctx, properties?.get(N(a[1].v)), w.hiddenGroups) : false);
        break;
      case "BMC":
        oc.push(false);
        break;
      case "EMC":
        oc.pop();
        break;
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
        if (Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
          tlm = mul([1, 0, 0, 1, nums[0], nums[1]], tlm);
          tm = tlm;
        }
        break;
      case "TD":
        if (Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
          tl = -nums[1];
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
        if (a[0]?.t === "arr") show(op, a[0].v.flatMap((x): Array<Uint8Array | number> => (x.t === "str" ? [x.v] : x.t === "num" ? [x.v] : [])), "");
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
      case "Do": {
        if (depth > 8 || a[0]?.t !== "name") break;
        const name = a[0].v;
        const xobjects = res?.lookupMaybe(N("XObject"), PDFDict);
        const ref = xobjects?.get(N(name));
        const xo = ref instanceof PDFRef ? ctx.lookup(ref) : null;
        if (!(xo instanceof PDFRawStream) || xo.dict.get(N("Subtype")) !== N("Form")) break;
        let content: Uint8Array;
        try {
          content = xo.dict.has(N("Filter")) ? decodePDFRawStream(xo).decode() : xo.contents;
        } catch {
          break;
        }
        const m = xo.dict.lookupMaybe(N("Matrix"), PDFArray);
        const fm = (m && m.size() === 6 ? m.asArray().map((v) => num(v)) : IDENTITY) as Matrix;
        const formHidden = isHidden() || !groupVisible(ctx, xo.dict.get(N("OC")), w.hiddenGroups);
        const inner = processStream(content, xo.dict.lookupMaybe(N("Resources"), PDFDict) ?? res, { ctm: mul(fm, gs.ctm), fill: gs.fill }, formHidden, w, depth + 1);
        if (!inner.removed) break;
        // Skjemaet kan brukes på andre sider (tittelfelt!): lag en egen kopi for denne.
        const dict = xo.dict.clone(ctx);
        dict.delete(N("Filter"));
        dict.delete(N("DecodeParms"));
        dict.delete(N("Length"));
        if (inner.resources) dict.set(N("Resources"), inner.resources);
        const copy = ctx.flateStream(applyEdits(content, inner.edits));
        for (const [k, v] of dict.entries()) copy.dict.set(k, v);
        const copyRef = ctx.register(copy);
        if (!resCopied || !res) {
          const copied: PDFDict = res ? res.clone(ctx) : ctx.obj({});
          copied.set(N("XObject"), (copied.lookupMaybe(N("XObject"), PDFDict) ?? ctx.obj({})).clone(ctx));
          res = copied;
          resCopied = true;
        }
        const xs = res.lookupMaybe(N("XObject"), PDFDict)!;
        let k = 1;
        while (xs.has(N(`${name}_e${k}`))) k++;
        xs.set(N(`${name}_e${k}`), copyRef);
        edits.push({ start: op.start, end: op.end, text: `/${name}_e${k} Do` });
        removed += inner.removed;
        break;
      }
    }
  }
  return { edits, removed, resources: resCopied ? res! : null };
}

export function applyEdits(data: Uint8Array, edits: Array<{ start: number; end: number; text: string }>): Uint8Array {
  const parts: Uint8Array[] = [];
  let pos = 0;
  const enc = new TextEncoder();
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    parts.push(data.subarray(pos, e.start), enc.encode(e.text));
    pos = e.end;
  }
  parts.push(data.subarray(pos));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function pageContent(page: PDFPage): Uint8Array | null {
  const ctx = page.doc.context;
  const contents = page.node.Contents();
  const list = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const parts: Uint8Array[] = [];
  for (const c of list) {
    const s = ctx.lookup(c);
    if (!(s instanceof PDFRawStream)) return null;
    try {
      parts.push(s.dict.has(N("Filter")) ? decodePDFRawStream(s).decode() : s.contents, new Uint8Array([10]));
    } catch {
      return null;
    }
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** «ABCDEF+Arial-BoldMT» → «Arial-BoldMT». */
export const cleanFontName = (name: string) => name.replace(/^[A-Z]{6}\+/, "");

/**
 * Bytter ut en tekstlinje. Tom `text` sletter linjen. Siden får innholdet sitt
 * pakket i q/Q, så den nye teksten tegnes i sidens vanlige koordinater.
 */
export async function replaceLine(bytes: Uint8Array, line: TextLine, text: string, loadFont: FontLoader): Promise<EditResult> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new Error("Dokumentet er kryptert og kan ikke endres.");
  const page = doc.getPage(line.page);
  const ctx = doc.context;
  const content = pageContent(page);
  const found: { first: Found | null } = { first: null };
  let removed = 0;
  if (content) {
    const r = processStream(content, page.node.Resources(), { ctm: IDENTITY, fill: [0, 0, 0] }, false, { doc, line, found, runs: null, hiddenGroups: hiddenGroups(doc) }, 0);
    removed = r.removed;
    if (removed) {
      if (r.resources) page.node.set(N("Resources"), r.resources);
      const edited = applyEdits(content, r.edits);
      const enc = new TextEncoder();
      const wrapped = new Uint8Array(edited.length + 5);
      wrapped.set(enc.encode("q\n"), 0);
      wrapped.set(edited, 2);
      wrapped.set(enc.encode("\nQ\n"), edited.length + 2);
      page.node.set(N("Contents"), ctx.register(ctx.flateStream(wrapped)));
    }
  }
  // Fant vi ikke kommandoene (f.eks. uvanlig koding), dekkes linjen over med hvitt under.
  if (!removed) page.node.wrapContentStreams(ctx.register(ctx.contentStream([pushGraphicsState()])), ctx.register(ctx.contentStream([popGraphicsState()])));

  const f = found.first;
  const at = f?.at ?? line.origin;
  const angle = f?.angle ?? (Math.atan2(line.dir[1], line.dir[0]) * 180) / Math.PI;
  const size = f && f.size > 0.5 ? f.size : line.size;
  const color = f?.color ?? [0, 0, 0];
  const originalFont = f?.font ? cleanFontName(f.font) : null;

  if (!removed) {
    // Hvit boks over den gamle linjen (litt under grunnlinjen og opp til toppen av bokstavene).
    const d = line.dir;
    const n: Pt = [-d[1], d[0]];
    const p0: Pt = [line.origin[0] - n[0] * size * 0.3 - d[0] * size * 0.1, line.origin[1] - n[1] * size * 0.3 - d[1] * size * 0.1];
    page.drawRectangle({ x: p0[0], y: p0[1], width: line.length + size * 0.2, height: size * 1.25, color: rgb(1, 1, 1), rotate: degrees(angle) });
  }

  let usedFont = "Helvetica";
  if (text) {
    let font: PDFFont | null = null;
    // Reserven (Arial/Helvetica) får samme vekt og stil som originalen.
    const bold = /bold|black|heavy|semi|demi/i.test(originalFont ?? "");
    const italic = /italic|oblique/i.test(originalFont ?? "");
    const arial = `Arial${bold || italic ? "-" : ""}${bold ? "Bold" : ""}${italic ? "Italic" : ""}`;
    const file = originalFont ? await loadFont(originalFont).catch(() => null) : null;
    const fallback = file ? null : await loadFont(arial).catch(() => null);
    const data = file ?? fallback;
    if (data) {
      doc.registerFontkit(fontkit);
      try {
        font = await doc.embedFont(data, { subset: true });
        usedFont = file ? originalFont! : arial;
      } catch {
        font = null;
      }
    }
    if (!font) {
      const helv = bold && italic ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
      font = await doc.embedFont(helv);
      usedFont = helv;
      // Helvetica kan bare tegn fra Windows-1252.
      text = [...text].map((ch) => {
        try {
          font!.encodeText(ch);
          return ch;
        } catch {
          return "?";
        }
      }).join("");
    }
    page.drawText(text, { x: at[0], y: at[1], size, font, color: rgb(...(color.map((c) => Math.min(1, Math.max(0, c))) as [number, number, number])), rotate: degrees(angle) });
  }
  // Den gamle innholdsstrømmen (med den gamle teksten) skal ikke bli liggende i fila.
  collectGarbage(ctx);
  return { bytes: await doc.save(), removed, font: usedFont, originalFont };
}

// ---------- Linjer fra pdf.js ----------

/** Det vi trenger fra pdf.js sine tekstbiter (`getTextContent().items`). */
export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/**
 * Setter sammen pdf.js sine tekstbiter til linjer: biter med samme retning og
 * grunnlinje som følger tett etter hverandre.
 */
export function groupLines(items: TextItemLike[], page: number): TextLine[] {
  const lines: TextLine[] = [];
  let cur: TextLine | null = null;
  for (const it of items) {
    if (!it.str || !it.transform) continue;
    const t = it.transform;
    const size = Math.hypot(t[2], t[3]) || it.height || 1;
    const len = Math.hypot(t[0], t[1]) || 1;
    const dir: Pt = [t[0] / len, t[1] / len];
    const origin: Pt = [t[4], t[5]];
    // Et bredt mellomrom (pdf.js legger dem inn for sprang i teksten) skiller kolonner.
    if (!it.str.trim() && cur && it.width > cur.size * 1.2) {
      cur = null;
      continue;
    }
    if (cur) {
      const same = dir[0] * cur.dir[0] + dir[1] * cur.dir[1] > 0.995 && Math.abs(size - cur.size) < cur.size * 0.35;
      const rel: Pt = [origin[0] - cur.origin[0], origin[1] - cur.origin[1]];
      const u = rel[0] * cur.dir[0] + rel[1] * cur.dir[1];
      const v = -rel[0] * cur.dir[1] + rel[1] * cur.dir[0];
      if (same && Math.abs(v) < cur.size * 0.3 && u > cur.length - cur.size * 0.5 && u < cur.length + cur.size * 1.2) {
        const gap = u - cur.length;
        if (gap > cur.size * 0.18 && !cur.text.endsWith(" ") && !it.str.startsWith(" ")) cur.text += " ";
        cur.text += it.str;
        cur.length = Math.max(cur.length, u + it.width);
        continue;
      }
    }
    if (!it.str.trim()) {
      cur = null;
      continue;
    }
    cur = { page, text: it.str, origin, dir, length: it.width, size };
    lines.push(cur);
  }
  for (const l of lines) l.text = l.text.replace(/\s+$/, "");
  return lines.filter((l) => l.text.trim());
}

/** Om punktet p ligger på linjen (med litt slingringsmonn). */
export function lineContains(l: TextLine, p: Pt, pad = 0): boolean {
  const rel: Pt = [p[0] - l.origin[0], p[1] - l.origin[1]];
  const u = rel[0] * l.dir[0] + rel[1] * l.dir[1];
  const v = -rel[0] * l.dir[1] + rel[1] * l.dir[0];
  return u >= -pad && u <= l.length + pad && v >= -l.size * 0.3 - pad && v <= l.size * 0.95 + pad;
}

/** Leser dokumentet for å finne tekstkommandoene (se `textRuns`). */
export function loadForRuns(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

/** Tekstkommandoene på en side, med om de er synlige. */
export function textRuns(doc: PDFDocument, pageIndex: number): Run[] {
  const page = doc.getPage(pageIndex);
  const content = pageContent(page);
  if (!content) return [];
  const runs: Run[] = [];
  processStream(content, page.node.Resources(), { ctm: IDENTITY, fill: [0, 0, 0] }, false, { doc, line: null, found: { first: null }, runs, hiddenGroups: hiddenGroups(doc) }, 0);
  return runs;
}
