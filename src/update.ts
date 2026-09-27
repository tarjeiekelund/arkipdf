// Varsel om nye versjoner: spør GitHub om siste release (maks én gang i døgnet)
// og viser en liten melding hvis den er nyere enn denne. Ingen automatisk
// installasjon; «Last ned» henter installeren i nettleseren.
import { getVersion } from "@tauri-apps/api/app";
import { isTauri, openUrl } from "./platform";
import { button, h } from "./ui";
import { compareVersions } from "./version";

const REPO = "tarjeiekelund/arkipdf";
const DAY = 24 * 60 * 60 * 1000;

export interface Release {
  version: string;
  /** Installeren, eller release-siden hvis den mangler. */
  download: string;
  page: string;
}

export async function latestRelease(): Promise<Release | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    // 404 når repoet er privat eller ingen release finnes.
    if (!res.ok) return null;
    const r = await res.json();
    if (typeof r.tag_name !== "string") return null;
    const exe = (r.assets ?? []).find((a: { name?: string }) => /setup\.exe$/i.test(a.name ?? ""));
    return { version: r.tag_name.replace(/^v/i, ""), download: exe?.browser_download_url ?? r.html_url, page: r.html_url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      // Uten lagring spør vi bare oftere.
    }
  },
};

/** Sjekker i bakgrunnen ved oppstart. Gjør ingenting uten nett eller utenfor Windows-appen. */
export async function checkForUpdates(): Promise<void> {
  if (!isTauri) return;
  const last = Number(store.get("update-checked") ?? 0);
  if (Date.now() - last < DAY) return;
  const [current, latest] = await Promise.all([getVersion(), latestRelease()]);
  if (!latest) return;
  store.set("update-checked", String(Date.now()));
  if (compareVersions(latest.version, current) <= 0 || store.get("update-skip") === latest.version) return;
  showNotice(latest, current);
}

export function showNotice(r: Release, current: string): void {
  const close = () => el.remove();
  const el = h(
    "div",
    { class: "update-notice", role: "status" },
    h("div", { class: "update-text" }, h("strong", {}, `ArkiPDF ${r.version} er klar`), h("span", { class: "muted" }, `Du har ${current}. Last ned og kjør installeren; den erstatter den gamle versjonen.`)),
    h(
      "div",
      { class: "update-actions" },
      button("Hva er nytt?", null, () => void openUrl(r.page), { className: "ghost" }),
      button("Hopp over", null, () => {
        store.set("update-skip", r.version);
        close();
      }, { title: "Ikke vis dette for denne versjonen igjen" }),
      button("Last ned", null, () => {
        void openUrl(r.download);
        close();
      }, { primary: true }),
    ),
    button("", "close", close, { title: "Lukk (spør igjen i morgen)", className: "ghost update-close" }),
  );
  document.body.append(el);
}
