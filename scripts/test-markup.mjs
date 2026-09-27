// Selvtest av markup-pdf.ts: node scripts/test-markup.mjs
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import assert from "node:assert/strict";
import { cloudCurves, displayAxes, readMarkups, textCorners, toTextLocal, writeMarkups } from "../src/markup-pdf.ts";
import { readMeasureData, writeMeasurements } from "../src/measure-pdf.ts";

// Skyen: sammenhengende kurver, rundt hele rektangelet, buet utover.
{
  const curves = cloudCurves([100, 100], [300, 200], 1);
  for (let i = 1; i < curves.length; i++) assert.deepEqual(curves[i][0], curves[i - 1][3]);
  const first = curves[0][0];
  const last = curves.at(-1)[3];
  assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9, "skyen er lukket");
  // Toppene av buene ligger utenfor rektangelet.
  for (let i = 0; i < curves.length; i += 2) {
    const [x, y] = curves[i][3];
    assert.ok(x <= 100 + 1e-9 || x >= 300 - 1e-9 || y <= 100 + 1e-9 || y >= 200 - 1e-9, `bue ${i / 2} buer utover`);
    assert.ok(!(x > 100 + 1e-6 && x < 300 - 1e-6 && y > 100 + 1e-6 && y < 200 - 1e-6));
  }
}

// Tekstboksen står rett når siden vises, også på roterte sider.
for (const rot of [0, 90, 180, 270]) {
  const { ex, ey } = displayAxes(rot);
  assert.ok(ex[0] * ey[0] + ex[1] * ey[1] === 0);
  const c = textCorners([50, 60], rot, 40, 10);
  assert.deepEqual(toTextLocal(c[2], [50, 60], rot).map((v) => Math.round(v) + 0), [40, 10]);
}

async function make() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of ["A1", "A2"]) doc.addPage([842, 595]).drawText(t, { x: 50, y: 500, size: 30, font });
  // Side 2 er rotert, som mange tegninger.
  doc.getPage(1).setRotation({ type: "degrees", angle: 90 });
  return doc.save();
}

const u = Math.hypot(842, 595) / 1000;
const items = [
  { page: 0, kind: "cloud", points: [[100, 100], [300, 250]], color: "red", u },
  { page: 0, kind: "arrow", points: [[400, 100], [320, 180]], color: "blue", u },
  { page: 1, kind: "text", points: [[200, 300]], color: "black", u, text: "Endret vegg\nSe snitt A–A – ærlig", rot: 90 },
];

const base = await make();
// Mål i fila fra før skal bli stående når markeringene lagres.
const withMeasure = await writeMeasurements(base, [{ page: 0, kind: "distance", points: [[10, 10], [110, 10]], fixed: null, metersPerPoint: null, scaleLabel: null, text: "35 mm på arket" }], new Map(), null);
const saved = await writeMarkups(withMeasure, items);
const back = await readMarkups(saved);
assert.deepEqual(back, items.map((m) => ({ ...m, text: m.text, rot: m.rot ?? 0 })));
assert.equal((await readMeasureData(saved)).measurements.length, 1);

// Andre programmer ser vanlige kommentarer: Square med skykant, Line med pil, FreeText.
const pdf = await getDocument({ data: saved.slice() }).promise;
const a1 = (await (await pdf.getPage(1)).getAnnotations()).filter((a) => a.titleObj?.str === "ArkiPDF" || a.title === "ArkiPDF");
const types = a1.map((a) => a.subtype).sort();
assert.deepEqual(types, ["Line", "Line", "Square"]); // målet (Line) og pila
const a2 = await (await pdf.getPage(2)).getAnnotations();
const ft = a2.find((a) => a.subtype === "FreeText");
assert.ok(ft, "tekst som FreeText");
assert.equal(ft.contentsObj?.str ?? ft.contents, "Endret vegg\nSe snitt A–A – ærlig");

// Lagres det på nytt, erstattes markeringene i stedet for å legges til.
const again = await writeMarkups(saved, back.slice(0, 1));
assert.equal((await readMarkups(again)).length, 1);
const doc = await PDFDocument.load(again);
const annots = doc.getPage(0).node.Annots();
assert.equal(annots.size(), 2); // målet og skyen
const layers = doc.catalog.lookup(PDFName.of("OCProperties")).lookup(PDFName.of("OCGs"));
assert.deepEqual(layers.asArray().map((r) => doc.context.lookup(r).lookup(PDFName.of("Name")).decodeText()).sort(), ["Merknader (ArkiPDF)", "Mål (ArkiPDF)"]);

// Uten markeringer blir ingenting igjen.
assert.equal((await readMarkups(await writeMarkups(again, []))).length, 0);

console.log("markup: OK");
