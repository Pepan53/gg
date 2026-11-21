# GG - Kde na světě jsem?

Webová zeměpisná hra pro mobil (včetně skládacích telefonů typu Galaxy Fold) i počítač.
Hráč se rozhlédne po panoramatu, na mapě označí, kde si myslí, že je, a za přesnost dostane body.

**Hra:** https://pepan53.github.io/gg/

**Stav:** fáze 3 (výukový režim s ručně vybranými místy), navazuje na fázi 2 (herní módy a hra více hráčů) ve **variantě A**: čistě
statický web pro GitHub Pages, bez vlastního serveru a bez Googlu. Data jsou zdarma.

## Jak to funguje

| Část                               | Řešení                                                                                                                                   | Cena                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Hosting                            | GitHub Pages (statické soubory)                                                                                                          | zdarma                      |
| Panoramata Svět, Česko + Slovensko | [Mapillary](https://www.mapillary.com) (licence CC BY-SA)                                                                                | zdarma                      |
| Panoramata Česko                   | [Mapy.com JS Panorama](https://developer.mapy.com/js-panorama-2/)                                                                        | v rámci bezplatných kreditů |
| Název místa po kole                | Mapy.com reverzní geokódování                                                                                                            | v rámci bezplatných kreditů |
| Mapa pro tipování                  | [MapLibre GL](https://maplibre.org) + dlaždice [OpenFreeMap](https://openfreemap.org) (data © OpenStreetMap)                             | zdarma, bez klíče           |
| Hranice států (mód Země, oblasti)  | [Natural Earth](https://www.naturalearthdata.com) 1:50m přes balíček world-atlas (public domain), české názvy z i18n-iso-countries (MIT) | zdarma, součást webu        |

Mapy.com bez zapnuté placené spotřeby po vyčerpání bezplatných kreditů službu do konce měsíce
**pozastaví**. Neúčtuje nic navíc. Hra pak v oblasti Česko ukáže chybu, ostatní oblasti fungují.

## Požadavky

- Node.js 22+
- Účet Mapillary (oblasti Svět a Česko + Slovensko) a/nebo účet Seznam pro Mapy.com (oblast Česko)

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
node scripts/build-countries.mjs   # znovu vygeneruje hranice států (src/data/countries.topo.json)
node scripts/extract-cz.mjs        # znovu vygeneruje hranice Česka a Česka + Slovenska
```

E2E testy umí použít i systémový Chrome: `CHROME_PATH=/usr/bin/google-chrome npx playwright test`.
Běží proti buildu s `VITE_E2E=1`, který místo skutečných panoramat použije testovací náhradu
(`src/providers/fake.ts`) a zpřístupní mapu testům. Do produkčního buildu se nedostane.

## Klíče a jejich omezení

Obě proměnné se vloží do JavaScriptu při sestavení, **v prohlížeči jsou tedy veřejně
viditelné**. Do repozitáře je nepřidávej, patří do `.env.local` nebo do GitHub Secrets.

| Proměnná               | Kde získat                                                                                                   | Jak omezit                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `VITE_MAPILLARY_TOKEN` | [Mapillary Developers](https://www.mapillary.com/dashboard/developers) → Register application → Client token | Jen oprávnění READ. Token je určený pro klienta.                             |
| `VITE_MAPY_API_KEY`    | [developer.mapy.com](https://developer.mapy.com/) → Můj účet → projekt → API klíče                           | V sekci Referery povol jen `pepan53.github.io`. Placenou spotřebu nezapínej. |

Bez klíče se knihovna daného poskytovatele **vůbec nenačte**. Oblast je na úvodu vypnutá
s vysvětlením a pokud chybí oba klíče, hra zobrazí upozornění pro provozovatele.

Po změně klíče v GitHub Secrets je potřeba **nové sestavení** (Actions → Nasazení na GitHub
Pages → Run workflow), protože klíč se do hry dostane jen při buildu.

## Nasazení na GitHub Pages

1. Repozitář na GitHubu (zde `Pepan53/gg`, veřejný, protože bezplatné Pages jinak nejdou).
2. **Settings → Secrets and variables → Actions:** `VITE_MAPILLARY_TOKEN` a `VITE_MAPY_API_KEY`.
3. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
4. Každý push do větve `main` spustí `.github/workflows/deploy.yml` (lint, testy, build,
   nasazení).

## Pravidla hry

Každá hra má 5 kol. Na úvodu se volí **kdo hraje**, **oblast**, **typ hry**, **čas na tah**
a **černobílé panorama**.

### Společné

- Cílem je **počáteční poloha panoramatu**. Kam se hráč během prohlížení přesune, nehraje roli.
- Vzdálenost se počítá po povrchu Země (haversinův vzorec, poloměr 6 371,0088 km),
  nezaokrouhlená. Zaokrouhluje se až při zobrazení.
- Body za vzdálenost: `round(5000 × e^(-vzdálenost / škála))`, omezeno na 0 až 5 000.
  Nulová vzdálenost = 5 000 bodů.
- **Škála:** Svět 1 500 km. Menší oblasti:
  `škála = 1 500 km × (úhlopříčka oblasti / 20 015 km)`, kde 20 015 km je polovina obvodu
  Země. Česko (úhlopříčka ~ 561 km) má škálu ~ 42 km, Česko + Slovensko (obálka
  12,09-22,57° v. d., 47,73-51,06° s. š., úhlopříčka ~ 843 km) ~ 63 km. Testy v
  `tests/scoring.test.ts`.
- **Časový limit** (bez limitu, 1, 2, 3, 5 min; v `src/core/config.ts`):
  - konec tahu je uložený jako pevný okamžik, po obnovení stránky čas běží dál,
  - po vypršení s tipem se vyhodnotí poslední tip,
  - po vypršení bez tipu je 0 bodů a výsledek tip ani spojnici nekreslí,
  - tah jde vyhodnotit jen jednou; dvojklik, opakované potvrzení ani obnovení stránky
    nevytvoří druhý výsledek.
- Když se panorama nenačte, jde načítání zopakovat nebo vzít jiné místo. Body z odehraných
  kol zůstávají. Jiné místo začne kolo znovu (při více hráčích pro všechny, aby nikdo neměl
  výhodu z jiného panoramatu).

### Typy hry

| Typ           | Pravidla                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Klasika**   | Špendlík na mapu, body podle vzdálenosti. Volitelný časový limit.                                                                                                                                                                    |
| **Countdown** | Pevně 30 s na tah. `body = round(body_za_vzdálenost × zbývající_s / 30)`, omezeno na 0 až 5 000. Rozhoduje okamžik potvrzení tipu. Při vypršení času platí pravidla časového limitu, násobitel je 0, takže i umístěný tip dá 0 bodů. |
| **Země**      | Jen oblast Svět. Hráč klepne na stát, nedává špendlík. Správný stát 5 000 bodů, jiný 0. Ve výsledku je vidět vybraný i správný stát.                                                                                                 |

**Černobílé panorama** jde zapnout ke každému typu v oblastech s panoramaty Mapillary.
Obraz se jen zobrazí bez barev (CSS filtr na plátně prohlížeče), atribuce zůstává čitelná
a lišta hry ukazuje „Černobíle“ jako označení úpravy. U Mapy.com se nenabízí, viz licence.

### Mód Země: hranice a sporná území

- Stát cíle i stát kliknutí určuje stejná funkce: bod v polygonu nad hranicemi Natural Earth
  1:50m (`src/core/countries.ts`). Mapa a vyhodnocení se tedy vždy shodnou.
- Panorama, které neleží v žádném státě (moře, pobřeží zjednodušené na měřítko 1:50m), se
  nepoužije a hra hledá jiné (až 6 pokusů).
- **Kliknutí do moře** nic nevybere; hra napíše „Tady žádný stát není. Klepni na pevninu.“
- **Sporná území** podle Natural Earth (de facto stav), s těmito úpravami:
  Somaliland se počítá k Somálsku, Severní Kypr ke Kypru, Indickooceánská území k Austrálii,
  Kosovo je samostatný stát, ledovec Siačen a Antarktida se nehrají.
- Zámořská území mají kód svého státu podle Natural Earth (např. Francouzská Guyana patří
  pod Francii).
- Státy přes datovou hranici (Rusko, Fidži) jsou „rozbalené“ za 180°, aby se mapa a test
  bodu v polygonu chovaly správně.

### Oblasti

| Oblast                | Poskytovatel | Výběr místa                                                                                                                                       |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Svět**              | Mapillary    | ~180 výchozích bodů po světě, náhodný posun, dlaždice pokrytí z8, jen 360° snímky.                                                                |
| **Česko + Slovensko** | Mapillary    | Náhodný bod uvnitř hranic ČR a SR, dlaždice pokrytí, a **ověření skutečné (zpřesněné) polohy snímku** uvnitř hranic. Snímek za hranicí se zahodí. |
| **Česko**             | Mapy.com     | Náhodný bod v Česku, `panoramaExists` v okruhu 400 m, ověření skutečné polohy panoramatu uvnitř hranic.                                           |

Když se v oblasti po všech pokusech nic nenajde, hra nabídne opakování a **nikdy nepoužije
místo mimo oblast**.

### Volba Města

Zaškrtávátko **Města** u výběru oblasti. Jde jen v oblasti **Česko** a **Svět** a ne v Učení.

- **Česko:** náhodné město ze seznamu asi 100 českých měst (`src/data/cities.ts`). Hra přes
  Mapy.com hledá náměstí v tom městě, přednost má hlavní náměstí (Masarykovo, Mírové, Horní…).
  Vezme panorama Mapy.com do 80 m. Potřebuje klíč Mapy.com.
- **Svět:** náhodné z 43 náměstí hlavních měst. Polohy jsou ověřené a uložené v seznamu,
  panorama vybere Mapillary (360° snímek do 100 m).
- Po kole se ukáže název náměstí a města.
- Když se ani po 8 pokusech nic nenajde, hra nabídne opakování.
- U náměstí v hlavních městech nemusí mít Mapillary 360° snímek. Taková města se přeskočí.

### Víc hráčů na jednom zařízení

- 2 až 6 hráčů, bez účtů. Jména se nesmí opakovat.
- Každé kolo hrají všichni **stejné panorama**. Hráči se střídají a před každým tahem je
  **předávací obrazovka** se jménem hráče. Čas tahu začne běžet až po stisku „Jsem X, začít“.
- Každý tah začíná na původním místě a výhledu panoramatu (prohlížeč se vytvoří znovu).
- Během tahu se neukazují tipy ostatních ani cíl. Po obnovení stránky během tahu se nejdřív
  ukáže předávací obrazovka, ne rozehraný tah.
- Po odehrání všech hráčů společný výsledek: mapa se všemi tipy (každý hráč má svou barvu),
  vzdálenosti, body za kolo a průběžný součet.
- Po 5 kolech pořadí podle součtu bodů. Při shodě mají hráči **společné pořadí**
  (1., 1., 3.).
- Předávací obrazovka zajišťuje soukromí jen organizačně. Tipy všech hráčů jsou uložené
  v prohlížeči (`localStorage`) a zvědavý hráč je tam najde.

## Režim Učení a správa výukových míst

**Hra:** typ hry **Učení** v oblasti Svět, Česko + Slovensko nebo Česko. Hrají se schválená
místa ležící v oblasti, takže v Česku platí přísnější škála a mapa začíná na Česku. Hraje se jako Klasika, ale místo náhodných
panoramat jen ručně vybraná a **schválená** místa, každé nejvýš jednou za hru. Po vyhodnocení
kola se ukáže název místa a **2 až 3 vodítka**, podle kterých šlo místo poznat. Hra má
5 kol, nebo méně, když je schválených míst méně.

**Data:** `src/data/learning-places.json`. Každé místo má:

| Pole                       | Význam                                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| `id`                       | naše stálé ID (malá písmena, číslice, pomlčky)                            |
| `title`                    | název, hráč ho uvidí až po kole                                           |
| `imageId`                  | ID 360° snímku Mapillary                                                  |
| `position`                 | poloha snímku v době výběru                                               |
| `view`                     | výchozí výhled (`center` 0..1, `zoom`), ke kterému se vztahují vodítka    |
| `hints`                    | 2 až 3 stručná česká vodítka, jen co je ve výchozím výhledu opravdu vidět |
| `status`                   | `draft` (návrh, nehraje se) nebo `approved` (ručně zkontrolováno)         |
| `reviewedBy`, `reviewedAt` | kdo a kdy místo naposledy zkontroloval (u schváleného povinné)            |
| `note`                     | poznámka pro správce                                                      |

**Ukládání a licence:** u míst Mapillary držíme ID snímku, jeho polohu a výhled. Snímky
jsou pod CC BY-SA, takže trvalé uložení ID a souřadnic je v pořádku. U míst Mapy.com
držíme jen bod panoramatu a kameru, žádný obraz ani jiná data z API; panorama se při
hře vždy najde znovu přes `panoramaExists` v okruhu 50 m. Podmínky Mapy.com trvalé
uložení jednoho bodu výslovně neřeší, při širším zveřejnění je dobré to ověřit u Seznamu.
Mapy.com se hodí pro Česko, kde Mapillary 360° snímky skoro nemá (ověřeno u Tábora,
Českých Budějovic, Třeboně a Soběslavi).

**Kdy se místo nehraje:**

- není schválené nebo nemá 2 až 3 vodítka,
- panorama u poskytovatele zmizelo (Mapillary: snímek, Mapy.com: v okruhu 50 m žádné) nebo snímek už není 360°,
- poloha snímku se oproti uložené posunula o víc než 50 m (vodítka by nemusela sedět).

Hra to ověřuje těsně před kolem (dotaz na Mapillary). Nedostupné místo přeskočí a hraje
další. Když dojdou všechna, hra skončí s odehranými koly a nezasekne se.

**Správa (editor):** odkaz „Správa výukových míst“ dole na úvodní stránce, nebo
`https://pepan53.github.io/gg/#sprava`.

1. **Přidat místo:** název a buď ID či odkaz snímku z mapillary.com, nebo souřadnice
   a „Přidat z Mapy.com“ (nejbližší panorama do 100 m, pro Česko), nebo „Najít v okolí“ (360° snímky v okolí ~150 m s náhledem, seřazené od nejbližšího).
2. Natoč panorama, aby bylo vidět to podstatné, a dej **Uložit tento výhled jako výchozí**.
3. Napiš 2 až 3 vodítka. Jen to, co je ve výchozím výhledu opravdu vidět, žádná neověřená
   tvrzení. Každá úprava vrátí místo mezi návrhy.
4. **Kontrola:** otevři místo, porovnej vodítka s panoramatem, napiš své jméno
   a dej **Zkontroloval jsem, schválit**. Schválení ověří i dostupnost snímku.
5. **Stáhnout JSON** a soubor nahraj do repozitáře jako `src/data/learning-places.json`
   (na GitHubu: složka `src/data` → Add file → Upload files → Commit). Po nasazení
   (asi 2 minuty) se změna projeví ve hře.

Změny v editoru se do té doby ukládají jen v prohlížeči (`localStorage`) a ostatní je nevidí.
Editor je veřejně dostupný, ale nic nezveřejní. Zveřejnit jde jen nahráním souboru do
repozitáře. **Pravidelná kontrola:** jednou za čas otevři editor a dej „Ověřit dostupnost
všech“; nedostupná místa oprav (nový snímek přes Najít v okolí) nebo smaž.

## Data, atribuce a licence

- **Mapillary:** snímky jsou pod CC BY-SA 4.0. Prohlížeč Mapillary ukazuje autora a odkaz
  sám. Černobílé zobrazení je úprava díla, kterou CC BY-SA dovoluje při uvedení autora
  a označení změny (lišta „Černobíle“).
- **Mapy.com:** JS Panorama zobrazuje atribuci sama. Podmínky úpravu obrazu panoramat
  výslovně neřeší, proto ji hra **nenabízí** (místo toho jde hrát černobíle v oblasti
  Česko + Slovensko z Mapillary). Před případným zapnutím je potřeba ověřit u Seznamu.
  U názvu místa zatím chybí logo Mapy.com (jen text), viz Známá omezení.
- **Mapa:** © OpenStreetMap contributors (ODbL), dlaždice OpenFreeMap. Atribuci zobrazuje
  MapLibre v rohu mapy a hra ji nepřekrývá.
- **Hranice:** Natural Earth (public domain), české názvy států z i18n-iso-countries (MIT).
  Stát cíle se určuje z naší vlastní kopie hranic; nevolá se kvůli tomu žádná služba
  poskytovatele panoramat.
- **Uložená data:** v `localStorage` je jen rozehraná hra (ID panoramat, souřadnice cílů
  a tipů, body, jména hráčů) a poslední nastavení. Hra se po 24 h nečinnosti zahodí.
  Názvy míst z Mapy.com se drží jen v paměti. Žádná databáze ani předem stažené lokace.
- Licenční podmínky jsou ověřené jen v rozsahu veřejné dokumentace (listopad 2026).
  Před širším zveřejněním je dobré přečíst [Mapillary Terms](https://www.mapillary.com/terms)
  a [podmínky Mapy.com API](https://developer.mapy.com/terms-and-conditions/).

## Známá omezení a podvádění

Varianta A **nemá server**. Celá logika včetně cíle kola běží v prohlížeči, takže technicky
zdatný hráč cíl zjistit může. Hra mu to ale ztěžuje:

| Cesta k podvodu                                                                     | Stav                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Odkaz v atribuci panoramatu (autor, logo) vede na stránku poskytovatele s polohou   | **Zavřeno:** text atribuce zůstává viditelný (licence ho vyžaduje), odkazy v panoramatu během hry nevedou nikam. V editoru míst odkazy fungují.                                                               |
| Uložená hra v `localStorage` (cíl, tipy ostatních hráčů, čas)                       | **Ztíženo:** hra je uložená zakódovaně (`gg.game.v3`, prefix `gg3:`), souřadnice ani časy nejsou čitelné a ručně upravená nebo nezakódovaná data hra odmítne. Není to bezpečné šifrování, klíč je v kódu hry. |
| Posun hodin v počítači zpět (víc času, plný násobitel v Countdownu)                 | **Zavřeno:** když hodiny couvnou o víc než 5 s oproti poslednímu uložení, běžící tah se uzavře, jako by čas vypršel (v Countdownu tedy 0 bodů).                                                               |
| Posun hodin dopředu                                                                 | Jen hráči uškodí (tah dřív vyprší).                                                                                                                                                                           |
| Vývojářské nástroje → Network (odpovědi Mapillary a Mapy.com)                       | **Nejde zavřít:** knihovny panoramat si polohu stahují samy. To platí i pro variantu se serverem.                                                                                                             |
| Proměnné v paměti stránky (ladění JavaScriptu)                                      | **Nejde zavřít** bez serveru.                                                                                                                                                                                 |
| Výuková místa v kódu hry a ve veřejném repozitáři (`src/data/learning-places.json`) | **Nejde zavřít:** bezplatné GitHub Pages vyžadují veřejný repozitář.                                                                                                                                          |
| Vypnutí černobílého filtru v nástrojích                                             | **Nejde zavřít:** obraz kreslí knihovna poskytovatele.                                                                                                                                                        |
| Hledání podle obrázku nebo porovnání s jinými mapami                                | **Nejde zavřít** v žádné variantě.                                                                                                                                                                            |

Požadavky zadání na serverové utajení, serverové vyhodnocení a ochranu odpovědí API tato
varianta **vědomě nesplňuje**. Řeší je varianta B (Cloudflare Workers + D1, také zdarma) se
stejným herním jádrem (`src/core`).

Další omezení:

- Mapillary: některé oblasti mají málo 360° snímků. Kvalita snímků kolísá (jsou od uživatelů).
  Dlaždicové načítání obrazu (`imageTiling`) je vypnuté, protože ho aktuální API odmítá;
  snímky se načítají v rozlišení 2048 px.
- Mapy.com pokrývá jen Česko, proto Česko + Slovensko jede přes Mapillary.
- Mapy.com: logo u názvu místa zatím chybí (jen text). Spotřebu kreditů za panorama je
  potřeba sledovat v účtu Mapy.com.
- Hranice 1:50m jsou zjednodušené; u hranic a pobřeží se může stát, že panorama těsně
  u hranice padne do sousedního státu. Hra pak počítá se státem podle Natural Earth.
- Hranice států zvětší stažení hry v módu Země o ~230 kB (komprimovaně), načítají se jen tam.
- Rozehraná hra z verze před zakódováním (`gg.game.v2`) se po aktualizaci nenačte.

## Struktura

```
src/core/       herní logika bez UI: vzdálenost, body, stav hry (hráči, tahy, módy), uložení, státy
src/providers/  poskytovatelé panoramat (Mapillary, Mapy.com, testovací náhrada) a název místa
src/ui/         DOM pomocníci a mapy (MapLibre): tip bodem, výběr státu, výsledek
src/data/       hranice (Natural Earth) a výchozí body pro Mapillary
src/app.ts      obrazovky: úvod, načítání, předávání, hra, výsledek kola, konec hry
tests/          Vitest (jednotkové a integrační), tests/e2e Playwright (5 rozlišení)
scripts/        generování dat hranic
```

Rozložení: na úzkém displeji (telefon, zavřený Fold) je mapa vysouvací panel přes celou
obrazovku. Na širokém displeji na šířku (PC, rozložený Fold na šířku) je mapa vedle
panoramatu, na výšku (rozložený Fold) pod ním. Složení a rozložení během kola stav neztratí.
