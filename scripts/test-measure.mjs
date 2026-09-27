// Selvtest av målingsberegningene: node --experimental-strip-types scripts/test-measure.mjs
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import {
  centroid,
  formatArea,
  formatLength,
  insidePolygon,
  metersPerPointForScale,
  pathDistance,
  pathLength,
  polygonArea,
  readPdfScales,
  regionAt,
  scaleLabel,
  snap45,
} from "../src/measure-math.ts";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// Et rom på 160 × 120 pt i 1:100 er 5,644 × 4,233 m.
const k = metersPerPointForScale(100);
near(160 * k, 5.644444, 1e-5);
const room = [[0, 0], [160, 0], [160, 120], [0, 120]];
near(polygonArea(room) * k * k, 23.8948, 1e-3);
near(pathLength(room, true) * k, 19.7556, 1e-3);
assert.deepEqual(centroid(room), [80, 60]);
assert.equal(scaleLabel(k), "1:100");
assert.equal(formatLength(5.6444, "m"), "5,64 m");
assert.equal(formatLength(0.85, "mm"), "850 mm");
assert.equal(formatArea(23.891), "23,89 m²");

// Treff på mål (for å velge og dra dem).
assert.equal(insidePolygon([80, 60], room), true);
assert.equal(insidePolygon([200, 60], room), false);
near(pathDistance([80, 5], room, true), 5);
near(pathDistance([-3, 60], room, true), 3);
assert.ok(pathDistance([-3, 60], room, false) > 50); // åpen: venstre side mangler
near(pathDistance([200, 0], [[0, 0], [160, 0]]), 40);

// Shift låser til nærmeste 45°.
const s = snap45([0, 0], [100, 8]);
near(s[1], 0);
const d = snap45([0, 0], [100, 90]);
near(d[0], d[1]);

// Innebygd målestokk leses fra sidens VP-liste.
const doc = await PDFDocument.create();
const p = doc.addPage([2384, 1684]);
doc.addPage([595, 842]);
const ctx = doc.context;
const measure = (den, unit, c) => ctx.obj({ Type: "Measure", Subtype: "RL", R: PDFString.of(`1:${den}`), X: [ctx.obj({ U: PDFString.of(unit), C: c })] });
p.node.set(PDFName.of("VP"), ctx.obj([
  ctx.obj({ Type: "Viewport", BBox: [50, 50, 2334, 1634], Measure: measure(100, "m", k) }),
  ctx.obj({ Type: "Viewport", BBox: [1800, 100, 2300, 500], Measure: measure(20, "mm", metersPerPointForScale(20) * 1000) }),
]));
const scales = await readPdfScales(await doc.save());
assert.equal(scales.size, 1);
const regions = scales.get(0);
assert.equal(regions.length, 2);
near(regionAt(regions, [500, 500]).metersPerPoint, k);
assert.equal(regionAt(regions, [500, 500]).label, "1:100");
// Detaljområdet ligger inne i planen; minste område vinner.
near(regionAt(regions, [2000, 300]).metersPerPoint, metersPerPointForScale(20));
assert.equal(regionAt(regions, [10, 10]), null);
console.log("OK");
