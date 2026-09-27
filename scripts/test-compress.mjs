// Selvtest av compress.ts: node scripts/test-compress.mjs
// Bildebehandlingen er byttet ut med en enkel variant (nærmeste nabo, «JPEG»
// som bare er fyllbytes), så testen sjekker strukturen: størrelser,
// fargerom, duplikater og opprydding. Selve bildekvaliteten testes i nettleseren.
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";
import assert from "node:assert/strict";
import { compressPdf, imageScales, scanContent, unpredictPng } from "../src/compress.ts";
import { mergePdfs } from "../src/edit.ts";

const fakeCodec = {
  async resize(src, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    if ("jpeg" in src) return out.fill(128);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = (Math.floor((y * src.height) / h) * src.width + Math.floor((x * src.width) / w)) * src.channels;
        const o = (y * w + x) * 4;
        out[o] = src.pixels[s];
        out[o + 1] = src.pixels[src.channels === 3 ? s + 1 : s];
        out[o + 2] = src.pixels[src.channels === 3 ? s + 2 : s];
        out[o + 3] = 255;
      }
    return out;
  },
  async jpeg(rgba, w, h) {
    return new Uint8Array(Math.ceil((w * h) / 20)).fill(7);
  },
};

let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** Tegner et bilde på siden, w × h punkter stort. */
function place(page, ref, name, x, y, w, h) {
  page.node.setXObject(PDFName.of(name), ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, x, y), drawObject(name), popGraphicsState());
}

async function makeDoc() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  // «Foto»: støy i RGB, 2000 × 1000 px, vises 300 × 150 pt (4,2 × 2,1 tommer).
  const photo = new Uint8Array(2000 * 1000 * 3).map(() => Math.floor(rnd() * 256));
  const photoRef = ctx.register(ctx.flateStream(photo, { Type: "XObject", Subtype: "Image", Width: 2000, Height: 1000, BitsPerComponent: 8, ColorSpace: "DeviceRGB" }));
  // «Plantegning» med fargetabell: 1600 × 1600 px, vises 144 × 144 pt (2 × 2 tommer).
  const plan = new Uint8Array(1600 * 1600).map(() => Math.floor(rnd() * 4));
  const palette = new Uint8Array([255, 255, 255, 0, 0, 0, 29, 94, 77, 200, 200, 200]);
  const planRef = ctx.register(ctx.flateStream(plan, {
    Type: "XObject", Subtype: "Image", Width: 1600, Height: 1600, BitsPerComponent: 8,
    ColorSpace: ["Indexed", "DeviceRGB", 3, ctx.flateStream(palette)],
  }));
  // Et lite bilde (logo) som er for lite til å røres.
  const logoRef = ctx.register(ctx.flateStream(new Uint8Array(40 * 40 * 3).fill(90), { Type: "XObject", Subtype: "Image", Width: 40, Height: 40, BitsPerComponent: 8, ColorSpace: "DeviceRGB" }));
  // Et objekt ingen peker på.
  ctx.register(ctx.flateStream(new Uint8Array(5000).fill(1)));

  const page = doc.addPage([600, 400]);
  place(page, photoRef, "Photo", 20, 20, 300, 150);
  place(page, planRef, "Plan", 400, 200, 144, 144);
  place(page, logoRef, "Logo", 10, 360, 30, 30);
  return doc.save();
}

// Innholdsstrømmer: q/Q, cm, strenger med parenteser og innebygde bilder.
{
  const ops = [];
  const src = "q 2 0 0 3 10 20 cm (a\\) (b) c) Tj <414243> Tj BI /W 2 /H 1 /BPC 8 /CS /G ID \x00EI\xff EI Q /Im#301 Do [(x) 3 (y)] TJ";
  scanContent(new TextEncoder().encode(src), (op, args) => void ops.push([op, ...args]));
  assert.deepEqual(ops, [["q"], ["cm", 2, 0, 0, 3, 10, 20], ["Tj", null], ["Tj", null], ["BI"], ["Q"], ["Do", "Im01"], ["TJ", null, 3, null]]);
}

// PNG-prediktor (Sub og Up).
assert.deepEqual([...unpredictPng(new Uint8Array([1, 10, 5, 2, 1, 1]), 2, 1, 2)], [10, 15, 11, 16]);

const original = await makeDoc();
{
  const doc = await PDFDocument.load(original);
  const scales = imageScales(doc, 150);
  const byWidth = new Map([...scales].map(([ref, s]) => [doc.context.lookup(ref).dict.get(PDFName.of("Width")).asNumber(), s]));
  assert.ok(Math.abs(byWidth.get(2000) - (300 / 72) * 150 / 2000) < 1e-6);
  assert.ok(Math.abs(byWidth.get(1600) - (144 / 72) * 150 / 1600) < 1e-6);
}

// Sammenslått sett med samme side to ganger: bildene skal bare finnes én gang.
const merged = await mergePdfs([{ name: "a", bytes: original }, { name: "b", bytes: original }]);
const { bytes, stats } = await compressPdf(merged, { dpi: 150, quality: 0.75, reencode: true }, fakeCodec);
assert.ok(stats.duplicates >= 3, `duplikater: ${stats.duplicates}`);
assert.equal(stats.images, 2);
assert.ok(bytes.length < merged.length / 4, `${merged.length} → ${bytes.length}`);

const out = await PDFDocument.load(bytes);
assert.equal(out.getPageCount(), 2);
const images = out.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")).map(([, o]) => o.dict);
const info = images.map((d) => `${d.get(PDFName.of("Width"))}x${d.get(PDFName.of("Height"))} ${d.get(PDFName.of("Filter"))} ${d.lookup(PDFName.of("ColorSpace")).toString().split(" ").slice(0, 2).join(" ")}`).sort();
assert.deepEqual(info, [
  "300x300 /FlateDecode [ /Indexed",
  "40x40 /FlateDecode /DeviceRGB",
  "625x313 /DCTDecode /DeviceRGB",
]);
// Begge sidene peker på de samme bildene.
const refs = out.getPages().map((p) => p.node.Resources().lookup(PDFName.of("XObject")).toString());
assert.equal(refs[0], refs[1]);

// Utskrift (300 dpi) komprimerer ikke JPEG på nytt, og rører bare bilder som er større enn nødvendig.
const print = await compressPdf(original, { dpi: 300, quality: 0.85, reencode: false }, fakeCodec);
assert.equal(print.stats.images, 2);
assert.ok(print.stats.unused >= 1);

console.log("compress: OK");
