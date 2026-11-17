# GG - Kde na světě jsem?

Webová zeměpisná hra pro mobil (včetně skládacích telefonů typu Galaxy Fold) i počítač.
Hráč se rozhlédne po panoramatu, na mapě označí, kde si myslí, že je, a za přesnost dostane body.

**Stav:** fáze 1 (sólo hra o 5 kolech) ve **variantě A**: čistě statický web pro GitHub Pages,
bez vlastního serveru a bez Googlu. Data jsou zdarma.

## Jak to funguje

| Část                  | Řešení                                                                                                       | Cena                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Hosting               | GitHub Pages (statické soubory)                                                                              | zdarma                      |
| Panoramata, mód Svět  | [Mapillary](https://www.mapillary.com) (licence CC BY-SA)                                                    | zdarma                      |
| Panoramata, mód Česko | [Mapy.com JS Panorama](https://developer.mapy.com/js-panorama-2/)                                            | v rámci bezplatných kreditů |
| Název místa po kole   | Mapy.com reverzní geokódování                                                                                | v rámci bezplatných kreditů |
| Mapa pro tipování     | [MapLibre GL](https://maplibre.org) + dlaždice [OpenFreeMap](https://openfreemap.org) (data © OpenStreetMap) | zdarma, bez klíče           |

Mapy.com bez zapnuté placené spotřeby po vyčerpání bezplatných kreditů službu do konce měsíce
**pozastaví**. Neúčtuje nic navíc. Hra pak v módu Česko ukáže chybu a mód Svět dál funguje.

## Požadavky

- Node.js 22+
- Účet Mapillary (pro mód Svět) a/nebo účet Seznam pro Mapy.com (pro mód Česko)

## Instalace a spuštění

```bash
npm install
cp .env.example .env.local   # a doplň klíče
npm run dev                   # http://localhost:5173
```

Další příkazy:

```bash
npm test             # jednotkové a integrační testy (Vitest)
npm run typecheck    # kontrola typů
npm run lint         # ESLint
npm run format       # Prettier
npm run build        # produkční build do dist/
npx playwright install chromium && npx playwright test   # e2e testy na 5 rozlišeních
```

E2E testy umí použít i systémový Chrome: `CHROME_PATH=/usr/bin/google-chrome npx playwright test`.

## Klíče a jejich omezení

Obě proměnné se vloží do JavaScriptu při sestavení, **v prohlížeči jsou tedy veřejně
viditelné**. Do repozitáře je nepřidávej, patří do `.env.local` nebo do GitHub Secrets.

| Proměnná               | Kde získat                                                                                                   | Jak omezit                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `VITE_MAPILLARY_TOKEN` | [Mapillary Developers](https://www.mapillary.com/dashboard/developers) → Register application → Client token | Token je určený pro klienta a dovoluje jen čtení veřejných dat.                                         |
| `VITE_MAPY_API_KEY`    | [developer.mapy.com](https://developer.mapy.com/) → Můj účet → nový projekt                                  | V nastavení projektu povol jen doménu hry (např. `tvoje-jmeno.github.io`). Placenou spotřebu nezapínej. |

Bez klíče se knihovna daného poskytovatele **vůbec nenačte**. Mód je na úvodu vypnutý
s vysvětlením a pokud chybí oba klíče, hra zobrazí upozornění pro provozovatele.

## Nasazení na GitHub Pages

1. Vytvoř na GitHubu nový repozitář (např. `gg`) a nahraj do něj tento projekt.
2. **Settings → Secrets and variables → Actions → New repository secret:** přidej
   `VITE_MAPILLARY_TOKEN` a `VITE_MAPY_API_KEY`.
3. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
4. Každý push do větve `main` spustí `.github/workflows/deploy.yml` (lint, testy, build,
   nasazení). Hra poběží na `https://<uživatel>.github.io/<repozitář>/`.

## Pravidla hry

- 5 kol, v každém jedno panorama. Cílem je **počáteční poloha panoramatu**. Kam se hráč
  během prohlížení přesune, nehraje roli.
- Vzdálenost se počítá po povrchu Země (haversinův vzorec, poloměr 6 371,0088 km),
  nezaokrouhlená. Zaokrouhluje se až při zobrazení.
- Body: `round(5000 × e^(-vzdálenost / škála))`, omezeno na 0 až 5 000. Nulová vzdálenost
  = 5 000 bodů. Maximum za hru je 25 000.
- **Škála:** Svět 1 500 km. Menší mapy:
  `škála = 1 500 km × (úhlopříčka oblasti / 20 015 km)`, kde 20 015 km je polovina obvodu
  Země (největší možná vzdálenost). Česko (obálka 12,09-18,86° v. d., 48,55-51,06° s. š.,
  úhlopříčka ~ 561 km) má škálu ~ 42 km. Pokryto testy v `tests/scoring.test.ts`.
- **Časový limit** (bez limitu, 1, 2, 3, 5 min; nastavení v `src/core/config.ts`):
  - konec kola je uložený jako pevný okamžik, takže po obnovení stránky čas běží dál,
  - po vypršení se špendlíkem se vyhodnotí jeho poslední poloha,
  - po vypršení bez špendlíku je 0 bodů a výsledek tip ani spojnici nekreslí,
  - kolo jde vyhodnotit jen jednou; dvojklik, opakované potvrzení ani obnovení stránky
    nevytvoří druhý výsledek (`submitGuess` funguje jen ve fázi `playing`).
- Když se panorama nenačte, hráč může načítání zopakovat nebo vzít jiné místo.
  Body z odehraných kol zůstávají a čas kola začne znovu.

## Výběr lokací

**Svět (Mapillary).** Náhodný bod na Zemi je většinou moře nebo místo bez snímků. Hra proto:

1. vezme náhodný z ~180 výchozích bodů po celém světě (`src/data/mapillary-seeds.ts`)
   a posune ho o náhodný kus (až ~100 km),
2. stáhne dlaždici pokrytí Mapillary (z8, ~150 km) a vybere náhodný bod na sekvenci
   označené `is_pano`,
3. v okolí (čtverec 0,006° × 0,006°, API vyžaduje pod 0,01 °²) vyhledá snímky
   s `is_pano=true` a typem kamery `spherical`/`equirectangular`,
4. za cíl vezme zpřesněnou polohu snímku (`computed_geometry`).

Mapillary jsou snímky od uživatelů, ne oficiální snímky jednoho poskytovatele. Kvalita
proto kolísá (pozice kamery na helmě, stará data). Filtr bere jen 360° snímky.

**Česko (Mapy.com).** Náhodný bod uvnitř hranice Česka (Natural Earth 1:50 000,
`src/data/cz.json`, vygenerováno `scripts/extract-cz.mjs`), `panoramaExists` s poloměrem
400 m a pak **kontrola skutečné polohy nalezeného panoramatu** uvnitř hranic. Panorama za
hranicí se zahodí; když se po 15 pokusech nic nenajde, hra nabídne opakování a jiný stát
nikdy nepoužije. Mapy.com panoramata pokrývají jen Česko, proto mód Česko + Slovensko
v této podobě nejde. Slovensko by šlo doplnit přes Mapillary.

## Data, atribuce a licence

- **Mapillary:** snímky jsou pod CC BY-SA 4.0. Prohlížeč Mapillary ukazuje autora
  a odkaz sám (komponenta attribution je zapnutá). Hra nic neukládá ani nestahuje mimo
  běžné zobrazení.
- **Mapy.com:** JS Panorama zobrazuje atribuci sama. Podmínky vyžadují u ostatních funkcí
  (název místa) logo Mapy.com; **zatím je tam jen textový odkaz, viz Známá omezení**.
  Rozšířený tarif (10 mil. kreditů měsíčně) vyžaduje zápis v katalogu referenčních projektů.
- **Mapa:** © OpenStreetMap contributors (ODbL), dlaždice OpenFreeMap. Atribuci zobrazuje
  MapLibre v rohu mapy a hra ji nepřekrývá.
- **Uložená data:** v `localStorage` prohlížeče je jen rozehraná hra (ID panoramat,
  souřadnice cílů a tipů, body) a volba módu. Hra se po 24 h nečinnosti zahodí. Názvy míst
  z Mapy.com se drží jen v paměti. Žádná databáze ani předem stažené lokace neexistují.
- Licenční podmínky jsou ověřené jen v rozsahu veřejné dokumentace (listopad 2026).
  Před veřejným spuštěním je dobré přečíst
  [Mapillary Terms](https://www.mapillary.com/terms) a
  [podmínky Mapy.com API](https://developer.mapy.com/terms-and-conditions/).

## Známá omezení a podvádění

Varianta A **nemá server**. Celá logika včetně cíle kola běží v prohlížeči, takže:

- **Cíl lze zjistit** z vývojářských nástrojů, z `localStorage` i z odkazu v atribuci
  Mapillary. Hra je férová jen mezi lidmi, kteří podvádět nechtějí.
- Časový limit hlídá prohlížeč, jde tedy obejít.
- Požadavky zadání na serverové utajení, serverové vyhodnocení a ochranu odpovědí API
  tato varianta **vědomě nesplňuje**. Řeší je varianta B (Cloudflare Workers + D1, také
  zdarma) se stejným herním jádrem (`src/core`).
- Mapy.com: logo u názvu místa zatím chybí (jen text). Spotřeba kreditů jednoho panoramatu
  (účtuje se po dlaždicích) je potřeba změřit v účtu Mapy.com.
- Mapillary: některé oblasti mají málo 360° snímků. Pokud se 12× nic nenajde, hra nabídne
  opakování.
- Hra nemá účty, žebříček ani hru více hráčů (fáze 2).

## Struktura

```
src/core/       herní logika bez závislosti na UI (vzdálenost, body, stav hry, uložení)
src/providers/  poskytovatelé panoramat (Mapillary, Mapy.com, testovací náhrada) a název místa
src/ui/         DOM pomocníci a mapy (MapLibre)
src/app.ts      obrazovky: úvod, načítání, hra, výsledek kola, konec hry
tests/          Vitest (jednotkové a integrační), tests/e2e Playwright (5 rozlišení)
```

Rozložení: na úzkém displeji (telefon, zavřený Fold) je mapa vysouvací panel přes celou
obrazovku. Na širokém displeji na šířku (PC, rozložený Fold na šířku) je mapa vedle
panoramatu, na výšku (rozložený Fold) pod ním. Složení a rozložení během kola stav neztratí.
