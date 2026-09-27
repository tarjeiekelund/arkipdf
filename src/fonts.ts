// Finner Windows-fonten som svarer til en font i PDF-en, så redigert tekst får
// samme skrift. PDF-er bruker PostScript-navn («Arial-BoldMT»), Windows filnavn
// («arialbd.ttf»); de vanligste er kartlagt, ellers prøves navnet som filnavn
// (vanlig for fonter man har installert selv).
import { cleanFontName } from "./textedit-pdf";

/** Filnavn for [vanlig, fet, kursiv, fet kursiv]. */
const FAMILIES: Record<string, [string, string, string, string]> = {
  arial: ["arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"],
  helvetica: ["arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"],
  arialnarrow: ["arialn.ttf", "arialnb.ttf", "arialni.ttf", "arialnbi.ttf"],
  helveticanarrow: ["arialn.ttf", "arialnb.ttf", "arialni.ttf", "arialnbi.ttf"],
  calibri: ["calibri.ttf", "calibrib.ttf", "calibrii.ttf", "calibriz.ttf"],
  calibrilight: ["calibril.ttf", "calibrib.ttf", "calibrili.ttf", "calibriz.ttf"],
  timesnewroman: ["times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf"],
  times: ["times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf"],
  verdana: ["verdana.ttf", "verdanab.ttf", "verdanai.ttf", "verdanaz.ttf"],
  tahoma: ["tahoma.ttf", "tahomabd.ttf", "tahoma.ttf", "tahomabd.ttf"],
  segoeui: ["segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf", "segoeuiz.ttf"],
  segoeuisemibold: ["seguisb.ttf", "seguisb.ttf", "seguisbi.ttf", "seguisbi.ttf"],
  segoeuilight: ["segoeuil.ttf", "segoeuib.ttf", "seguili.ttf", "segoeuiz.ttf"],
  couriernew: ["cour.ttf", "courbd.ttf", "couri.ttf", "courbi.ttf"],
  courier: ["cour.ttf", "courbd.ttf", "couri.ttf", "courbi.ttf"],
  consolas: ["consola.ttf", "consolab.ttf", "consolai.ttf", "consolaz.ttf"],
  georgia: ["georgia.ttf", "georgiab.ttf", "georgiai.ttf", "georgiaz.ttf"],
  trebuchet: ["trebuc.ttf", "trebucbd.ttf", "trebucit.ttf", "trebucbi.ttf"],
  centurygothic: ["GOTHIC.TTF", "GOTHICB.TTF", "GOTHICI.TTF", "GOTHICBI.TTF"],
  garamond: ["GARA.TTF", "GARABD.TTF", "GARAIT.TTF", "GARABD.TTF"],
  franklingothicbook: ["FRABK.TTF", "FRADM.TTF", "FRABKIT.TTF", "FRADMIT.TTF"],
  franklingothicmedium: ["framd.ttf", "FRADM.TTF", "framdit.ttf", "FRADMIT.TTF"],
  // CAD-fonter som AutoCAD o.l. installerer.
  isocpeur: ["isocpeur.ttf", "isocpeur.ttf", "isocpeui.ttf", "isocpeui.ttf"],
  isocp: ["isocp.ttf", "isocp.ttf", "isocp.ttf", "isocp.ttf"],
  isoct: ["isoct.ttf", "isoct.ttf", "isoct.ttf", "isoct.ttf"],
  isocteur: ["isocteur.ttf", "isocteur.ttf", "isocteui.ttf", "isocteui.ttf"],
  romans: ["romans__.ttf", "romans__.ttf", "romans__.ttf", "romans__.ttf"],
  swiss721: ["arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"],
};

/** Kandidater (filnavn) for en PDF-font, mest sannsynlig først. */
export function fontFiles(pdfName: string): string[] {
  const base = cleanFontName(pdfName);
  const bold = /bold|black|heavy|demi|semibold/i.test(base);
  const italic = /italic|oblique|it$/i.test(base.replace(/^[^-,]*/, ""));
  const style = (bold ? 1 : 0) + (italic ? 2 : 0);
  let family = base.replace(/[-,].*$/, "").toLowerCase().replace(/\s+/g, "");
  family = family.replace(/(psmt|mt|ps)$/, "");
  // «Calibri-Light», «SegoeUI-Semibold»: vekten er en egen fil.
  const weight = /light/i.test(base) ? "light" : /semibold/i.test(base) ? "semibold" : "";
  const out: string[] = [];
  const fam = FAMILIES[family + weight] ?? FAMILIES[family];
  if (fam) out.push(fam[style], fam[0]);
  out.push(`${base}.ttf`, `${base}.otf`, `${family}.ttf`);
  return [...new Set(out)];
}
