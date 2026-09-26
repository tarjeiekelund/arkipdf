# Blad

**Blad** er en enkel, lett og rask PDF-leser for Windows, laget som et
alternativ til Adobe Acrobat for det man faktisk gjør til daglig.

Navnet spiller på *blad* som i en side i et dokument, og et lett blad.

## Funksjoner

| Funksjon | Hvordan |
| --- | --- |
| Åpne PDF-er, store som små | **Ctrl+O**, dra fila inn i vinduet, dobbeltklikk en PDF i Utforsker, eller velg fra «Nylig åpnet» på startsiden. Blad husker hvilken side du var på |
| Presentere i fullskjerm | **Ctrl+L** (eller F5). Se [Presentasjon](#presentasjon) |
| Slå sammen flere PDF-er | **Ctrl+M**. Velg filer, sett rekkefølgen og lagre som ny PDF. Hver fil får et bokmerke med filnavnet. Drar du flere PDF-er inn i vinduet, åpnes sammenslåingen direkte |
| Endre rekkefølge på sider | **Ctrl+K**. Dra sidene dit du vil ha dem. **Ctrl+S** lagrer tilbake i samme fil, **Ctrl+Shift+S** lagrer som ny fil. Du kan også rotere (Ctrl+R) og slette (Delete) sider, og angre (Ctrl+Z). Glidebryteren gir større miniatyrer |
| Eksportere til PNG | **Ctrl+E**. Alle sider, gjeldende side eller et utvalg («1-3, 7»), i 96–600 DPI |
| Søke i teksten | **Ctrl+F**. Treffene markeres i dokumentet. Enter/F3 går til neste, Shift+Enter/Shift+F3 til forrige |
| Skrive ut | **Ctrl+P**. Se [Utskrift](#utskrift) |

### Tegninger

- **Skarp zoom helt til 3200 %.** Ved kraftig zoom tegnes det synlige
  utsnittet på nytt i full oppløsning, så tynne linjer og små mål er skarpe
  også på A0.
- **Zoom mot musepekeren** med Ctrl+musehjul eller knip på styreflaten.
- **Dra tegningen rundt:** hold inne **mellomrom** og dra, dra med **midtre
  musetast**, eller velg håndverktøyet (**H**; **V** tilbake til markering).
- **Roter visningen** med **R** (Shift+R mot klokka). Fila endres ikke.
- **Bokmerker** vises i sidepanelet (fanen «Bokmerker»), og **lenker** i
  PDF-en er klikkbare. Lenker til nettsider åpnes i nettleseren etter at du
  har bekreftet.
- Tilpasset zoom regnes ut fra det største arket, så alle arkene i et
  tegningssett har samme målestokk seg imellom.

### Måling

Trykk **M** (eller knappen **Mål**) for å måle på tegningen.

| Verktøy | Slik gjør du |
| --- | --- |
| **Avstand** (D) | Klikk start- og sluttpunkt |
| **Lengde** (L) | Klikk flere punkter; dobbeltklikk eller Enter avslutter. Gir summen av alle segmentene |
| **Areal** (A) | Klikk hjørnene; klikk startpunktet, dobbeltklikk eller Enter lukker. Viser også omkrets |

- **Målestokk:** Har PDF-en innebygd målestokk (som Revit, ArchiCAD og
  AutoCAD legger inn), brukes den automatisk. Det vises som «Fra PDF: 1:100».
  Ellers velger du målestokk i lista (1:20, 1:50, 1:100 …), skriver inn en
  annen, eller velger **Kalibrer mot kjent mål**: klikk to punkter på et mål
  du kjenner, og skriv inn lengden. Valget gjelder siden du står på og alle
  sider uten egen målestokk. Uten målestokk vises mål på arket i mm.
- **Shift** låser retningen til 0°, 45° og 90°.
- Backspace fjerner siste punkt, Esc avbryter. Klikk et mål for å velge det,
  og trykk Delete for å fjerne det. Ctrl+Z fjerner det siste målet.
- Lista nederst til høyre viser alle målene med sum av areal og lengder.
  **Kopier som tabell** gir en tabell du kan lime rett inn i Excel.
- Mellomrom og midtre musetast flytter tegningen også mens du måler.
- Målene lagres ikke i fila. De forsvinner når du åpner et annet dokument.

### Presentasjon

| Tast | Virkning |
| --- | --- |
| → ↓ PgDn Mellomrom Enter, klikk | Neste side |
| ← ↑ PgUp Backspace, høyreklikk | Forrige side |
| Sidetall + Enter (f.eks. `12` Enter) | Gå til side 12 |
| Ctrl+musehjul, + / − | Zoom inn på et utsnitt (skarpt til 1600 %) |
| Dra med musa, piltaster | Flytt rundt når du har zoomet |
| 0 | Hele siden igjen |
| B / W | Svart / hvit skjerm |
| L | Laserpeker |
| ? | Vis alle snarveier |
| Esc | Avslutt |

Pilen ved siden av **Presenter** lar deg velge skjerm, for eksempel
projektoren. Valget huskes. Projektoren må være koblet til som «Utvid»
(Windows+P).

### Utskrift

Utskriften sender PDF-en direkte til PDF-motoren i Windows (WebView2), så
linjene skrives ut som vektorer, skarpt også på stort format. Velg
**«Faktisk størrelse»** (skala 100 %) i utskriftsdialogen for å få tegningen
i riktig målestokk, eller «Tilpass» for å få den på arket.

«Som bilder» er en reserve for skrivere som har problemer med vektorutskrift.
Da får hver side sitt eget arkformat, og du får beskjed hvis store ark må
skrives ut med lavere oppløsning.

### Andre snarveier

Ctrl+G gå til side · Ctrl+B vis/skjul sidepanel ·
Ctrl+pluss/minus for zoom · Ctrl+0 automatisk zoom ·
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
│   ├── viewer.ts    kontinuerlig sidevisning, skarp dyp zoom, håndverktøy
│   ├── links.ts     lenker og bokmerkemål
│   ├── measure.ts   måling: verktøy, målestokk, liste
│   ├── measure-math.ts beregninger og innebygd målestokk i PDF
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
npm test             # selvtest av sortering, sammenslåing og måling
npx tauri build      # installer i src-tauri/target/release/bundle/nsis/
```

I nettleseren (`npm run dev`) brukes en enkel reserve: filer velges med
nettleserens filvelger, og lagrede filer lastes ned.

Ikonet lages fra `app-icon.svg` med `npx tauri icon app-icon.svg`.
