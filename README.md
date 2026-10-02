# ArkiPDF

**ArkiPDF** er en rask PDF-leser for tegninger, laget for arkitekter og
andre som jobber med tegningssett. Den er et lett alternativ til Adobe
Acrobat for det man faktisk gjør til daglig: lese, måle, slå sammen og
presentere tegninger.

Appen het tidligere Blad. Mål som er lagret i PDF-er med Blad, leses som før.

## Funksjoner

| Funksjon | Hvordan |
| --- | --- |
| Åpne PDF-er, store som små | **Ctrl+O** (du kan velge flere), dra filer inn i vinduet, dobbeltklikk en PDF i Utforsker, eller velg fra «Nylig åpnet» på startsiden. ArkiPDF husker hvilken side du var på |
| PDF fra bilder | Åpne eller dra inn et bilde (JPG, PNG, WebP, GIF, BMP), så blir det en PDF som vises før den lagres. Skannede tegninger med oppgitt oppløsning får sin virkelige arkstørrelse, så målestokken stemmer; foto og skjermbilder legges på A4. Mobilbilder står riktig vei. Flere bilder blir én PDF med **Slå sammen** |
| Faner | Hvert dokument åpnes i sin egen fane, i samme vindu, også når du dobbeltklikker flere PDF-er i Utforsker. Hver fane husker side, zoom, rotasjon og mål. **Ctrl+Tab** / **Ctrl+Shift+Tab** (eller Ctrl+PageDown/PageUp) bytter fane, **Ctrl+W** eller midtre musetast lukker. En prikk på fanen viser at noe ikke er lagret, og ArkiPDF spør før slike faner lukkes |
| Presentere i fullskjerm | **Ctrl+L** (eller F5). Se [Presentasjon](#presentasjon) |
| Slå sammen flere PDF-er | **Ctrl+M**. Velg filer (også bilder, som blir en side hver) og sett rekkefølgen. Resultatet vises før det lagres, så du kan se over sidene og justere med «Sorter sider» (knappen «Bruk» tar endringene i bruk); **Ctrl+S** lagrer. Hver fil får et bokmerke med filnavnet. Resultatet åpnes i en ny fane. Fra Utforsker: marker PDF-ene, høyreklikk og velg **Send til → ArkiPDF – slå sammen PDF-er** (i Windows 11 under «Vis flere alternativer») |
| Endre rekkefølge på sider | Dra miniatyrene i sidepanelet dit du vil ha dem. Ctrl-klikk og Shift-klikk velger flere sider, som dras samlet. **Delete** sletter valgte sider, og **Ctrl+Z** angrer. Endringene gjelder med én gang, men skrives til fila først når du lagrer: fanen får en prikk, og stripa over dokumentet har **Lagre** (Ctrl+S), **Lagre som…** (Ctrl+Shift+S) og **Forkast**. Mål følger sidene sine |
| Sortere i rutenett | **Ctrl+K** («Sorter sider») viser alle sidene i et rutenett med store miniatyrer, der du også kan rotere (Ctrl+R). **Bruk** tar endringene i bruk og går tilbake til vanlig visning; de lagres som over |
| Redusere filstørrelsen | Knappen **Reduser**. **Skjerm og e-post** skalerer bildene ned til 150 dpi slik de står på arket; **Utskrift** til 300 dpi. Linjer, tekst og mål er vektorer og røres ikke. Like bilder og fonter (vanlig i sammenslåtte sett) lagres bare én gang, og ubrukte objekter fjernes. Resultatet vises før det lagres, og Ctrl+Z angrer |
| Eksportere til PNG | **Ctrl+E**. Alle sider, gjeldende side eller et utvalg («1-3, 7»), i 96–600 DPI |
| Søke i teksten | **Ctrl+F**. Treffene markeres i dokumentet. Enter/F3 går til neste, Shift+Enter/Shift+F3 til forrige |
| Skrive ut | **Ctrl+P**. Se [Utskrift](#utskrift) |
| Markere med sky, pil og tekst | **K**. Se [Markering](#markering) |
| Signere | Knappen **Signer**. Tegn signaturen eller hent den fra et bilde, og klikk der den skal stå. Se [Signatur](#signatur) |
| Redigere tekst | **E** (knappen **Rediger**). Se [Redigere tekst](#redigere-tekst) |
| Sladde | Knappen **Sladd**. Innholdet fjernes fra fila for godt. Se [Sladding](#sladding) |
| Word, Excel og PowerPoint til PDF | Åpne eller dra inn dokumentet (også i **Slå sammen**). Office på PC-en gjør det om i bakgrunnen, uten å vise vinduer; finnes ikke Office, brukes LibreOffice hvis det er installert. Resultatet vises før det lagres |
| Fylle ut skjemaer | Klikk i feltene og skriv. Se [Skjemaer](#skjemaer) |

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
- **Snapping:** Punktene festes til hjørner, skjæringspunkter, midtpunkter og
  linjer i tegningen (i den rekkefølgen) når du klikker nær dem. En blå
  markør viser hva punktet festes til. Hold **Alt** for å slå det av
  midlertidig, eller fjern haken ved «Fest til tegningen».
- **Shift** låser retningen til 0°, 45° og 90°.
- Backspace fjerner siste punkt, Esc avbryter.
- **Endre et mål:** klikk etiketten (eller inne i et areal) for å velge målet.
  Dra i punktene for å flytte dem; de festes til tegningen som når du måler.
  Dobbeltklikk på kanten av et lengde- eller arealmål for å legge til et
  punkt. Dra etiketten for å flytte hele målet. Delete eller Backspace sletter det
  valgte målet, og Ctrl+Z angrer siste endring.
- Lista nederst til høyre viser alle målene med sum av areal og lengder.
  **Kopier som tabell** gir en tabell du kan lime rett inn i Excel.
- Mellomrom og midtre musetast flytter tegningen også mens du måler.
- **Lagre i fila** (knappen i lista, eller Ctrl+S mens du måler) skriver
  målene inn i PDF-en som vanlige målekommentarer, med linjer og tall. De
  vises da også i Acrobat, Bluebeam og andre PDF-lesere, samlet i laget
  «Mål (ArkiPDF)» som kan slås av og på der. Neste gang fila åpnes i ArkiPDF,
  kan målene redigeres igjen, og målestokkvalgene er husket. ArkiPDF spør før
  ulagrede mål forkastes.

### Markering

Trykk **K** (eller knappen **Merk**) for å markere på tegningen.

| Verktøy | Slik gjør du |
| --- | --- |
| **Sky** (S) | Dra opp en revisjonssky rundt det som er endret |
| **Pil** (P) | Dra fra der pila starter til det den peker på |
| **Tekst** (T) | Klikk der teksten skal stå, og skriv. Enter er ferdig, Shift+Enter gir ny linje, Esc avbryter |

- Velg farge (rød, blå eller svart) før du tegner. Er en markering valgt,
  får den fargen du klikker.
- **Endre:** klikk en markering for å velge den. Dra for å flytte, og dra i
  punktene for å endre størrelsen på skyen eller retningen på pila.
  Dobbeltklikk (eller Enter) på en tekst for å endre den. Delete sletter, og
  Ctrl+Z angrer.
- Strek, buer og skrift følger arkets størrelse, så markeringene ser like ut
  på A4 og A1.
- **Lagre** (knappen i linja, eller Ctrl+S) skriver markeringene inn i PDF-en
  som vanlige kommentarer: skyen som rektangel med skykant, pila som linje med
  pilspiss og teksten som tekstboks. De vises og kan endres i Acrobat,
  Bluebeam, Edge og andre PDF-lesere, og ligger i laget «Merknader (ArkiPDF)».
  Neste gang fila åpnes i ArkiPDF, kan de redigeres igjen. Mål og markeringer
  lagres sammen.
- Lista nederst til høyre viser alle markeringene; klikk for å gå til en.
- Kommentarer laget i andre programmer vises i ArkiPDF, men kan ikke endres
  her.
- Ulagrede mål og markeringer kommer med på utskrift og i presentasjonen.
- Er PDF-en signert digitalt, spør ArkiPDF før den lagres over: mål,
  markeringer og sideendringer gjør signaturen ugyldig. Bruk «Lagre som…» for
  å beholde originalen. (Utfylte skjemafelt lagres som et tillegg og beholder
  signaturen.)

### Redigere tekst

Trykk **E** (eller **Rediger**), pek på en tekstlinje og klikk. Skriv den nye
teksten og trykk **Enter** (Esc avbryter). Egnet til å rette et tall, en dato,
et navn eller en linje i et tittelfelt.

- Den gamle teksten fjernes fra fila, og den nye skrives på samme sted, i samme
  størrelse, farge og retning.
- Samme font brukes når den finnes i Windows (Arial, Calibri, Times, Segoe,
  ISOCPEUR fra AutoCAD o.l., og fonter du har installert selv). Ellers brukes
  Arial i samme vekt, og ArkiPDF sier fra.
- Tittelfelt som deles av flere sider, endres bare på siden du redigerer.
- Tekst i skjulte lag og usynlig tekst (f.eks. fra OCR eller maler) kan ikke
  velges.
- Endringen gjøres i minnet: **Ctrl+Z** angrer, og den lagres med Ctrl+S.
- Begrensninger: én linje om gangen, og teksten flyter ikke om til nye linjer.
  Tekst som er tegnet som streker (vanlig i CAD-eksport), er ikke tekst og kan
  ikke redigeres.

### Sladding

Trykk **Sladd**, og merk det som skal bort: dra opp områder, eller skriv en
tekst (f.eks. et beløp) i søkefeltet og trykk **Merk treff** for å merke alle
steder den står. Se over merkingene (klikk en og trykk Delete for å fjerne den),
og trykk **Sladd**.

- Alt under områdene fjernes fra selve fila, ikke bare dekket over: tekst tegn
  for tegn (også usynlig tekst, f.eks. fra OCR), pikslene i bilder, figurer som
  ligger helt inne i et område, og kommentarer og skjemafelt som berører det.
  Områdene dekkes med svart.
- Skjulte kopier fjernes også: miniatyrbilder av sidene, Illustrator-data og
  alt i fila som ikke lenger brukes.
- Ctrl+Z angrer til du lagrer. Bruk **Lagre som…**, så beholder du originalen.
- Figurer som bare delvis ligger i et område, blir stående under den svarte
  boksen. Tekst som er tegnet som streker (vanlig i CAD-eksport), er figurer:
  merk hele teksten, så fjernes den. Bokmerker og filnavn endres ikke.

### Signatur

Trykk **Signer** (eller **N** mens du markerer). Første gang tegner du
signaturen med musa, en penn eller fingeren, eller henter den fra et bilde
(**Fra bilde**): et foto eller en skanning av signaturen på hvitt papir.
Papiret blir gjennomsiktig, så bare blekket blir med. Signaturen huskes på
PC-en og brukes igjen neste gang; **Endre signatur…** lager en ny.

- Klikk der signaturen skal stå. Den settes inn i vanlig håndskriftstørrelse
  (5 cm bred) og står rett også på roterte ark.
- Dra for å flytte, og dra i hjørnene for å endre størrelsen. Delete sletter,
  og Ctrl+Z angrer.
- Velg blekkfarge (blå, svart eller rød) før du klikker, eller klikk en farge
  mens signaturen er valgt. Blekkfargen huskes for seg, uavhengig av fargen
  på markeringene.
- **Lagre** (Ctrl+S) skriver signaturen inn i PDF-en som et stempel, som vises
  i Acrobat, Edge, Bluebeam og andre PDF-lesere. Der kan den flyttes eller
  slettes, som andre kommentarer.
- **Lagre låst kopi…** lagrer en kopi der signaturene (og utfylte
  skjemafelt) er en del av selve siden og ikke kan flyttes eller slettes.
  Bruk den før du sender et signert dokument.
- Dette er en innsatt signatur, som når du signerer på papir og skanner.
  Det er ikke en digital signatur med sertifikat (som BankID), og PDF-en
  får ingen signaturkontroll.

### Skjemaer

PDF-skjemaer med felt (tekst, avkrysning, radioknapper og nedtrekkslister)
kan fylles ut rett i ArkiPDF. Feltene er lyseblå; Tab går til neste felt.

- Stripa over dokumentet viser at skjemaet er fylt ut. **Lagre** (Ctrl+S)
  skriver verdiene inn i fila, så de vises i Acrobat, Edge og andre
  PDF-lesere. Mål og markeringer lagres samtidig.
- **Lagre låst kopi…** lagrer en kopi der feltene (og signaturene) er gjort
  om til vanlig innhold, så mottakeren ikke kan endre dem. Skjemaet du fyller ut, er
  fortsatt åpent.
- Utskrift tar med verdiene, også før de er lagret.
- Skjemaer laget med Adobe LiveCycle (XFA) støttes ikke. Er skjemaet bare en
  flat PDF uten felt, kan du skrive på det med **Tekst** under
  [Markering](#markering).

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

1. Last ned `ArkiPDF_…_x64-setup.exe` fra siste release:
   **https://github.com/tarjeiekelund/arkipdf/releases/latest**
2. Kjør den. Den installeres for din bruker, uten administratorrettigheter,
   og registrerer seg som et program som kan åpne PDF-filer. Windows kan
   advare fordi installeren ikke er signert: velg «Mer informasjon» →
   «Kjør likevel».

Installeren bygges av GitHub Actions (`.github/workflows/windows.yml`). Hver
PR får også et testbygg under **Actions → «Windows-bygg»** (artefakten
**ArkiPDF-installer**).

Vil du gjøre ArkiPDF til standardprogram for PDF: høyreklikk en PDF →
*Åpne med* → *Velg en annen app* → **ArkiPDF** → *Alltid*.

Hadde du installert appen mens den het Blad, installeres ArkiPDF ved siden
av. Avinstaller Blad under *Innstillinger → Apper*. Innstillinger som
«Nylig åpnet» blir med over.

Lager du en tagg som `v0.6.0` og pusher den, blir installeren i tillegg
lagt ut som en GitHub-release.

### Nye versjoner

ArkiPDF sjekker én gang i døgnet om det finnes en nyere release på GitHub.
Da vises en melding nede til høyre med **Last ned** (henter installeren),
**Hva er nytt?** (åpner release-siden) og **Hopp over** (ikke spør om denne
versjonen igjen). Installeren kjøres over den gamle versjonen. Sjekken krever
at repoet er offentlig; ellers skjer det ingenting. Uten nett merkes den ikke.

## Teknikk

- [Tauri 2](https://tauri.app): et lite Rust-skall rundt Windows' innebygde
  WebView2. Installeren blir noen få MB, og programmet starter raskt.
- [pdf.js](https://mozilla.github.io/pdf.js/) tegner sidene. Bare sidene
  som er synlige blir tegnet, så dokumenter med tusenvis av sider åpner
  umiddelbart. Miniatyrene lagres som små JPEG-er for å spare minne.
- [pdf-lib](https://pdf-lib.js.org) står for sammenslåing og
  omorganisering. Ved sortering bygges sidetreet om i den eksisterende fila,
  så bokmerker, skjemafelt og metadata blir med.
- Skrifta er [Hanken Grotesk](https://fonts.google.com/specimen/Hanken+Grotesk)
  (SIL Open Font License), som følger med appen og virker uten nett.
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
│   ├── measure-pdf.ts lagring av mål som PDF-kommentarer
│   ├── markup.ts    markering: sky, pil, tekst og signatur
│   ├── markup-pdf.ts lagring av markeringer som PDF-kommentarer, låsing av signaturer
│   ├── signature.ts tegning av signaturen, eller fra et bilde
│   ├── snap.ts      snapping til streker i tegningen
│   ├── present.ts   fullskjerm-presentasjon
│   ├── organize.ts  «Sorter sider»
│   ├── merge.ts     «Slå sammen»
│   ├── compress.ts  reduksjon av filstørrelse (bilder, duplikater)
│   ├── shrink.ts    dialogen «Reduser filstørrelse»
│   ├── update.ts    varsel om nye versjoner
│   ├── exportpng.ts eksport til PNG
│   ├── search.ts    tekstsøk med markering av treff
│   ├── print.ts     utskrift
│   ├── edit.ts      skriving av PDF (pdf-lib): sider, sammenslåing, bilder, låsing av skjema
│   ├── images.ts    bilder som må tegnes om (WebP, mobilbilder) før de legges i PDF
│   ├── textedit.ts  «Rediger tekst»: velg og skriv om en tekstlinje
│   ├── textedit-pdf.ts tolking av innholdsstrømmer og utskifting av tekst
│   ├── fonts.ts     fra fontnavn i PDF-en til fontfil i Windows
│   ├── redact.ts    «Sladd»: merking av områder og søk
│   ├── redact-pdf.ts fjerning av tekst, bilder, figurer og kommentarer i områdene
│   └── platform.ts  fil- og vindusfunksjoner (Tauri, med nettleser-reserve)
├── branding/        grafisk profil (BRAND.md) og kildefiler for ikonet
└── src-tauri/       Rust-skallet (lesing/skriving av filer, installer-oppsett)
```

## Utvikling

Krever Node 22 og Rust (stable).

```bash
npm install
npm run dev          # bare grensesnittet i nettleseren, http://localhost:1420
npx tauri dev        # hele appen i eget vindu
npm test             # selvtester: sortering, sammenslåing, måling, snapping, lagring
npm run icons        # lager programikonene på nytt fra branding/*.svg
npx tauri build      # installer i src-tauri/target/release/bundle/nsis/
```

I nettleseren (`npm run dev`) brukes en enkel reserve: filer velges med
nettleserens filvelger, og lagrede filer lastes ned.

Grafisk profil (farger, ordbilde og ikon) er beskrevet i `branding/BRAND.md`. Ikonet lages fra `branding/arkipdf-ikon.svg` med `npm run icons`; 16 og 24 px tegnes fra egne, pikseltilpassede filer i samme mappe, så ikonet er skarpt i Utforsker og oppgavelinja.
