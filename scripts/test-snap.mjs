// Selvtest av snapping mot en tegning laget med pdf-lib: node --experimental-strip-types scripts/test-snap.mjs
import assert from "node:assert/strict";
import { PDFDocument, rgb } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { SnapIndex } from "../src/snap.ts";

const doc = await PDFDocument.create();
const p = doc.addPage([600, 400]);
// Et rom (rektangel via transform) og en skrå vegg som krysser en vannrett linje.
p.drawRectangle({ x: 100, y: 100, width: 160, height: 120, borderWidth: 1, borderColor: rgb(0, 0, 0) });
p.drawLine({ start: { x: 300, y: 50 }, end: { x: 520, y: 270 }, thickness: 1 });
p.drawLine({ start: { x: 300, y: 150 }, end: { x: 550, y: 150 }, thickness: 1 });
const pdf = await getDocument({ data: await doc.save() }).promise;
const idx = await SnapIndex.build(await pdf.getPage(1));
assert.ok(idx.segmentCount >= 6, `streker: ${idx.segmentCount}`);

const near = (hit, x, y, kind) => {
  assert.ok(hit, "ingen treff");
  assert.equal(hit.kind, kind);
  assert.ok(Math.hypot(hit.p[0] - x, hit.p[1] - y) < 0.01, `${hit.p} ≠ ${x},${y}`);
};
near(idx.query([102, 97], 6), 100, 100, "vertex"); // hjørne
near(idx.query([181, 222], 6), 180, 220, "mid"); // midt på øverste vegg
near(idx.query([401, 148], 6), 400, 150, "cross"); // skjæringspunkt skrå/vannrett
near(idx.query([450, 153], 6), 450, 150, "line"); // et sted på linjen
assert.equal(idx.query([30, 30], 6), null); // ingenting i nærheten
console.log("OK");
