// «Slå sammen»: velg filer, bestem rekkefølge og sett dem sammen til én PDF.
// Resultatet åpnes som et ulagret dokument, så det kan ses over og justeres
// før det lagres.
import { mergePdfs } from "./edit";
import { baseName, dirName, joinPath, pickPdfs, readFile } from "./platform";
import { busy, button, errorMessage, h, icon, modal, nextFrame, toast } from "./ui";

export function openMergeDialog(initial: string[], onMerged: (bytes: Uint8Array, suggestedPath: string) => void): void {
  const files = [...initial];
  const list = h("ol", { class: "file-list" });
  const empty = h("p", { class: "muted empty-list" }, "Ingen filer valgt ennå.");

  const render = () => {
    list.replaceChildren(
      ...files.map((path, i) => {
        const up = button("", "up", () => move(i, -1), { title: "Flytt opp", className: "ghost" });
        const down = button("", "down", () => move(i, 1), { title: "Flytt ned", className: "ghost" });
        const del = button("", "close", () => {
          files.splice(i, 1);
          render();
        }, { title: "Fjern fra lista", className: "ghost" });
        up.disabled = i === 0;
        down.disabled = i === files.length - 1;
        return h(
          "li",
          {},
          h("span", { class: "num" }, String(i + 1)),
          h("span", { class: "file-icon", html: icon("file") }),
          h("span", { class: "file-name", title: path }, baseName(path)),
          up,
          down,
          del,
        );
      }),
    );
    empty.hidden = files.length > 0;
    mergeBtn.disabled = files.length < 2;
  };

  const move = (i: number, dir: number) => {
    const j = i + dir;
    if (j < 0 || j >= files.length) return;
    [files[i], files[j]] = [files[j], files[i]];
    render();
  };

  const add = async () => {
    const picked = await pickPdfs(true);
    files.push(...picked);
    render();
  };

  const mergeBtn = button("Slå sammen", "merge", async () => {
    const target = joinPath(dirName(files[0]), "Sammenslått.pdf");
    close();
    const b = busy("Leser filer…");
    try {
      const loaded = [];
      for (let i = 0; i < files.length; i++) {
        if (b.cancelled()) return;
        b.update(`Leser ${baseName(files[i])} (${i + 1} av ${files.length})`, i / files.length / 2);
        await nextFrame();
        loaded.push({ name: baseName(files[i]), bytes: await readFile(files[i]) });
      }
      const out = await mergePdfs(loaded, (n) => b.update(`Slår sammen (${n} av ${files.length})`, 0.5 + n / files.length / 2));
      if (b.cancelled()) return;
      onMerged(out, target);
    } catch (e) {
      toast(`Kunne ikke slå sammen: ${errorMessage(e)}`, "error");
    } finally {
      b.done();
    }
  }, { primary: true });

  const body = h(
    "div",
    { class: "merge" },
    h("p", { class: "muted" }, "Filene settes sammen i rekkefølgen under. Du ser resultatet før du lagrer. Du kan også dra PDF-filer inn i vinduet."),
    list,
    empty,
    button("Legg til filer…", "plus", () => void add()),
  );
  const close = modal("Slå sammen PDF-er", body, [button("Avbryt", null, () => close()), mergeBtn]);
  render();
  if (!files.length) void add();
}
