// Selvtest av redact-pdf.ts: node scripts/test-redact.mjs
// Sjekker at det som sladdes, faktisk er borte fra fila (ikke bare dekket over).
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream, rgb } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { redactPdf } from "../src/redact-pdf.ts";

const ttf = readFileSync(new URL("../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf", import.meta.url));
const noCodec = { resize: async () => { throw new Error("ikke brukt"); }, jpeg: async () => { throw new Error("ikke brukt"); } };

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const font = await doc.embedFont(ttf, { subset: true });
const ctx = doc.context;
const page = doc.addPage([595, 842]);
const label = "Tilbudssum: ";
page.drawText(`${label}1 250 000 kr`, { x: 50, y: 700, size: 14, font });
page.drawText("Prosjekt: Hasle", { x: 50, y: 660, size: 14, font });
// Figur helt inne i området, og en som stikker utenfor.
page.drawRectangle({ x: 310, y: 520, width: 20, height: 20, color: rgb(0, 0, 1) });
page.drawRectangle({ x: 200, y: 520, width: 200, height: 20, color: rgb(0, 1, 0) });
// Bilde 100 × 50 (hvitt), halvveis under området.
const img = ctx.register(ctx.flateStream(new Uint8Array(100 * 50 * 3).fill(255), { Type: "XObject", Subtype: "Image", Width: 100, Height: 50, BitsPerComponent: 8, ColorSpace: "DeviceRGB" }));
page.node.setXObject(PDFName.of("Img"), img);
const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = await import("pdf-lib");
page.pushOperators(pushGraphicsState(), concatTransformationMatrix(200, 0, 0, 100, 250, 400), drawObject("Img"), popGraphicsState());
// Kommentar i området, og Illustrator-data.
page.node.addAnnot(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [320, 690, 340, 710], Contents: "Hemmelig" })));
doc.catalog.set(PDFName.of("PieceInfo"), ctx.obj({ Illustrator: { Private: "kopi" } }));
const bytes = await doc.save();

// Områdene: beløpet etter «Tilbudssum: », og et område over figuren og hele bildet.
const x0 = 50 + font.widthOfTextAtSize(label, 14) - 1;
const areas = [{ page: 0, rect: [x0, 695, 500, 720] }, { page: 0, rect: [240, 395, 500, 560] }];
const { bytes: out, stats } = await redactPdf(bytes, areas, noCodec);

const pdf = await getDocument({ data: out.slice(), standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/" }).promise;
const p = await pdf.getPage(1);
const text = (await p.getTextContent()).items.map((i) => i.str).join("|");
assert.ok(text.includes("Tilbudssum:"), text);
assert.ok(text.includes("Prosjekt: Hasle"), text);
assert.ok(!/[0-9]/.test(text.replace("Prosjekt", "")), `tallene skal være borte: ${text}`);
assert.equal(stats.glyphs, "1 250 000 kr".length);
assert.equal(stats.paths, 1, "bare figuren som ligger helt inne, fjernes");
assert.equal(stats.images, 1);
assert.equal(stats.annotations, 1);

// Ingen strømmer i fila inneholder de gamle tegnene (heller ikke rester som ingen peker på).
const out2 = await PDFDocument.load(out);
const secret = font.encodeText("250").toString().slice(1, -1).toLowerCase();
for (const [, obj] of out2.context.enumerateIndirectObjects()) {
  if (!(obj instanceof PDFRawStream)) continue;
  let data;
  try {
    data = obj.dict.has(PDFName.of("Filter")) ? decodePDFRawStream(obj).decode() : obj.contents;
  } catch {
    continue;
  }
  const s = Buffer.from(data).toString("latin1").toLowerCase();
  assert.ok(!s.includes(secret), "gammel tekst ligger igjen i en strøm");
}

// Bildet lå helt inne i området: det er borte fra fila, ikke bare fra siden.
const images = out2.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
assert.equal(images.length, 0);
assert.equal(out2.getPage(0).node.Annots()?.size() ?? 0, 0);
assert.equal(out2.catalog.get(PDFName.of("PieceInfo")), undefined);

// Delvis dekket bilde: bare den delen som er i området, blir svart.
{
  const r2 = await redactPdf(bytes, [{ page: 0, rect: [240, 380, 350, 520] }], noCodec);
  const d2 = await PDFDocument.load(r2.bytes);
  const xs = d2.getPage(0).node.Resources().lookup(PDFName.of("XObject"));
  const im = xs.entries().map(([, r]) => d2.context.lookup(r)).find((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  const pix = decodePDFRawStream(im).decode();
  const at = (x, y) => pix[(y * 100 + x) * 3];
  assert.equal(at(10, 25), 0, "venstre del (x 250–350) er svart");
  assert.equal(at(90, 25), 255, "høyre del er urørt");
}

console.log("sladding: OK");
