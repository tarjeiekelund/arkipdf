// Små byggeklosser for grensesnittet: ikoner, meldinger og dialoger.

const paths: Record<string, string> = {
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  merge: '<rect x="3" y="3" width="11" height="14" rx="1.5"/><path d="M10 7h9.5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5H10"/><path d="M14 14h4m-2-2v4"/>',
  organize: '<rect x="3" y="3" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="8" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
  present: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><path d="m10 8 5 2.5-5 2.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fitWidth: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  fitPage: '<rect x="6" y="3" width="12" height="18" rx="1.5"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  rotateLeft: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  rotateRight: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v6h8V3M7 21v-7h10v7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  pointer: '<path d="M5 3l6.5 17 2.4-7.1L21 10.5z"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  caret: '<path d="m7 10 5 5 5-5"/>',
  ruler: '<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
  polyline: '<path d="M3 18 9 8l6 7 6-10"/><circle cx="3" cy="18" r="1.3"/><circle cx="9" cy="8" r="1.3"/><circle cx="15" cy="15" r="1.3"/><circle cx="21" cy="5" r="1.3"/>',
  area: '<path d="M4 7 12 3l8 5-2 11H6z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
};

export function icon(name: keyof typeof paths | string): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}

/** Merket: arket med huset i snitt (samme som programikonet, icon/app-icon.svg). */
export function logo(): string {
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M26 6H64L82 24V88A6 6 0 0 1 76 94H26A6 6 0 0 1 20 88V12A6 6 0 0 1 26 6Z" fill="#fff" stroke="#aeb9b5" stroke-width="1.5"/><path d="M64 6V18A6 6 0 0 0 70 24H82Z" fill="#e1e7e4" stroke="#aeb9b5" stroke-width="1.5" stroke-linejoin="round"/><path d="M30 59L51 38L72 59H67V82H35V59Z" fill="#1f6f5c"/><rect x="47" y="68" width="8" height="14" fill="#fff"/></svg>`;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

export function button(label: string, iconName: string | null, onClick: () => void, opts: { title?: string; primary?: boolean; className?: string } = {}): HTMLButtonElement {
  const b = h("button", {
    class: ["btn", opts.primary ? "primary" : "", opts.className ?? ""].join(" ").trim(),
    title: opts.title,
    type: "button",
    html: `${iconName ? icon(iconName) : ""}${label ? `<span>${label}</span>` : ""}`,
  });
  b.addEventListener("click", onClick);
  if (!label && opts.title) b.setAttribute("aria-label", opts.title);
  return b;
}

let toastTimer: number | undefined;
export function toast(message: string, kind: "info" | "error" | "success" = "info"): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast", role: "status" });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  // Lange meldinger står lenger, så de rekker å bli lest.
  const ms = Math.max(kind === "error" ? 6000 : 3000, message.length * 60);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), ms);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Modal dialog. Returnerer en funksjon som lukker den. */
export function modal(title: string, body: HTMLElement, actions: HTMLElement[], onClose?: () => void): () => void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    prevFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  const box = h(
    "div",
    { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("header", {}, h("h2", {}, title), button("", "close", close, { title: "Lukk (Esc)", className: "ghost" })),
    h("div", { class: "modal-body" }, body),
    h("footer", {}, ...actions),
  );
  const backdrop = h("div", { class: "backdrop" }, box);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
  (box.querySelector("input, select, .btn.primary") as HTMLElement | null)?.focus();
  return close;
}

/** Heldekkende fremdriftsindikator for lengre jobber. */
export function busy(message: string): { update: (msg: string, fraction?: number) => void; done: () => void; cancelled: () => boolean } {
  let cancelled = false;
  const text = h("div", { class: "busy-text" }, message);
  const bar = h("div", { class: "busy-bar" }, h("div"));
  const cancel = button("Avbryt", null, () => {
    cancelled = true;
    cancel.disabled = true;
  });
  const el = h("div", { class: "backdrop busy" }, h("div", { class: "modal small" }, text, bar, h("footer", {}, cancel)));
  document.body.append(el);
  return {
    update(msg, fraction) {
      text.textContent = msg;
      const inner = bar.firstElementChild as HTMLElement;
      bar.classList.toggle("indeterminate", fraction === undefined);
      if (fraction !== undefined) inner.style.width = `${Math.round(fraction * 100)}%`;
    },
    done: () => el.remove(),
    cancelled: () => cancelled,
  };
}

/** Venter én frame – lar nettleseren tegne fremdrift mellom tunge steg. */
export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
