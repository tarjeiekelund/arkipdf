// Rask selvtest av edit.ts mot pdf-lib og pdf.js: node scripts/test-edit.mjs
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import assert from "node:assert/strict";
import { rearrangePages, mergePdfs, extractPages } from "../src/edit.ts";

async function make(labels) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const l of labels) doc.addPage([300, 400]).drawText(l, { x: 50, y: 200, size: 40, font });
  return doc.save();
}

async function texts(bytes) {
  const doc = await getDocument({ data: bytes.slice() }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const t = await p.getTextContent();
    out.push({ text: t.items.map((x) => x.str).join(""), rotate: p.rotate });
  }
  return out;
}

const a = await make(["A1", "A2", "A3", "A4"]);
const r = await rearrangePages(a, [{ src: 3, rot: 0 }, { src: 0, rot: 90 }, { src: 2, rot: -90 }]);
assert.deepEqual(await texts(r), [
  { text: "A4", rotate: 0 },
  { text: "A1", rotate: 90 },
  { text: "A3", rotate: 270 },
]);

const b = await make(["B1", "B2"]);
const m = await mergePdfs([{ name: "b", bytes: b }, { name: "a", bytes: a }]);
assert.deepEqual((await texts(m)).map((x) => x.text), ["B1", "B2", "A1", "A2", "A3", "A4"]);

// Sammenslåingen får ett bokmerke per fil, som peker til filens første side.
const md = await getDocument({ data: m.slice() }).promise;
const outline = await md.getOutline();
assert.deepEqual(outline.map((o) => o.title), ["b", "a"]);
assert.equal(await md.getPageIndex(outline[1].dest[0]), 2);

const e = await extractPages(a, [2, 0]);
assert.deepEqual((await texts(e)).map((x) => x.text), ["A3", "A1"]);
console.log("OK");

// «Lås skjema»: feltene blir vanlig innhold, med verdiene som tekst på siden.
{
  const { flattenForm } = await import("../src/edit.ts");
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const form = doc.getForm();
  const f = form.createTextField("navn");
  f.setText("Låst verdi");
  f.addToPage(page, { x: 20, y: 100, width: 200, height: 24 });
  const flat = await flattenForm(await doc.save());
  const after = await PDFDocument.load(flat);
  assert.equal(after.getForm().getFields().length, 0);
  const p = await (await getDocument({ data: flat.slice() }).promise).getPage(1);
  assert.equal((await p.getTextContent()).items.map((i) => i.str).join(""), "Låst verdi");
}

// Bilder til PDF: skannet tegning med oppløsning får virkelig størrelse, andre bilder A4.
{
  const { imageInfo, imagePage, imagesToPdf, isSigned } = await import("../src/edit.ts");
  const { deflateSync, crc32 } = await import("node:zlib");
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, "latin1");
    data.copy(b, 8);
    b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
    return b;
  };
  const png = (w, h, dpi) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; // 8 bit
    ihdr[9] = 2; // RGB
    const raw = Buffer.alloc((w * 3 + 1) * h, 200);
    for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
    const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
    if (dpi) {
      const phys = Buffer.alloc(9);
      phys.writeUInt32BE(Math.round(dpi / 0.0254), 0);
      phys.writeUInt32BE(Math.round(dpi / 0.0254), 4);
      phys[8] = 1;
      parts.push(chunk("pHYs", phys));
    }
    parts.push(chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
    return new Uint8Array(Buffer.concat(parts));
  };
  const scan = png(600, 300, 300);
  assert.deepEqual(imageInfo(scan), { kind: "png", width: 600, height: 300, dpi: 300, orientation: 1 });
  // 600 × 300 px ved 300 dpi = 2 × 1 tommer = 144 × 72 pt.
  assert.deepEqual(imagePage(600, 300, 300).page, [144, 72]);
  // Uten oppløsning (eller skjermoppløsning): A4 liggende for et bredt bilde.
  assert.deepEqual(imagePage(600, 300, null).page, [841.89, 595.28]);
  assert.deepEqual(imagePage(4000, 3000, 72).page, [841.89, 595.28]);
  const pdf = await imagesToPdf([{ name: "skann.png", bytes: scan }, { name: "foto.png", bytes: png(300, 400, null) }], async () => {
    throw new Error("skal ikke trengs");
  });
  const d = await PDFDocument.load(pdf);
  assert.deepEqual(d.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]), [[144, 72], [595, 842]]);
  assert.equal(isSigned(pdf), false);
  assert.equal(isSigned(new TextEncoder().encode("%PDF-1.7 1 0 obj << /Type /Sig /ByteRange [0 10 20 30] >>")), true);
}
console.log("bilder: OK");
