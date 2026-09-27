// Selvtest av textedit-pdf.ts: node scripts/test-textedit.mjs
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFOperator, beginText, endText, moveText, setFontAndSize, showText, drawObject, pushGraphicsState, popGraphicsState, concatTransformationMatrix } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { groupLines, lineContains, loadForRuns, parseContent, replaceLine, textRuns } from "../src/textedit-pdf.ts";

const ttf = readFileSync(new URL("../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf", import.meta.url));
const loadFont = async () => new Uint8Array(ttf);

async function make() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(ttf, { subset: true });
  const p1 = doc.addPage([595, 842]);
  const p2 = doc.addPage([595, 842]);
  // Tittelfelt som skjema (XObject) brukt på begge sider.
  const ctx = doc.context;
  const formOps = [beginText(), setFontAndSize("F1", 10), moveText(40, 60), showText(font.encodeText("Prosjekt: Brynseng")), endText()];
  const form = ctx.formXObject(formOps, { BBox: [0, 0, 595, 200], Resources: { Font: { F1: font.ref } } });
  const formRef = ctx.register(form);
  for (const p of [p1, p2]) {
    p.node.setXObject(PDFName.of("TB"), formRef);
    const key = p.node.newFontDictionary("F1", font.ref);
    p.pushOperators(
      beginText(),
      setFontAndSize(key, 12),
      moveText(50, 700),
      // To kommandoer på én linje, uten ny posisjon imellom.
      showText(font.encodeText("Tegning nr: ")),
      showText(font.encodeText("A-101")),
      endText(),
      beginText(),
      setFontAndSize(key, 12),
      moveText(50, 650),
      // «Rom» og «Areal» i samme blokk, med et stort sprang imellom (som i tabeller).
      showText(font.encodeText("Rom")),
      PDFOperator.of("TJ", [ctx.obj([-8000, font.encodeText("Areal")])]),
      endText(),
      pushGraphicsState(),
      concatTransformationMatrix(1, 0, 0, 1, 0, 0),
      drawObject("TB"),
      popGraphicsState(),
    );
  }
  return doc.save();
}

async function lines(bytes, page) {
  const d = await getDocument({ data: bytes.slice(), standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/" }).promise;
  const p = await d.getPage(page + 1);
  return groupLines((await p.getTextContent()).items, page);
}
const find = (ls, s) => ls.find((l) => l.text.includes(s));

// Innholdsstrømmer: operander med posisjoner.
{
  const src = new TextEncoder().encode("BT /F1 12 Tf 1 0 0 1 50 700 Tm (a\\)b) Tj [(x) -250 <0041>] TJ ET");
  const ops = parseContent(src);
  assert.deepEqual(ops.map((o) => o.op), ["BT", "Tf", "Tm", "Tj", "TJ", "ET"]);
  const tj = ops[3];
  assert.equal(new TextDecoder().decode(src.subarray(tj.start, tj.end)), "(a\\)b) Tj");
  assert.deepEqual([...tj.args[0].v], [97, 41, 98]);
}

const base = await make();
let ls = await lines(base, 0);
const title = find(ls, "Tegning");
assert.equal(title.text, "Tegning nr: A-101");
assert.ok(lineContains(title, [title.origin[0] + 5, title.origin[1] + 3]));

// 1) Hele linjen byttes; den gamle teksten er borte fra fila.
const r1 = await replaceLine(base, title, "Tegning nr: A-102", loadFont);
assert.equal(r1.removed, 2);
ls = await lines(r1.bytes, 0);
assert.ok(!ls.some((l) => l.text.includes("A-101")), "gammel tekst fjernet");
const t2 = find(ls, "A-102");
assert.ok(t2 && Math.abs(t2.origin[0] - 50) < 0.5 && Math.abs(t2.origin[1] - 700) < 0.5, "ny tekst på samme sted");
assert.ok(Math.abs(t2.size - 12) < 0.1);

// 2) «Rom» byttes; «Areal» i samme blokk står der den stod.
ls = await lines(base, 0);
const arealBefore = find(ls, "Areal");
const rom = ls.find((l) => l.text === "Rom");
assert.ok(rom, "Rom er egen linje");
const r2 = await replaceLine(base, rom, "Stue 2", loadFont);
ls = await lines(r2.bytes, 0);
const arealAfter = find(ls, "Areal");
assert.ok(Math.abs(arealAfter.origin[0] - arealBefore.origin[0]) < 0.05, `Areal flyttet seg: ${arealBefore.origin[0]} → ${arealAfter.origin[0]}`);
assert.ok(find(ls, "Stue 2"));

// 3) Tittelfelt i XObject brukt på to sider: bare side 1 endres.
ls = await lines(base, 0);
const proj = find(ls, "Prosjekt");
const r3 = await replaceLine(base, proj, "Prosjekt: Hasle", loadFont);
assert.equal(r3.removed, 1);
assert.ok(find(await lines(r3.bytes, 0), "Hasle") && !find(await lines(r3.bytes, 0), "Brynseng"));
assert.ok(find(await lines(r3.bytes, 1), "Brynseng"), "side 2 har fortsatt det gamle tittelfeltet");

// 4) Tom tekst sletter linjen.
const r4 = await replaceLine(base, title, "", loadFont);
assert.ok(!find(await lines(r4.bytes, 0), "Tegning"));

// 5) Tekst i et avslått lag er skjult og røres ikke når en linje på samme sted endres.
{
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(ttf, { subset: true });
  const ctx = doc.context;
  const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: "Skjult" }));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg] } }));
  const page = doc.addPage([400, 300]);
  const key = page.node.newFontDictionary("F1", font.ref);
  page.node.set(PDFName.of("Resources"), page.node.Resources());
  page.node.Resources().set(PDFName.of("Properties"), ctx.obj({ L1: ocg }));
  page.pushOperators(
    PDFOperator.of("BDC", [PDFName.of("OC"), PDFName.of("L1")]),
    beginText(), setFontAndSize(key, 12), moveText(20, 200), showText(font.encodeText("Skjult tekst")), endText(),
    PDFOperator.of("EMC"),
    beginText(), setFontAndSize(key, 12), moveText(20, 200), showText(font.encodeText("Synlig tittel")), endText(),
  );
  const bytes = await doc.save();
  const runs = textRuns(await loadForRuns(bytes), 0);
  assert.deepEqual(runs.map((r) => r.hidden), [true, false]);
  const line = (await lines(bytes, 0)).find((l) => l.text.includes("Synlig"));
  const r = await replaceLine(bytes, line, "Ny tittel", loadFont);
  assert.equal(r.removed, 1, "bare den synlige teksten fjernes");
  assert.deepEqual(textRuns(await loadForRuns(r.bytes), 0).filter((x) => x.hidden).length, 1, "den skjulte står igjen");
}

console.log("tekstredigering: OK");
