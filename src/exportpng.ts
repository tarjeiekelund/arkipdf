// Eksport av sider til PNG-bilder.
import { parsePageRange, renderPageToCanvas, type PDFDocumentProxy } from "./pdf";
import { dirName, joinPath, pickFolder, writeFile } from "./platform";
import { busy, button, errorMessage, h, modal, nextFrame, toast } from "./ui";

export function openExportDialog(doc: PDFDocumentProxy, filePath: string, currentPage: number): void {
  const n = doc.numPages;
  const radio = (value: string, label: string, checked = false) =>
    h("label", { class: "radio" }, h("input", { type: "radio", name: "pages", value, checked }), label);

  const rangeInput = h("input", { type: "text", placeholder: `f.eks. 1-3, 7`, class: "range" });
  const rangeRadio = radio("range", "Sider:");
  rangeRadio.append(rangeInput);
  rangeInput.addEventListener("focus", () => ((rangeRadio.querySelector("input") as HTMLInputElement).checked = true));

  const dpi = h(
    "select",
    {},
    h("option", { value: "96" }, "96 DPI – skjerm, små filer"),
    h("option", { value: "150", selected: true }, "150 DPI – god kvalitet"),
    h("option", { value: "300" }, "300 DPI – utskrift"),
    h("option", { value: "600" }, "600 DPI – svært høy"),
  );

  const body = h(
    "div",
    { class: "form" },
    h("fieldset", {}, h("legend", {}, "Hvilke sider?"), radio("all", `Alle (${n})`, true), radio("current", `Denne siden (${currentPage + 1})`), rangeRadio),
    h("label", { class: "field" }, h("span", {}, "Oppløsning"), dpi),
    h("p", { class: "muted" }, "Du velger mappe i neste steg. Hver side blir én PNG-fil."),
  );

  const go = async () => {
    const choice = (body.querySelector("input[name=pages]:checked") as HTMLInputElement).value;
    let pages: number[];
    try {
      pages = choice === "all" ? [...Array(n).keys()] : choice === "current" ? [currentPage] : parsePageRange(rangeInput.value, n);
    } catch (e) {
      toast(errorMessage(e), "error");
      rangeInput.focus();
      return;
    }
    const folder = await pickFolder("Velg mappe for PNG-filene", dirName(filePath) || undefined);
    if (folder === null) return;
    close();
    await exportPages(doc, filePath, pages, Number(dpi.value), folder);
  };

  const close = modal("Eksporter til PNG", body, [button("Avbryt", null, () => close()), button("Velg mappe og eksporter…", "image", () => void go(), { primary: true })]);
}

async function exportPages(doc: PDFDocumentProxy, filePath: string, pages: number[], dpi: number, folder: string): Promise<void> {
  const stem = (filePath.split(/[\\/]/).pop() ?? "dokument").replace(/\.pdf$/i, "");
  const digits = Math.max(2, String(doc.numPages).length);
  const b = busy("Eksporterer…");
  let written = 0;
  try {
    for (const idx of pages) {
      if (b.cancelled()) break;
      b.update(`Eksporterer side ${idx + 1} (${written + 1} av ${pages.length})`, written / pages.length);
      await nextFrame();
      const page = await doc.getPage(idx + 1);
      const canvas = document.createElement("canvas");
      const job = await renderPageToCanvas(page, canvas, dpi / 72, 1, 0, 120_000_000);
      await job.done;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error("Klarte ikke å lage bildet");
      const name = `${stem}-side-${String(idx + 1).padStart(digits, "0")}.png`;
      await writeFile(joinPath(folder, name), new Uint8Array(await blob.arrayBuffer()));
      written++;
    }
    toast(`${written} ${written === 1 ? "bilde" : "bilder"} lagret${folder ? ` i ${folder}` : ""}`, "success");
  } catch (e) {
    toast(`Eksport feilet: ${errorMessage(e)}`, "error");
  } finally {
    b.done();
  }
}
