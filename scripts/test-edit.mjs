// Rask selvtest av edit.ts mot pdf-lib og pdf.js: node scripts/test-edit.mjs
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import assert from "node:assert/strict";
import { rearrangePages, mergePdfs } from "../src/edit.ts";

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
console.log("OK");
