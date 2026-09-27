// Lager programikonene fra branding/*.svg: `npm run icons`.
//
// Masteren (arkipdf-ikon.svg) brukes fra 32 px og opp. 16 og 24 px har egne,
// pikseltilpassede filer, så ikonet er skarpt i Utforsker og oppgavelinja.
// icon.ico får 16, 24, 32, 48 og 256 px (se branding/BRAND.md).
import { execSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const icons = "src-tauri/icons";
const master = "branding/arkipdf-ikon.svg";
const tauri = (args) => execSync(`npx tauri icon ${args}`, { stdio: "inherit" });

tauri(master);
// ArkiPDF lages bare for Windows; mobilikonene trengs ikke.
for (const dir of ["android", "ios"]) rmSync(join(icons, dir), { recursive: true, force: true });

const tmp = mkdtempSync(join(tmpdir(), "arkipdf-icons-"));
try {
  tauri(`branding/arkipdf-ikon-16.svg -o "${tmp}" -p 16`);
  tauri(`branding/arkipdf-ikon-24.svg -o "${tmp}" -p 24`);
  tauri(`${master} -o "${tmp}" -p 32,48,256`);
  copyFileSync(join(tmp, "32x32.png"), join(icons, "32x32.png"));

  const pngs = [16, 24, 32, 48, 256].map((size) => [size, readFileSync(join(tmp, `${size}x${size}.png`))]);
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
