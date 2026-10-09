// Høyreklikkmenyen for markert tekst: kopier, marker, understrek,
// gjennomstrek (med fargevalg når musa holdes over fargen) og slett tekst.
// Høyreklikk på en markering gir en meny for å endre fargen eller fjerne den.
import type { Pt } from "./measure-math";
import { COLORS, TEXT_COLORS, quadsOf, type MarkupColor, type TextMarkupKind } from "./markup-pdf";
import type { Markup } from "./markup";
import { h, icon, toast } from "./ui";

const NAMES: Record<TextMarkupKind, string> = { highlight: "Marker", underline: "Understrek", strike: "Gjennomstrek" };
const DEFAULTS: Record<TextMarkupKind, MarkupColor> = { highlight: "yellow", underline: "red", strike: "red" };

function loadColors(): Record<TextMarkupKind, MarkupColor> {
  const out = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem("textMarkupColors") ?? "{}");
    for (const k of Object.keys(out) as TextMarkupKind[]) if (TEXT_COLORS.includes(saved[k])) out[k] = saved[k];
  } catch {
    /* standardfargene */
  }
  return out;
}

function saveColors(c: Record<TextMarkupKind, MarkupColor>): void {
  try {
    localStorage.setItem("textMarkupColors", JSON.stringify(c));
  } catch {
    /* ikke kritisk */
  }
}

/** Område i PDF-koordinater som skal tømmes for tekst (se eraseText). */
export interface EraseArea {
  page: number;
  rect: [number, number, number, number];
}

let closeOpen: (() => void) | null = null;

export class TextMenu {
  /** Sletter teksten i områdene (hovedprogrammet gjør det, med angring). */
  onErase: ((areas: EraseArea[]) => void) | null = null;

  constructor(private readonly markup: Markup) {}

  /** Viser menyen hvis høyreklikket gjelder markert tekst eller en markering. Gir true når den vises. */
  handle(e: MouseEvent, container: HTMLElement): boolean {
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : "";
    if (sel && text.trim() && sel.rangeCount && container.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      const parts = this.markup.selectionQuads(sel);
      if (parts.length) {
        this.showForSelection(e, sel, parts, text);
        return true;
      }
    }
    const hit = this.markup.textMarkupAt(e);
    if (hit) {
      this.showForMarkup(e, hit);
      return true;
    }
    return false;
  }

  private showForSelection(e: MouseEvent, sel: Selection, parts: Array<{ page: number; points: Pt[] }>, text: string): void {
    const colors = loadColors();
    const apply = (kind: TextMarkupKind, color: MarkupColor) => {
      colors[kind] = color;
      saveColors(colors);
      this.markup.addTextMarkup(kind, color, parts, text.replace(/\s+/g, " ").trim());
      sel.removeAllRanges();
      close();
    };
    const row = (kind: TextMarkupKind) => {
      const dot = colorDot(colors[kind]);
      const b = h("button", { type: "button", class: "popover-item", role: "menuitem", html: icon(kind) }, h("span", {}, NAMES[kind]), dot);
      b.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".color-dot")) return;
        apply(kind, colors[kind]);
      });
      // Fargene vises ved siden av når musa holdes over fargen (eller den klikkes).
      const open = () => openFlyout(dot, colors[kind], (c) => apply(kind, c));
      dot.addEventListener("mouseenter", open);
      dot.addEventListener("click", open);
      return b;
    };
    const item = (label: string, iconName: string, onClick: () => void) => {
      const b = h("button", { type: "button", class: "popover-item", role: "menuitem", html: icon(iconName) }, h("span", {}, label));
      b.addEventListener("click", () => {
        close();
        onClick();
      });
      return b;
    };
    const menu = h(
      "div",
      { class: "popover text-menu", role: "menu" },
      item("Kopier", "copy", () => void copy(text)),
      row("highlight"),
      row("underline"),
      row("strike"),
      h("div", { class: "menu-sep" }),
      item("Slett tekst", "erase", () => {
        const areas = parts.flatMap((p) => quadRects(p.points).map((rect) => ({ page: p.page, rect })));
        sel.removeAllRanges();
        this.onErase?.(areas);
      }),
    );
    const close = show(menu, e);
  }

  private showForMarkup(e: MouseEvent, hit: { id: number; kind: TextMarkupKind; color: MarkupColor }): void {
    const colors = h(
      "div",
      { class: "color-row", role: "group", "aria-label": "Farge" },
      ...TEXT_COLORS.map((c) => {
        const d = colorDot(c, c === hit.color);
        d.addEventListener("click", () => {
          this.markup.recolor(hit.id, c);
          const saved = loadColors();
          saved[hit.kind] = c;
          saveColors(saved);
          close();
        });
        return d;
      }),
    );
    const remove = h("button", { type: "button", class: "popover-item", role: "menuitem", html: icon("trash") }, h("span", {}, "Fjern markeringen"));
    remove.addEventListener("click", () => {
      this.markup.removeItem(hit.id);
      close();
    });
    const menu = h("div", { class: "popover text-menu", role: "menu" }, h("div", { class: "popover-title" }, { highlight: "Markert", underline: "Understreket", strike: "Gjennomstreket" }[hit.kind]), colors, remove);
    const close = show(menu, e);
  }
}

function colorDot(c: MarkupColor, active = false): HTMLButtonElement {
  const d = h("button", { type: "button", class: `color-dot${active ? " active" : ""}`, title: COLORS[c].name, "aria-label": COLORS[c].name });
  d.style.setProperty("--swatch", COLORS[c].css);
  return d;
}

let flyout: HTMLElement | null = null;
/** Linjen i menyen fargene hører til. */
let flyoutRow: Element | null = null;

function openFlyout(anchor: HTMLElement, current: MarkupColor, pick: (c: MarkupColor) => void): void {
  flyout?.remove();
  const el = h(
    "div",
    { class: "color-flyout", role: "group", "aria-label": "Farge" },
    ...TEXT_COLORS.map((c) => {
      const d = colorDot(c, c === current);
      d.addEventListener("click", () => pick(c));
      return d;
    }),
  );
  document.body.append(el);
  flyoutRow = anchor.closest(".popover-item");
  const r = anchor.getBoundingClientRect();
  const menu = anchor.closest(".text-menu")!.getBoundingClientRect();
  const fr = el.getBoundingClientRect();
  // Til høyre for menyen, med den valgte fargen på høyde med sirkelen.
  const i = TEXT_COLORS.indexOf(current);
  const left = menu.right + 6 + fr.width > window.innerWidth ? menu.left - 6 - fr.width : menu.right + 6;
  const top = Math.min(Math.max(8, r.top - 8 - i * 28), window.innerHeight - fr.height - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  flyout = el;
}

/** Viser menyen ved musepekeren, innenfor vinduet. Gir en funksjon som lukker den. */
function show(menu: HTMLElement, e: MouseEvent): () => void {
  closeOpen?.();
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 8)}px`;
  const close = () => {
    menu.remove();
    flyout?.remove();
    flyout = null;
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", esc, true);
    window.removeEventListener("blur", close);
    closeOpen = null;
  };
  const outside = (ev: MouseEvent) => {
    const t = ev.target as Node;
    if (!menu.contains(t) && !flyout?.contains(t)) close();
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      ev.preventDefault();
      close();
    }
  };
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("keydown", esc, true);
  window.addEventListener("blur", close);
  // Fargene skjules når musa går til en annen linje i menyen.
  menu.addEventListener("mouseover", (ev) => {
    const row = (ev.target as HTMLElement).closest(".popover-item");
    if (flyout && row && row !== flyoutRow) {
      flyout.remove();
      flyout = null;
    }
  });
  closeOpen = close;
  return close;
}

/** Rektanglene ([x0, y0, x1, y1]) rundt hver linje. */
function quadRects(points: Pt[]): Array<[number, number, number, number]> {
  return quadsOf(points).map((q) => {
    const xs = q.map((p) => p[0]);
    const ys = q.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    if (!document.execCommand("copy")) toast("Kunne ikke kopiere teksten.", "error");
  }
}
