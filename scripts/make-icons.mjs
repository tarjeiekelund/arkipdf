// Lager programikonene fra icon/*.svg: `npm run icons`.
//
// `tauri icon` tegner alle størrelser fra én fil. Det gir et grøtete ikon i
// Utforsker og oppgavelinja, så de små størrelsene i icon.ico tegnes fra egne,
// forenklede filer (tykkere kant, større blad).
import { execSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const icons = "src-tauri/icons";
const tauri = (args) => execSync(`npx tauri icon ${args}`, { stdio: "inherit" });

tauri("icon/app-icon.svg");
// ArkiPDF lages bare for Windows; mobilikonene trengs ikke.
for (const dir of ["android", "ios"]) rmSync(join(icons, dir), { recursive: true, force: true });

const tmp = mkdtempSync(join(tmpdir(), "blad-icons-"));
try {
  tauri(`icon/app-icon-16.svg -o "${tmp}" -p 16`);
  tauri(`icon/app-icon-32.svg -o "${tmp}" -p 24,32`);
  tauri(`icon/app-icon-48.svg -o "${tmp}" -p 48`);
  copyFileSync(join(tmp, "32x32.png"), join(icons, "32x32.png"));

  const pngs = [
    [16, join(tmp, "16x16.png")],
    [24, join(tmp, "24x24.png")],
    [32, join(tmp, "32x32.png")],
    [48, join(tmp, "48x48.png")],
    [64, join(icons, "64x64.png")],
    [128, join(icons, "128x128.png")],
    [256, join(icons, "128x128@2x.png")],
  ].map(([size, file]) => [size, readFileSync(file)]);
  writeFileSync(join(icons, "icon.ico"), ico(pngs));
  console.log(`Skrev ${icons}/icon.ico (${pngs.map(([s]) => s).join(", ")} px)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/** ICO-fil med PNG-bilder (støttes fra Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(([size, png]) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map(([, png]) => png)]);
}
