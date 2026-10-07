// Selvtest av lagring av mål i PDF: node --experimental-strip-types scripts/test-measure-pdf.mjs
import assert from "node:assert/strict";
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from "pdf-lib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { metersPerPointForScale } from "../src/measure-math.ts";
import { isMeasureLayer, LAYER_NAME, readMeasureData, writeMeasurements } from "../src/measure-pdf.ts";

const src = await PDFDocument.create();
const font = await src.embedFont(StandardFonts.Helvetica);
src.addPage([2384, 1684]).drawText("Plan", { x: 100, y: 1600, size: 30, font });
src.addPage([595, 842]);
const original = await src.save();

const k = metersPerPointForScale(100);
const items = [
  { page: 0, kind: "distance", points: [[100, 120], [260, 120]], fixed: null, metersPerPoint: k, scaleLabel: "1:100", text: "5,64 m" },
  { page: 0, kind: "area", points: [[100, 120], [260, 120], [260, 240], [100, 240]], fixed: { metersPerPoint: k, label: "1:100 fra PDF" }, metersPerPoint: k, scaleLabel: "1:100", text: "23,89 m²", subText: "omkrets 19,76 m" },
  { page: 1, kind: "length", points: [[10, 10], [50, 10], [50, 60]], fixed: null, metersPerPoint: null, scaleLabel: null, text: "31,8 mm på arket" },
];
const pageScales = new Map([[0, { metersPerPoint: k, label: "1:100" }]]);
const saved = await writeMeasurements(original, items, pageScales, { metersPerPoint: k, label: "1:100" });

// Lest inn igjen: samme mål og målestokk.
const back = await readMeasureData(saved);
assert.equal(back.measurements.length, 3);
assert.deepEqual(back.measurements.map((m) => [m.page, m.kind, m.points.length]), [[0, "distance", 2], [0, "area", 4], [1, "length", 3]]);
assert.deepEqual(back.measurements[1].fixed, { metersPerPoint: k, label: "1:100 fra PDF" });
assert.equal(back.pageScales.get(0).label, "1:100");
assert.equal(back.defaultScale.label, "1:100");

// Standard PDF-kommentarer med lag, målestokk og tekst som andre programmer forstår.
const pdf = await getDocument({ data: saved.slice() }).promise;
const annots = await (await pdf.getPage(1)).getAnnotations();
assert.deepEqual(annots.map((a) => a.subtype).sort(), ["Line", "Polygon"]);
assert.ok(annots.some((a) => a.contentsObj?.str === "23,89 m² (omkrets 19,76 m)"));
const cfg = await pdf.getOptionalContentConfig();
const groups = [...cfg].filter(([, g]) => g.name === LAYER_NAME);
assert.equal(groups.length, 1, "laget finnes");

// Med laget skjult tegner pdf.js ikke kommentarene; ellers gjør den det.
const page = await pdf.getPage(1);
const count = (ol) => ol.fnArray.filter((f) => f === OPS.beginAnnotation).length;
const visible = await page.getOperatorList();
assert.equal(count(visible), 2);
cfg.setVisibility(groups[0][0], false);
const hiddenOps = await page.getOperatorList({ intent: "display" });
// pdf.js hopper over innhold i skjulte lag når det tegnes; sjekk at laget omslutter kommentarene.
assert.ok(hiddenOps.fnArray.includes(OPS.beginMarkedContentProps), "kommentarene ligger i et lag");

// Lagre på nytt erstatter (ikke dupliserer) målene, og fila vokser ikke ukontrollert.
const again = await writeMeasurements(saved, items.slice(0, 1), new Map(), null);
const back2 = await readMeasureData(again);
assert.equal(back2.measurements.length, 1);
const pdf2 = await getDocument({ data: again.slice() }).promise;
assert.equal((await (await pdf2.getPage(2)).getAnnotations()).length, 0);
assert.equal([...(await pdf2.getOptionalContentConfig())].filter(([, g]) => g.name === LAYER_NAME).length, 1, "ikke to lag");
// Fil lagret mens appen het Blad: laget får nytt navn, og det blir ikke to lag.
assert.ok(isMeasureLayer("Mål (Blad)") && isMeasureLayer(LAYER_NAME) && !isMeasureLayer("Møbler"));
const old = await PDFDocument.load(saved);
const ocgs = old.catalog.lookup(PDFName.of("OCProperties")).lookup(PDFName.of("OCGs"));
ocgs.lookup(0).set(PDFName.of("Name"), PDFHexString.fromText("Mål (Blad)"));
const renamed = await writeMeasurements(await old.save(), items.slice(0, 1), new Map(), null);
const names = [...(await (await getDocument({ data: renamed.slice() }).promise).getOptionalContentConfig())].map(([, g]) => g.name);
assert.deepEqual(names.filter(isMeasureLayer), [LAYER_NAME]);
assert.equal((await readMeasureData(renamed)).measurements.length, 1);
// Navn, farge og sirkel lagres og leses inn igjen; sirkelen er et polygon for andre programmer.
const named = await writeMeasurements(original, [
  { ...items[1], name: "BYA", color: "#2b8a3e" },
  { page: 0, kind: "circle", points: [[500, 500], [600, 500]], fixed: null, metersPerPoint: k, scaleLabel: "1:100", text: "11,08 m²", subText: "r 3,53 m", name: "Sone 😀" },
], new Map(), null);
const nb = await readMeasureData(named);
assert.deepEqual(nb.measurements.map((m) => [m.kind, m.name, m.color, m.points.length]), [["area", "BYA", "#2b8a3e", 4], ["circle", "Sone 😀", undefined, 2]]);
const na = await (await (await getDocument({ data: named.slice() }).promise).getPage(1)).getAnnotations();
assert.ok(na.some((a) => a.contentsObj?.str === "BYA: 23,89 m² (omkrets 19,76 m)"));
const circ = na.find((a) => a.subtype === "Polygon" && a.vertices?.length > 10);
assert.ok(circ, "sirkelen lagres som polygon");
assert.deepEqual([...na.find((a) => a.contentsObj?.str.startsWith("BYA")).color], [0x2b, 0x8a, 0x3e]);
// Ingen mål igjen: kommentarene fjernes helt.
const empty = await writeMeasurements(again, [], new Map(), null);
assert.equal((await readMeasureData(empty)).measurements.length, 0);
console.log("OK");
