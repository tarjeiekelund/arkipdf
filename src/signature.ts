// Signaturen: tegnes med mus, penn eller finger, eller hentes fra et bilde av
// en signatur på papir. Den lagres som dekning per piksel (se SignatureImage),
// så den kan gis blekkfarge og legges på arket med gjennomsiktig bakgrunn.
// Signaturen huskes på denne PC-en og brukes igjen neste gang.
import { makeSignatureImage, signatureAlpha, type SignatureImage } from "./markup-pdf";
import { button, h, modal, toast } from "./ui";

const KEY = "signature";
/** Største bredde og høyde på det lagrede bildet (holder til utskrift, også stort). */
const MAX_W = 1200;
const MAX_H = 500;

// Reserve hvis lagringen i nettleseren ikke virker: signaturen huskes til appen lukkes.
let memory: SignatureImage | null = null;

export function loadSignature(): SignatureImage | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d.w > 0 && d.h > 0 && typeof d.a === "string") return { w: d.w, h: d.h, a: d.a };
    }
  } catch {
    /* bruker reserven */
  }
  return memory;
}

function saveSignature(img: SignatureImage): void {
  memory = img;
  try {
    localStorage.setItem(KEY, JSON.stringify(img));
  } catch {
    /* huskes bare til appen lukkes */
  }
}

// ---------- Visning ----------

const urls = new Map<string, string | Promise<string>>();

/** Signaturen som PNG i en gitt farge (data-URL). Er den ikke klar ennå, gis et løfte. */
export function signatureUrl(img: SignatureImage, css: string): string | Promise<string> {
  const key = `${css}:${img.a}`;
  let url = urls.get(key);
  if (!url) {
    url = signatureAlpha(img).then((alpha) => {
      const done = render(alpha, img.w, img.h, css).toDataURL("image/png");
      urls.set(key, done);
      return done;
    });
    urls.set(key, url);
  }
  return url;
}

function render(alpha: Uint8Array, w: number, h: number, css: string): HTMLCanvasElement {
  const c = canvas(w, h);
  const ctx = c.getContext("2d")!;
  const data = ctx.createImageData(w, h);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(css.slice(i, i + 2), 16));
  for (let i = 0; i < alpha.length; i++) {
    data.data[i * 4] = r;
    data.data[i * 4 + 1] = g;
    data.data[i * 4 + 2] = b;
    data.data[i * 4 + 3] = alpha[i];
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

function canvas(w: number, ht: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = ht;
  return c;
}

// ---------- Fra piksler til signatur ----------

/**
 * Skjærer bort tom kant og skalerer ned til en fornuftig størrelse.
 * `alpha` er dekningen per piksel i et w × h-bilde.
 */
async function finish(alpha: Uint8Array, w: number, h: number): Promise<SignatureImage | null> {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.02) + 2;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const scale = Math.min(1, MAX_W / cw, MAX_H / ch);
  const nw = Math.max(1, Math.round(cw * scale));
  const nh = Math.max(1, Math.round(ch * scale));
  const src = render(alpha, w, h, "#000000");
  const dst = canvas(nw, nh);
  const ctx = dst.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, x0, y0, cw, ch, 0, 0, nw, nh);
  return makeSignatureImage(alphaOf(ctx.getImageData(0, 0, nw, nh).data), nw, nh);
}

function alphaOf(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3];
  return out;
}

/**
 * Blekket i et bilde av en signatur: alt som er like lyst som papiret blir
 * gjennomsiktig, og mørkere strøk blir dekkende. Papirets lyshet anslås fra
 * bildet, så skygge og gråtonet papir i et foto ikke blir med.
 */
function inkFromImage(rgba: Uint8ClampedArray): Uint8Array {
  const n = rgba.length / 4;
  const lum = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    // Gjennomsiktige piksler (PNG uten bakgrunn) regnes som hvitt papir.
    const l = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) * a + 255 * (1 - a);
    lum[i] = l;
    hist[Math.min(255, Math.round(l))]++;
  }
  // Det meste av bildet er papir: 70-persentilen er papirets lyshet.
  let acc = 0;
  let paper = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n * 0.7) {
      paper = v;
      break;
    }
  }
  const hi = paper - Math.max(18, paper * 0.12);
  const lo = paper * 0.45;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.max(0, Math.min(1, (hi - lum[i]) / (hi - lo))) * 255);
  return out;
}

async function fromImageFile(file: File): Promise<{ alpha: Uint8Array; w: number; h: number }> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const ht = Math.max(1, Math.round(bmp.height * scale));
  const c = canvas(w, ht);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, w, ht);
  bmp.close();
  return { alpha: inkFromImage(ctx.getImageData(0, 0, w, ht).data), w, h: ht };
}

// ---------- Dialogen ----------

/** Lar brukeren tegne signaturen eller hente den fra et bilde. Gir true når en ny signatur er lagret. */
export function editSignature(current: SignatureImage | null = null): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    let mode: "draw" | "image" = "draw";
    let fromImage: { alpha: Uint8Array; w: number; h: number } | null = null;

    // Tegneflaten: tegnes i tre ganger oppløsningen, så signaturen blir skarp på utskrift.
    const RES = 3;
    const pad = h("canvas", { class: "sign-pad", "aria-label": "Tegn signaturen her" });
    const padCtx = () => pad.getContext("2d")!;
    let strokes = 0;
    let last: { x: number; y: number; w: number } | null = null;
    let mid: { x: number; y: number } | null = null;
    const pos = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * pad.width, y: ((e.clientY - r.top) / r.height) * pad.height };
    };
    const width = (e: PointerEvent) => RES * (e.pointerType === "pen" && e.pressure > 0 ? 1.4 + e.pressure * 2.2 : 2.6);
    pad.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      pad.setPointerCapture(e.pointerId);
      const p = pos(e);
      last = { ...p, w: width(e) };
      mid = p;
      const ctx = padCtx();
      ctx.fillStyle = "#1a1a1a";
      ctx.beginPath();
      ctx.arc(p.x, p.y, last.w / 2, 0, Math.PI * 2);
      ctx.fill();
      strokes++;
      updateDraw();
    });
    pad.addEventListener("pointermove", (e) => {
      if (!last || !mid) return;
      const events = e.getCoalescedEvents?.() ?? [e];
      const ctx = padCtx();
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const ev of events.length ? events : [e]) {
        const p = pos(ev);
        const w: number = (last.w + width(ev)) / 2;
        // Glatt kurve gjennom midtpunktene, med punktene som kontrollpunkter.
        const m = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(mid.x, mid.y);
        ctx.quadraticCurveTo(last.x, last.y, m.x, m.y);
        ctx.stroke();
        last = { ...p, w };
        mid = m;
      }
    });
    const end = () => {
      if (last && mid) {
        const ctx = padCtx();
        ctx.lineWidth = last.w;
        ctx.beginPath();
        ctx.moveTo(mid.x, mid.y);
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
      }
      last = null;
      mid = null;
    };
    pad.addEventListener("pointerup", end);
    pad.addEventListener("pointercancel", end);
    const clear = button("Tøm", null, () => {
      padCtx().clearRect(0, 0, pad.width, pad.height);
      strokes = 0;
      updateDraw();
    }, { className: "ghost sign-clear" });

    const drawPanel = h(
      "div",
      { class: "sign-panel" },
      h("div", { class: "sign-pad-wrap" }, pad, h("div", { class: "sign-line" }), clear),
      h("p", { class: "muted" }, "Skriv signaturen med musa, en penn eller fingeren."),
    );

    const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/bmp", hidden: true });
    const preview = h("div", { class: "sign-preview" }, h("span", { class: "muted" }, "Ingen bilde valgt"));
    const pick = button("Velg bilde…", "image", () => file.click());
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;
      try {
        fromImage = await fromImageFile(f);
        const c = render(fromImage.alpha, fromImage.w, fromImage.h, "#1a1a1a");
        c.className = "sign-preview-img";
        preview.replaceChildren(c);
      } catch {
        fromImage = null;
        preview.replaceChildren(h("span", { class: "muted" }, "Kunne ikke lese bildet."));
      }
      updateDraw();
    });
    const imagePanel = h(
      "div",
      { class: "sign-panel", hidden: true },
      preview,
      h("p", { class: "muted" }, pick, " Et bilde eller en skanning av signaturen på hvitt papir. Papiret blir gjennomsiktig, og bare blekket blir med."),
      file,
    );

    const tab = (label: string, m: typeof mode) => {
      const b = h("button", { type: "button", class: "sign-tab", role: "tab" }, label);
      b.addEventListener("click", () => {
        mode = m;
        drawTab.classList.toggle("active", m === "draw");
        imageTab.classList.toggle("active", m === "image");
        drawTab.setAttribute("aria-selected", String(m === "draw"));
        imageTab.setAttribute("aria-selected", String(m === "image"));
        drawPanel.hidden = m !== "draw";
        imagePanel.hidden = m !== "image";
        updateDraw();
      });
      return b;
    };
    const drawTab = tab("Tegn", "draw");
    const imageTab = tab("Fra bilde", "image");
    drawTab.classList.add("active");
    drawTab.setAttribute("aria-selected", "true");

    const currentEl = h("div", { class: "sign-current", hidden: !current });
    if (current) {
      void signatureAlpha(current).then((alpha) => {
        const c = render(alpha, current.w, current.h, "#1a1a1a");
        c.className = "sign-preview-img";
        currentEl.replaceChildren(h("span", { class: "muted" }, "Nå: "), c);
      });
    }

    const body = h(
      "div",
      { class: "sign-dialog" },
      h("div", { class: "sign-tabs", role: "tablist" }, drawTab, imageTab),
      drawPanel,
      imagePanel,
      currentEl,
      h("p", { class: "muted small" }, "Signaturen lagres bare på denne PC-en og brukes igjen neste gang. Blekkfargen velger du i linja over dokumentet."),
    );

    const useBtn = button("Bruk signaturen", null, () => void use(), { primary: true });
    const cancel = button("Avbryt", null, () => close());
    const updateDraw = () => {
      useBtn.disabled = mode === "draw" ? strokes === 0 : !fromImage;
    };
    const use = async () => {
      useBtn.disabled = true;
      try {
        const img = mode === "draw" ? await finish(alphaOf(padCtx().getImageData(0, 0, pad.width, pad.height).data), pad.width, pad.height) : fromImage && (await finish(fromImage.alpha, fromImage.w, fromImage.h));
        if (!img) {
          toast(mode === "draw" ? "Skriv signaturen først." : "Fant ingen signatur i bildet. Bruk et bilde med mørk skrift på lyst papir.", "error");
          updateDraw();
          return;
        }
        saveSignature(img);
        result = true;
        close();
      } catch {
        toast("Kunne ikke lagre signaturen.", "error");
        updateDraw();
      }
    };
    const close = modal("Signatur", body, [cancel, useBtn], () => resolve(result));
    body.closest(".modal")?.classList.add("sign-modal");
    // Tegneflatens oppløsning følger størrelsen den vises i.
    const r = pad.getBoundingClientRect();
    pad.width = Math.round((r.width || 520) * RES);
    pad.height = Math.round((r.height || 180) * RES);
    updateDraw();
  });
}
