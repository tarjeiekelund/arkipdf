# Blad

**Blad** er en enkel, lett og rask PDF-leser for Windows, laget som et
alternativ til Adobe Acrobat for det man faktisk gjør til daglig.

Navnet spiller på *blad* som i en side i et dokument, og et lett blad.

## Funksjoner

| Funksjon | Hvordan |
| --- | --- |
| Åpne PDF-er, store som små | **Ctrl+O**, dra fila inn i vinduet, eller dobbeltklikk en PDF i Utforsker |
| Presentere i fullskjerm | **Ctrl+L** (eller F5). Bla med piltaster, mellomrom, Page Up/Down, museklikk eller musehjul. **Esc** avslutter |
| Slå sammen flere PDF-er | **Ctrl+M**. Velg filer, sett rekkefølgen og lagre som ny PDF. Drar du flere PDF-er inn i vinduet, åpnes sammenslåingen direkte |
| Endre rekkefølge på sider | **Ctrl+K**. Dra sidene dit du vil ha dem. **Ctrl+S** lagrer tilbake i samme fil, **Ctrl+Shift+S** lagrer som ny fil. Du kan også rotere (Ctrl+R) og slette (Delete) sider, og angre (Ctrl+Z) |
| Eksportere til PNG | **Ctrl+E**. Alle sider, gjeldende side eller et utvalg («1-3, 7»), i 96–600 DPI |
| Søke i teksten | **Ctrl+F**. Treffene markeres i dokumentet. Enter/F3 går til neste, Shift+Enter/Shift+F3 til forrige. Søket starter på siden du står på, og telleren viser «3 av 17» |
| Skrive ut | **Ctrl+P**. Velg alle sider, denne siden eller et utvalg, og standard eller høy kvalitet. Så kommer Windows' vanlige utskriftsdialog, der du velger skriver og antall kopier |

Andre snarveier: Ctrl+G gå til side · Ctrl+B vis/skjul miniatyrer ·
Ctrl+pluss/minus eller Ctrl+musehjul for zoom · Ctrl+0 automatisk zoom ·
Ctrl+1 faktisk størrelse · Ctrl+2 hel side · Ctrl+3 tilpass bredde ·
Home/End første/siste side.

Tekst i PDF-en kan markeres og kopieres. Passordbeskyttede PDF-er kan åpnes
(du blir spurt om passordet).

## Installere på Windows

Installeren bygges automatisk av GitHub Actions
(`.github/workflows/windows.yml`):

1. Gå til **Actions → «Windows-bygg»** i GitHub og åpne siste kjøring.
2. Last ned artefakten **Blad-installer** og pakk ut zip-fila.
3. Kjør `Blad_0.1.0_x64-setup.exe`. Den installeres for din bruker, uten
   administratorrettigheter, og registrerer seg som et program som kan åpne
   PDF-filer.

Vil du gjøre Blad til standardprogram for PDF: høyreklikk en PDF →
*Åpne med* → *Velg en annen app* → **Blad** → *Alltid*.

Lager du en tagg som `v0.1.0` og pusher den, blir installeren i tillegg
lagt ut som en GitHub-release.

## Teknikk

- [Tauri 2](https://tauri.app): et lite Rust-skall rundt Windows' innebygde
  WebView2. Installeren blir noen få MB, og programmet starter raskt.
- [pdf.js](https://mozilla.github.io/pdf.js/) tegner sidene. Bare sidene
  som er synlige blir tegnet, så dokumenter med tusenvis av sider åpner
  umiddelbart. Miniatyrene lagres som små JPEG-er for å spare minne.
- [pdf-lib](https://pdf-lib.js.org) står for sammenslåing og
  omorganisering. Ved sortering bygges sidetreet om i den eksisterende fila,
  så bokmerker, skjemafelt og metadata blir med.
- Lagring skjer til en midlertidig fil som deretter bytter plass med
  originalen, så fila aldri blir stående halvskrevet.

```
.
├── src/             grensesnitt (TypeScript, uten rammeverk)
│   ├── main.ts      oppstart, verktøylinje, tastatursnarveier
│   ├── viewer.ts    kontinuerlig sidevisning med lat tegning
│   ├── present.ts   fullskjerm-presentasjon
│   ├── organize.ts  «Sorter sider»
│   ├── merge.ts     «Slå sammen»
│   ├── exportpng.ts eksport til PNG
│   ├── search.ts    tekstsøk med markering av treff
│   ├── print.ts     utskrift
│   ├── edit.ts      skriving av PDF (pdf-lib)
│   └── platform.ts  fil- og vindusfunksjoner (Tauri, med nettleser-reserve)
└── src-tauri/       Rust-skallet (lesing/skriving av filer, installer-oppsett)
```

## Utvikling

Krever Node 22 og Rust (stable).

```bash
npm install
npm run dev          # bare grensesnittet i nettleseren, http://localhost:1420
npx tauri dev        # hele appen i eget vindu
npm test             # selvtest av sortering og sammenslåing
npx tauri build      # installer i src-tauri/target/release/bundle/nsis/
```

I nettleseren (`npm run dev`) brukes en enkel reserve: filer velges med
nettleserens filvelger, og lagrede filer lastes ned.

Ikonet lages fra `app-icon.svg` med `npx tauri icon app-icon.svg`.
