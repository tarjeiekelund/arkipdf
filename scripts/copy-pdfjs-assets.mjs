// Kopierer fonter, CMap-er, wasm-dekodere og ICC-profiler fra pdfjs-dist til
// public/pdfjs, så PDF-er med asiatisk tekst, JPEG2000 osv. vises riktig uten nett.
// Henter også stilene for skjemafelt (.annotationLayer) ut av pdf.js-visningens
// CSS, så feltene ser ut og oppfører seg som i pdf.js, i takt med versjonen.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dest = `${root}public/pdfjs`;
rmSync(dest, { recursive: true, force: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(`${root}node_modules/pdfjs-dist/${dir}`, `${dest}/${dir}`, { recursive: true });
}

const css = readFileSync(`${root}node_modules/pdfjs-dist/web/pdf_viewer.css`, "utf8");
const start = css.indexOf("\n.annotationLayer{");
if (start < 0) throw new Error("Fant ikke .annotationLayer i pdf_viewer.css");
let depth = 0;
let end = start + 1;
for (; end < css.length; end++) {
  if (css[end] === "{") depth++;
  else if (css[end] === "}" && --depth === 0) break;
}
writeFileSync(`${dest}/annotation_layer.css`, `/* Fra pdfjs-dist/web/pdf_viewer.css (Apache-2.0) */\n${css.slice(start + 1, end + 1)}\n`);
