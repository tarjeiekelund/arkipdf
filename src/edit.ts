// Endringer som skrives til fil: ny siderekkefølge og sammenslåing.
import { PDFDocument, PDFHexString, PDFName, degrees, type PDFRef } from "pdf-lib";

export interface PageItem {
  /** Opprinnelig sideindeks (0-basert). */
  src: number;
  /** Ekstra rotasjon i grader (multiplum av 90). */
  rot: number;
}

async function load(bytes: Uint8Array, name: string): Promise<PDFDocument> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new Error(`${name} er passordbeskyttet/kryptert og kan ikke endres.`);
  return doc;
}

/**
 * Bygger om sidetreet i det eksisterende dokumentet i stedet for å kopiere
 * sidene over i et nytt. Da beholdes bokmerker, skjemafelt, metadata osv.
 */
export async function rearrangePages(bytes: Uint8Array, items: PageItem[], name = "Dokumentet"): Promise<Uint8Array> {
  if (!items.length) throw new Error("Dokumentet må ha minst én side.");
  const doc = await load(bytes, name);
  const pages = doc.getPages();
  for (const it of items) if (!pages[it.src]) throw new Error(`Side ${it.src + 1} finnes ikke.`);
  for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
  for (const it of items) {
    const page = pages[it.src];
    if (it.rot % 360 !== 0) page.setRotation(degrees((((page.getRotation().angle + it.rot) % 360) + 360) % 360));
    doc.addPage(page);
  }
  return doc.save();
}

/**
 * Slår sammen flere PDF-er i gitt rekkefølge. Hver fil får et bokmerke med
 * filnavnet, så et sammenslått tegningssett er lett å navigere i.
 */
export async function mergePdfs(
  files: Array<{ name: string; bytes: Uint8Array }>,
  onProgress?: (done: number) => void,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const bookmarks: Array<{ title: string; page: PDFRef }> = [];
  for (let i = 0; i < files.length; i++) {
    const src = await load(files[i].bytes, files[i].name);
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const p of copied) out.addPage(p);
    if (copied.length) bookmarks.push({ title: files[i].name.replace(/\.pdf$/i, ""), page: copied[0].ref });
    onProgress?.(i + 1);
  }
  addBookmarks(out, bookmarks);
  return out.save();
}

/** Lager en ny PDF med bare de valgte sidene (0-baserte indekser). */
export async function extractPages(bytes: Uint8Array, pages: number[], name = "Dokumentet"): Promise<Uint8Array> {
  const src = await load(bytes, name);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pages);
  for (const p of copied) out.addPage(p);
  return out.save();
}

/** Legger inn en flat liste med bokmerker som peker til hele sider. */
function addBookmarks(doc: PDFDocument, items: Array<{ title: string; page: PDFRef }>): void {
  if (!items.length) return;
  const ctx = doc.context;
  const root = ctx.nextRef();
  const refs = items.map(() => ctx.nextRef());
  items.forEach((it, i) => {
    const dict = ctx.obj({ Title: PDFHexString.fromText(it.title), Parent: root, Dest: [it.page, "Fit"] });
    if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
    if (i < items.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]);
    ctx.assign(refs[i], dict);
  });
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
  doc.catalog.set(PDFName.of("Outlines"), root);
}

/**
 * Gjør skjemafeltene om til vanlig sideinnhold («låser» skjemaet), med det
 * utseendet feltene har i fila (pdf.js har tegnet det for utfylte felt).
 */
export async function flattenForm(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await load(bytes, "Skjemaet");
  const form = doc.getForm();
  form.flatten({ updateFieldAppearances: false });
  return doc.save();
}

// ---------- Bilder til PDF ----------

/** Filtyper som kan gjøres om til PDF. */
export const IMAGE_FILE = /\.(jpe?g|png|webp|gif|bmp)$/i;

export interface ImageInfo {
  kind: "jpeg" | "png" | "other";
  width: number;
  height: number;
  /** Oppløsning fra fila (punkter per tomme), hvis den er oppgitt. */
  dpi: number | null;
  /** EXIF-retning (1 = rett); mobilbilder er ofte lagret på siden. */
  orientation: number;
}

/** Leser type, størrelse, oppløsning og EXIF-retning fra JPEG og PNG. */
export function imageInfo(b: Uint8Array): ImageInfo {
  const u16 = (i: number, le = false) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const u32 = (i: number, le = false) => (le ? (u16(i, true) | (u16(i + 2, true) << 16)) >>> 0 : ((u16(i) << 16) | u16(i + 2)) >>> 0);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const info: ImageInfo = { kind: "png", width: u32(16), height: u32(20), dpi: null, orientation: 1 };
    for (let i = 8; i + 12 <= b.length; ) {
      const len = u32(i);
      const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      // pHYs: piksler per meter når enheten er 1.
      if (type === "pHYs" && b[i + 16] === 1) info.dpi = Math.round(u32(i + 8) * 0.0254);
      if (type === "IDAT" || type === "IEND") break;
      i += 12 + len;
    }
    return info;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    const info: ImageInfo = { kind: "jpeg", width: 0, height: 0, dpi: null, orientation: 1 };
    for (let i = 2; i + 4 <= b.length; ) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = u16(i + 2);
      const s = i + 4;
      if (marker === 0xe0 && String.fromCharCode(...b.subarray(s, s + 4)) === "JFIF") {
        const unit = b[s + 7];
        const density = u16(s + 8);
        if (unit === 1 && density) info.dpi = density;
        else if (unit === 2 && density) info.dpi = Math.round(density * 2.54);
      } else if (marker === 0xe1 && String.fromCharCode(...b.subarray(s, s + 4)) === "Exif") {
        const t = s + 6;
        const le = b[t] === 0x49;
        const ifd = t + u32(t + 4, le);
        const n = u16(ifd, le);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (e + 12 > b.length) break;
          if (u16(e, le) === 0x0112) info.orientation = u16(e + 8, le);
        }
      } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        info.height = u16(s + 1);
        info.width = u16(s + 3);
        break;
      }
      i += 2 + len;
    }
    return info;
  }
  return { kind: "other", width: 0, height: 0, dpi: null, orientation: 1 };
}

const A4: [number, number] = [595.28, 841.89];
/** Største ark vi lager ut fra oppgitt oppløsning (A0, langside i punkter). */
const MAX_SIDE = 3370.39;

/**
 * Sidestørrelsen for et bilde: skannede tegninger med oppgitt oppløsning får
 * sin virkelige størrelse (så målestokken stemmer), andre bilder (foto,
 * skjermbilder) legges på et A4-ark med samme retning som bildet.
 */
export function imagePage(width: number, height: number, dpi: number | null): { page: [number, number]; box: [number, number, number, number] } {
  if (dpi && dpi >= 100 && dpi <= 2400) {
    const w = (width / dpi) * 72;
    const h = (height / dpi) * 72;
    if (Math.max(w, h) <= MAX_SIDE) return { page: [w, h], box: [0, 0, w, h] };
  }
  const page: [number, number] = width > height ? [A4[1], A4[0]] : A4;
  const margin = 28;
  const s = Math.min((page[0] - margin * 2) / width, (page[1] - margin * 2) / height);
  const w = width * s;
  const h = height * s;
  return { page, box: [(page[0] - w) / 2, (page[1] - h) / 2, w, h] };
}

/**
 * Lager en PDF med ett bilde per side. `normalize` gjør om bilder som ikke kan
 * bygges rett inn (andre formater, eller JPEG som må snus) til JPEG eller PNG.
 */
export async function imagesToPdf(
  images: Array<{ name: string; bytes: Uint8Array }>,
  normalize: (bytes: Uint8Array, info: ImageInfo) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const img of images) {
    let bytes = img.bytes;
    let info = imageInfo(bytes);
    const dpi = info.dpi;
    if (info.kind === "other" || info.orientation !== 1) {
      bytes = await normalize(bytes, info);
      info = imageInfo(bytes);
    }
    const embedded = info.kind === "jpeg" ? await doc.embedJpg(bytes) : info.kind === "png" ? await doc.embedPng(bytes) : null;
    if (!embedded) throw new Error(`${img.name} kan ikke leses som bilde.`);
    // Snudde bilder bytter bredde og høyde; oppløsningen gjelder fortsatt.
    const { page, box } = imagePage(embedded.width, embedded.height, dpi);
    doc.addPage(page).drawImage(embedded, { x: box[0], y: box[1], width: box[2], height: box[3] });
  }
  doc.setTitle(images.length === 1 ? images[0].name.replace(IMAGE_FILE, "") : "Bilder");
  doc.setProducer("ArkiPDF");
  return doc.save();
}

/**
 * Om PDF-en er signert digitalt. Signaturordboken har alltid /ByteRange i klartekst
 * (den må kunne fylles inn etter at resten av fila er skrevet), så et søk i
 * bytene holder, også for store filer.
 */
export function isSigned(bytes: Uint8Array): boolean {
  const needle = [47, 66, 121, 116, 101, 82, 97, 110, 103, 101]; // "/ByteRange"
  outer: for (let i = bytes.indexOf(47); i >= 0 && i <= bytes.length - needle.length; i = bytes.indexOf(47, i + 1)) {
    for (let k = 1; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}
