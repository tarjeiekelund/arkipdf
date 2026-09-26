// Kopierer fonter, CMap-er, wasm-dekodere og ICC-profiler fra pdfjs-dist til
// public/pdfjs, så PDF-er med asiatisk tekst, JPEG2000 osv. vises riktig uten nett.
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dest = `${root}public/pdfjs`;
rmSync(dest, { recursive: true, force: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(`${root}node_modules/pdfjs-dist/${dir}`, `${dest}/${dir}`, { recursive: true });
}
