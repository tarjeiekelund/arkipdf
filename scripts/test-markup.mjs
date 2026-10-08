// Selvtest av markup-pdf.ts: node scripts/test-markup.mjs
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import assert from "node:assert/strict";
import { cloudCurves, displayAxes, displayRect, flattenSignatures, makeSignatureImage, readMarkups, rectAround, signatureAlpha, textCorners, toTextLocal, writeMarkups } from "../src/markup-pdf.ts";
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

// Signatur: rektangelet står rett slik siden vises, også på roterte sider.
for (const rot of [0, 90, 180, 270]) {
  const [a, b] = rectAround([300, 200], 120, 40, rot);
  const r = displayRect(a, b, rot);
  assert.deepEqual([r.w, r.h], [120, 40]);
  const { ex, ey } = displayAxes(rot);
  // Midten ligger en halv bredde mot høyre og en halv høyde ned fra øvre venstre hjørne.
  assert.deepEqual([r.topLeft[0] + (ex[0] * 120 + ey[0] * 40) / 2, r.topLeft[1] + (ex[1] * 120 + ey[1] * 40) / 2], [300, 200]);
}

// Signaturen lagres som Stamp med bildet i utseendet, og leses tilbake uendret.
{
  const w = 60;
  const h = 20;
  const alpha = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) alpha[Math.round(10 + 8 * Math.sin(x / 6)) * w + x] = 255;
  const img = await makeSignatureImage(alpha, w, h);
  assert.deepEqual(await signatureAlpha(img), alpha);
  const [a, b] = rectAround([400, 200], 150, 50, 90);
  const signs = [
    { page: 1, kind: "sign", points: [a, b], color: "blue", u, rot: 90, img },
    { page: 0, kind: "sign", points: [[50, 50], [200, 100]], color: "black", u, rot: 0, img },
  ];
  const withSigns = await writeMarkups(base, [...items, ...signs]);
  const read = await readMarkups(withSigns);
  assert.equal(read.length, 5);
  for (const s of signs) {
    const r = read.find((m) => m.kind === "sign" && m.page === s.page);
    assert.deepEqual(r, { ...s, text: undefined });
  }
  // Samme signatur to steder: én maske.
  const sdoc = await PDFDocument.load(withSigns);
  const masks = sdoc.context.enumerateIndirectObjects().filter(([, o]) => o.dict?.get(PDFName.of("ColorSpace"))?.toString() === "/DeviceGray");
  assert.equal(masks.length, 1);

  const spdf = await getDocument({ data: withSigns.slice() }).promise;
  const stamp = (await (await spdf.getPage(2)).getAnnotations()).find((x) => x.subtype === "Stamp");
  assert.ok(stamp, "signatur som Stamp");

  // Lagres på nytt uten signaturene: bildene forsvinner fra fila.
  const without = await writeMarkups(withSigns, items);
  const wdoc = await PDFDocument.load(without);
  assert.equal(wdoc.context.enumerateIndirectObjects().filter(([, o]) => o.dict?.get(PDFName.of("Subtype"))?.toString() === "/Image").length, 0);

  // Låst kopi: signaturene blir sideinnhold, andre markeringer står som før.
  const flat = await flattenSignatures(withSigns);
  assert.equal(flat.count, 2);
  const fread = await readMarkups(flat.bytes);
  assert.equal(fread.filter((m) => m.kind === "sign").length, 0);
  assert.equal(fread.length, 3);
  const fpdf = await getDocument({ data: flat.bytes.slice() }).promise;
  const ops = await (await fpdf.getPage(1)).getOperatorList();
  assert.ok(ops.fnArray.length > 0);
  const fdoc = await PDFDocument.load(flat.bytes);
  const xo = fdoc.getPage(0).node.Resources().lookup(PDFName.of("XObject"));
  assert.ok(xo.keys().some((k) => k.toString().startsWith("/ArkiSig")), "signaturen tegnes fra sidens innhold");
}

console.log("markup: OK");
