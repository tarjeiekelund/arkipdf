// Selvtest av målingsberegningene: node --experimental-strip-types scripts/test-measure.mjs
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import {
  centroid,
  formatArea,
  formatLength,
  insertionPoint,
  insidePolygon,
  metersPerPointForScale,
  pathDistance,
  pathLength,
  polygonArea,
  readPdfScales,
  regionAt,
  scaleLabel,
  snap45,
  lockDirection,
  lockVertex,
  rectFrom,
  offsetEdge,
  setEdgeLength,
  offsetPath,
  circlePoints,
  parseNumber,
  parsePages,
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
// Nytt punkt (dobbeltklikk på en kant) havner på kanten, i riktig rekkefølge.
assert.deepEqual(insertionPoint([80, 3], room, true), { index: 1, p: [80, 0] });
assert.deepEqual(insertionPoint([163, 60], room, true), { index: 2, p: [160, 60] });
assert.deepEqual(insertionPoint([-2, 60], room, true), { index: 4, p: [0, 60] });
assert.deepEqual(insertionPoint([50, 2], [[0, 0], [100, 0], [100, 100]]), { index: 1, p: [50, 0] });

// Shift låser til nærmeste 45°.
const s = snap45([0, 0], [100, 8]);
near(s[1], 0);
const d = snap45([0, 0], [100, 90]);
near(d[0], d[1]);

// Shift videre fra en kant: 90° på forrige kant, også når den er skrå.
const skew = lockDirection([10, 10], [10 - 20, 10 + 50], Math.PI / 6, Math.PI / 2);
near(Math.atan2(skew[1] - 10, skew[0] - 10), Math.PI / 6 + Math.PI / 2);
const flat = lockDirection([0, 0], [100, 8], 0, Math.PI / 4);
near(flat[0], 100);
near(flat[1], 0);
// Shift når et hjørne dras: begge kantene forblir rette (rektangelet holdes).
const pt = (p) => p.map((v) => Math.round(v * 1e6) / 1e6);
assert.deepEqual(pt(lockVertex(room, 2, true, [163, 124], 10)), [160, 120]);
near(lockVertex(room, 2, true, [200, 125], 10)[1], 120); // langt unna hjørnet: låst til én kant

// Rektangel fra tre klikk: første side og bredden.
assert.deepEqual(rectFrom([0, 0], [160, 0], [140, 120]), [[0, 0], [160, 0], [160, 120], [0, 120]]);
const tilted = rectFrom([0, 0], [30, 40], [0, 100]);
near(polygonArea(tilted), 50 * 60);

// Dra en kant: den flyttes parallelt, og nabokantene beholder retningen.
const moved = offsetEdge(room, 1, 40, true); // høyre side (160,0)–(160,120), venstrenormal peker mot −x
assert.deepEqual(moved.map(pt), [[0, 0], [120, 0], [120, 120], [0, 120]]);
const trap = [[0, 0], [100, 0], [80, 50], [20, 50]];
const up = offsetEdge(trap, 2, -10, true).map(pt); // toppen flyttes 10 opp
assert.deepEqual(up[2], [76, 60]);
assert.deepEqual(up[3], [24, 60]);
// Åpen linje: endepunktet flyttes rett.
assert.deepEqual(offsetEdge([[0, 0], [100, 0]], 0, 10, false).map(pt), [[0, 10], [100, 10]]);

// Skriv inn en sidelengde: rektangelet forblir rektangel.
assert.deepEqual(setEdgeLength(room, 0, 200, true), [[0, 0], [200, 0], [200, 120], [0, 120]]);
assert.deepEqual(setEdgeLength([[0, 0], [10, 0], [10, 10]], 0, 20, false), [[0, 0], [20, 0], [20, 10]]);

// Forskyv kontur: utover er positivt uansett tegneretning.
assert.deepEqual(offsetPath(room, 10, true).map(pt), [[-10, -10], [170, -10], [170, 130], [-10, 130]]);
assert.deepEqual(offsetPath([...room].reverse(), 10, true).map(pt), [[-10, 130], [170, 130], [170, -10], [-10, -10]]);
assert.deepEqual(offsetPath(room, -10, true).map(pt), [[10, 10], [150, 10], [150, 110], [10, 110]]);
assert.deepEqual(offsetPath([[0, 0], [100, 0], [100, 100]], 10, false).map(pt), [[0, 10], [90, 10], [90, 100]]);

// Sirkel.
near(polygonArea(circlePoints([0, 0], 100, 720)), Math.PI * 100 * 100, 50);

// Tall og sider som skrives inn.
assert.equal(parseNumber("12,5"), 12.5);
assert.equal(parseNumber(" 4 "), 4);
assert.equal(parseNumber("4,"), 4);
assert.equal(parseNumber("abc"), null);
assert.deepEqual(parsePages("2, 4-5", 6), [1, 3, 4]);
assert.deepEqual(parsePages("alle", 3), [0, 1, 2]);
assert.equal(parsePages("7", 6), null);

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
