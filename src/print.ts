// Utskrift (Ctrl+P).
//
// Vanligvis sendes PDF-en rett til den innebygde PDF-motoren i WebView2
// (Edge). Da skrives linjene ut som vektorer, knivskarpt også på stort
// format, og utskriftsdialogen gir valg mellom «Faktisk størrelse» (riktig
// målestokk) og «Tilpass». Finnes ikke PDF-motoren, tegnes sidene som bilder
// i stedet, med riktig papirformat for hver side.
import { extractPages } from "./edit";
import { parsePageRange, renderPageToCanvas, type PDFDocumentProxy } from "./pdf";
import { busy, button, errorMessage, h, modal, nextFrame, toast } from "./ui";

/** Største bilde per side ved bildeutskrift (piksler). */
const RASTER_MAX_PIXELS = 100_000_000;

let cleanup: (() => void) | null = null;

const vectorSupported = () => (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled === true;

export function openPrintDialog(doc: PDFDocumentProxy, bytes: Uint8Array, name: string, currentPage: number): void {
  const n = doc.numPages;
  const radio = (group: string, value: string, label: string, checked = false) =>
    h("label", { class: "radio" }, h("input", { type: "radio", name: group, value, checked }), label);

  const rangeInput = h("input", { type: "text", placeholder: "f.eks. 1-3, 7", class: "range" });
  const rangeRadio = radio("print-pages", "range", "Sider:");
  rangeRadio.append(rangeInput);
  rangeInput.addEventListener("focus", () => ((rangeRadio.querySelector("input") as HTMLInputElement).checked = true));

  const vector = vectorSupported();
  const quality = h(
    "select",
    { "aria-label": "Kvalitet" },
    h("option", { value: "150", selected: true }, "Standard (150 DPI)"),
    h("option", { value: "300" }, "Høy (300 DPI) – tregt for store ark"),
  );
  const qualityField = h("label", { class: "field" }, h("span", {}, "Bildekvalitet"), quality);
  const methodSet = h(
    "fieldset",
    {},
    h("legend", {}, "Utskriftsmetode"),
    radio("print-method", "vector", "Vektor – skarpe linjer, riktig målestokk (anbefalt)", vector),
    radio("print-method", "raster", "Som bilder – reserve hvis skriveren har problemer", !vector),
  );
  if (!vector) (methodSet.querySelector("input[value=vector]") as HTMLInputElement).disabled = true;
  const syncMethod = () => {
    qualityField.hidden = (methodSet.querySelector("input:checked") as HTMLInputElement).value !== "raster";
  };
  methodSet.addEventListener("change", syncMethod);
  syncMethod();

  const body = h(
    "div",
    { class: "form" },
    h("fieldset", {}, h("legend", {}, "Hvilke sider?"), radio("print-pages", "all", `Alle (${n})`, true), radio("print-pages", "current", `Denne siden (${currentPage + 1})`), rangeRadio),
    methodSet,
    qualityField,
    h(
      "div",
      { class: "note" },
      h("strong", {}, "Målestokk: "),
      "Velg «Faktisk størrelse» (eller skala 100 %) i utskriftsdialogen for at tegningen skal skrives ut i riktig målestokk. «Tilpass» krymper eller forstørrer den til arket.",
    ),
  );

  const go = async () => {
    const choice = (body.querySelector("input[name=print-pages]:checked") as HTMLInputElement).value;
    const method = (body.querySelector("input[name=print-method]:checked") as HTMLInputElement).value;
    let pages: number[];
    try {
      pages = choice === "all" ? [...Array(n).keys()] : choice === "current" ? [currentPage] : parsePageRange(rangeInput.value, n);
    } catch (e) {
      toast(errorMessage(e), "error");
      rangeInput.focus();
      return;
    }
    close();
    if (method === "vector") await printVector(bytes, name, pages, n);
    else await printRaster(doc, pages, Number(quality.value));
  };

  const close = modal("Skriv ut", body, [button("Avbryt", null, () => close()), button("Skriv ut…", "print", () => void go(), { primary: true })]);
}

/** Sender (et utvalg av) PDF-en til den innebygde PDF-motoren for utskrift. */
async function printVector(bytes: Uint8Array, name: string, pages: number[], total: number): Promise<void> {
  cleanup?.();
  const b = busy("Klargjør utskrift…");
  let data: Uint8Array;
  try {
    const all = pages.length === total && pages.every((p, i) => p === i);
    data = all ? bytes : await extractPages(bytes, pages, name);
  } catch (e) {
    b.done();
    toast(`Utskrift feilet: ${errorMessage(e)}`, "error");
    return;
  }
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/pdf" }));
  const frame = h("iframe", { class: "print-frame", title: "Utskrift", "aria-hidden": "true" });
  const done = () => {
    frame.remove();
    URL.revokeObjectURL(url);
    cleanup = null;
  };
  cleanup = done;
  frame.addEventListener("load", () => {
    // PDF-motoren trenger et øyeblikk etter lasting før den kan skrive ut.
    setTimeout(() => {
      b.done();
      try {
        frame.contentWindow!.focus();
        frame.contentWindow!.print();
      } catch (e) {
        toast(`Utskrift feilet: ${errorMessage(e)}. Prøv «Som bilder».`, "error");
      }
    }, 600);
  });
  frame.src = url;
  document.body.append(frame);
}

/** Tegner sidene som bilder, med riktig papirformat per side. */
async function printRaster(doc: PDFDocumentProxy, pages: number[], dpi: number): Promise<void> {
  cleanup?.();
  const b = busy("Klargjør utskrift…");
  const urls: string[] = [];
  const container = h("div", { id: "print-container" });
  const style = h("style");
  const done = () => {
    container.remove();
    style.remove();
    for (const u of urls) URL.revokeObjectURL(u);
    cleanup = null;
  };
  // Én navngitt @page per arkstørrelse, så A1- og A3-sider får hvert sitt format.
  const sizes = new Map<string, string>();
  let lowestDpi = dpi;
  try {
    for (let k = 0; k < pages.length; k++) {
      if (b.cancelled()) return done();
      b.update(`Klargjør side ${pages[k] + 1} (${k + 1} av ${pages.length})`, k / pages.length);
      await nextFrame();
      const page = await doc.getPage(pages[k] + 1);
      const vp = page.getViewport({ scale: 1 });
      const key = `${Math.round(vp.width)}x${Math.round(vp.height)}`;
      if (!sizes.has(key)) sizes.set(key, `p${sizes.size}`);
      const pixels = ((vp.width * dpi) / 72) * ((vp.height * dpi) / 72);
      if (pixels > RASTER_MAX_PIXELS) lowestDpi = Math.min(lowestDpi, Math.floor(dpi * Math.sqrt(RASTER_MAX_PIXELS / pixels)));

      const canvas = document.createElement("canvas");
      const job = await renderPageToCanvas(page, canvas, dpi / 72, 1, 0, RASTER_MAX_PIXELS);
      await job.done;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error("Klarte ikke å tegne siden");
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = h("img", { src: url, alt: "" });
      await img.decode();
      container.append(h("div", { class: `print-page ${sizes.get(key)}` }, img));
    }
    style.textContent = [...sizes]
      .map(([key, cls]) => {
        const [w, hgt] = key.split("x");
        return `@page ${cls} { size: ${w}pt ${hgt}pt; margin: 0; } .print-page.${cls} { page: ${cls}; width: ${w}pt; height: ${hgt}pt; }`;
      })
      .join("\n");
  } catch (e) {
    toast(`Utskrift feilet: ${errorMessage(e)}`, "error");
    return done();
  } finally {
    b.done();
  }
  if (lowestDpi < dpi) toast(`Store ark skrives ut med ca. ${lowestDpi} DPI (grensen for bildeutskrift). Bruk vektorutskrift for full skarphet.`, "info");
  document.head.append(style);
  document.body.append(container);
  cleanup = done;
  // Utskriftsflaten er usynlig på skjermen, så den kan ryddes når dialogen lukkes.
  window.addEventListener("afterprint", () => setTimeout(() => cleanup === done && done(), 500), { once: true });
  await nextFrame();
  window.print();
}
