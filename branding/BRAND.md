# ArkiPDF – grafisk profil

## Farger
| Token | Hex | Bruk |
|---|---|---|
| `--accent` | `#1D5E4D` | Ikon, primærknapp, lenker |
| `--accent-hover` | `#123C31` | Hover på knapp/lenke |
| `--bg` | `#F4F3EF` | Bakgrunn |
| `--surface` | `#FFFFFF` | Kort, lister, tittellinje |
| `--ink` | `#141816` | Tekst |
| `--muted` | `#5B625E` | Sekundærtekst |
| `--line` | `#D9D8D2` | Rammer og skillelinjer |

## Ordbilde (retning A – «Tett og tung»)
Hanken Grotesk 800, ett ord, «PDF» litt strammere enn «Arki».

```html
<span class="wordmark">Arki<span class="wordmark__pdf">PDF</span></span>
```

```css
.wordmark {
  font-family: 'Hanken Grotesk', system-ui, sans-serif;
  font-weight: 800;
  letter-spacing: -0.05em;
  line-height: 1;
  color: var(--ink);
}
.wordmark__pdf { letter-spacing: -0.065em; }

/* Små størrelser (under ca. 20 px): slipp opp sporingen */
.wordmark--small { letter-spacing: -0.03em; }
.wordmark--small .wordmark__pdf { letter-spacing: -0.03em; }
```

Størrelser: velkomstskjerm 64 px, tittellinje 13 px (`.wordmark--small`).

## Ikon
- `arkipdf-ikon.svg` – master, brukes fra 32 px og opp
- `arkipdf-ikon-24.svg` – pikseltilpasset for 24 px
- `arkipdf-ikon-16.svg` – pikseltilpasset for 16 px

Windows-ikonet (.ico) skal inneholde 16, 24, 32, 48 og 256 px:
16 og 24 rendres fra sine egne filer, resten fra masteren.

---

## Prompt til Claude Code

> Les `branding/BRAND.md` og bruk den nye grafiske profilen i appen:
> 1. Legg inn fargene som CSS-variabler og bytt ut eksisterende grønnfarge og gråtoner.
> 2. Erstatt dagens ikon på velkomstskjermen med `branding/arkipdf-ikon.svg` (ca. 88 px) og overskriften med ordbildet slik det er beskrevet (64 px).
> 3. Bruk ikon (16 px-versjonen) + `.wordmark--small` i tittellinjen hvis appen har egen tittellinje.
> 4. Generer app-ikon: lag PNG-er i 16, 24, 32, 48 og 256 px (16 og 24 fra egne filer, resten fra masteren), pakk dem til en `.ico`, og koble den til byggkonfigurasjonen slik at den brukes som app-, vindus- og oppgavelinjeikon.
> 5. Ikke endre funksjonalitet. Vis meg hvilke filer du endret.
