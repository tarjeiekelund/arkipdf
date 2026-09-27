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
