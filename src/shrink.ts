// Dialogen for «Reduser filstørrelse». Selve jobben gjøres i compress.ts.
import { browserCodec, compressPdf, PRESETS } from "./compress";
import { busy, button, errorMessage, h, modal, nextFrame, toast } from "./ui";

export function formatSize(bytes: number): string {
  const nb = (n: number, d: number) => n.toLocaleString("nb-NO", { maximumFractionDigits: d });
  if (bytes >= 1e6) return `${nb(bytes / 1e6, 1)} MB`;
  return `${nb(Math.max(1, Math.round(bytes / 1e3)), 0)} kB`;
}

type Preset = keyof typeof PRESETS;
let lastPreset: Preset = "screen";

export function openShrinkDialog(bytes: Uint8Array, name: string, onDone: (out: Uint8Array) => Promise<void>): void {
  const option = (value: Preset, title: string, detail: string) =>
    h(
      "label",
      { class: "choice" },
      h("input", { type: "radio", name: "shrink-preset", value, checked: value === lastPreset }),
      h("span", {}, h("strong", {}, title), h("span", { class: "muted" }, detail)),
    );
  const body = h(
    "div",
    { class: "shrink" },
    h("p", {}, `${name} er ${formatSize(bytes.length)}.`),
    option("screen", "Skjerm og e-post", "Bilder skaleres ned til 150 dpi slik de står på arket. Gir minst fil."),
    option("print", "Utskrift", "Bilder skaleres ned til 300 dpi. Beholder full utskriftskvalitet."),
    h("p", { class: "muted" }, "Linjer, tekst og mål er vektorer og røres ikke. Du ser resultatet før du lagrer, og Ctrl+Z angrer."),
  );

  const run = async () => {
    const preset = (body.querySelector("input:checked") as HTMLInputElement).value as Preset;
    lastPreset = preset;
    close();
    const b = busy("Leser dokumentet…");
    await nextFrame();
    try {
      const { bytes: out, stats } = await compressPdf(bytes, PRESETS[preset], browserCodec, (done, total) => {
        if (total) b.update(`Behandler bilder (${done} av ${total})`, done / total);
      });
      if (b.cancelled()) return;
      const saved = 1 - stats.after / stats.before;
      if (saved < 0.02) {
        toast(`Fila er allerede kompakt (${formatSize(stats.before)}). Ingenting ble endret.`);
        return;
      }
      b.update("Åpner resultatet…");
      await onDone(out);
      const parts = [`${formatSize(stats.before)} → ${formatSize(stats.after)} (−${Math.round(saved * 100)} %)`];
      if (stats.images) parts.push(`${stats.images} ${stats.images === 1 ? "bilde" : "bilder"} komprimert`);
      if (stats.duplicates) parts.push(`${stats.duplicates} duplikater fjernet`);
      if (stats.skipped) parts.push(`${stats.skipped} ${stats.skipped === 1 ? "bilde" : "bilder"} i formater som ikke støttes, beholdt`);
      toast(`${parts.join(" · ")}. Lagre for å beholde endringen.`, "success");
    } catch (e) {
      toast(`Kunne ikke redusere filstørrelsen: ${errorMessage(e)}`, "error");
    } finally {
      b.done();
    }
  };

  const close = modal("Reduser filstørrelse", body, [button("Avbryt", null, () => close()), button("Reduser", "shrink", () => void run(), { primary: true })]);
}
