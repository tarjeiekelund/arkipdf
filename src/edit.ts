// Endringer som skrives til fil: ny siderekkefølge og sammenslåing.
import { PDFDocument, degrees } from "pdf-lib";

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

/** Slår sammen flere PDF-er i gitt rekkefølge. */
export async function mergePdfs(
  files: Array<{ name: string; bytes: Uint8Array }>,
  onProgress?: (done: number) => void,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (let i = 0; i < files.length; i++) {
    const src = await load(files[i].bytes, files[i].name);
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const p of copied) out.addPage(p);
    onProgress?.(i + 1);
  }
  return out.save();
}
