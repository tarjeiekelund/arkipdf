// Utskrift (Ctrl+P): sidene tegnes som bilder i en egen utskriftsflate og
// sendes til Windows' vanlige utskriftsdialog.
import { parsePageRange, renderPageToCanvas, type PDFDocumentProxy } from "./pdf";
import { busy, button, errorMessage, h, modal, nextFrame, toast } from "./ui";

let cleanup: (() => void) | null = null;

export function openPrintDialog(doc: PDFDocumentProxy, currentPage: number): void {
  const n = doc.numPages;
  const radio = (value: string, label: string, checked = false) =>
    h("label", { class: "radio" }, h("input", { type: "radio", name: "print-pages", value, checked }), label);

  const rangeInput = h("input", { type: "text", placeholder: "f.eks. 1-3, 7", class: "range" });
  const rangeRadio = radio("range", "Sider:");
  rangeRadio.append(rangeInput);
  rangeInput.addEventListener("focus", () => ((rangeRadio.querySelector("input") as HTMLInputElement).checked = true));

  const quality = h(
    "select",
    {},
    h("option", { value: "150", selected: true }, "Standard (150 DPI)"),
    h("option", { value: "300" }, "Høy kvalitet (300 DPI) – tregere"),
  );

  const body = h(
    "div",
    { class: "form" },
    h("fieldset", {}, h("legend", {}, "Hvilke sider?"), radio("all", `Alle (${n})`, true), radio("current", `Denne siden (${currentPage + 1})`), rangeRadio),
    h("label", { class: "field" }, h("span", {}, "Kvalitet"), quality),
    h("p", { class: "muted" }, "Skriver, antall kopier og papir velger du i utskriftsdialogen som kommer etterpå."),
  );

  const go = async () => {
    const choice = (body.querySelector("input[name=print-pages]:checked") as HTMLInputElement).value;
    let pages: number[];
    try {
      pages = choice === "all" ? [...Array(n).keys()] : choice === "current" ? [currentPage] : parsePageRange(rangeInput.value, n);
    } catch (e) {
      toast(errorMessage(e), "error");
      rangeInput.focus();
      return;
    }
    close();
    await printPages(doc, pages, Number(quality.value));
  };

  const close = modal("Skriv ut", body, [button("Avbryt", null, () => close()), button("Skriv ut…", "print", () => void go(), { primary: true })]);
}

async function printPages(doc: PDFDocumentProxy, pages: number[], dpi: number): Promise<void> {
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
  try {
    let pageSize = "";
    for (let k = 0; k < pages.length; k++) {
      if (b.cancelled()) return done();
      b.update(`Klargjør side ${pages[k] + 1} (${k + 1} av ${pages.length})`, k / pages.length);
      await nextFrame();
      const page = await doc.getPage(pages[k] + 1);
      const vp = page.getViewport({ scale: 1 });
      // Papirstørrelsen følger første side; resten skaleres inn på samme ark.
      if (!pageSize) pageSize = `${vp.width}pt ${vp.height}pt`;
      const canvas = document.createElement("canvas");
      const job = await renderPageToCanvas(page, canvas, dpi / 72, 1, 0, 60_000_000);
      await job.done;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error("Klarte ikke å tegne siden");
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = h("img", { src: url, alt: "" });
      await img.decode();
      container.append(h("div", { class: "print-page" }, img));
    }
    style.textContent = `@page { size: ${pageSize}; margin: 0; }`;
  } catch (e) {
    toast(`Utskrift feilet: ${errorMessage(e)}`, "error");
    return done();
  } finally {
    b.done();
  }
  document.head.append(style);
  document.body.append(container);
  cleanup = done;
  // Utskriftsflaten er usynlig på skjermen, så den kan ryddes når dialogen lukkes.
  window.addEventListener("afterprint", () => setTimeout(() => cleanup === done && done(), 500), { once: true });
  await nextFrame();
  window.print();
}
