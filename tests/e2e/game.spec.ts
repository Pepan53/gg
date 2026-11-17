import { expect, test, type Page } from '@playwright/test';

/** Minimální styl mapy, aby testy nepotřebovaly dlaždice z internetu. */
const STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#cfe3ea' } }],
};

async function offline(page: Page, log: string[] = []) {
  await page.route(/^https?:\/\/(?!localhost)/, (route) => {
    const url = route.request().url();
    log.push(url);
    if (url.startsWith('https://tiles.openfreemap.org/styles/')) {
      return route.fulfill({ json: STYLE });
    }
    return route.abort();
  });
}

const isNarrow = (page: Page) => {
  const v = page.viewportSize();
  return !v || v.width < 700 || v.height < 500;
};

async function openMap(page: Page) {
  const panel = page.locator('.mappanel');
  if (isNarrow(page) && (await panel.getAttribute('data-state')) === 'closed') {
    await page.getByRole('button', { name: 'Mapa a tip' }).click();
    // Počkat na dojetí vysouvací animace panelu.
    await page.waitForTimeout(400);
  }
  const canvas = page.locator('.guessmap canvas');
  await expect(canvas).toBeVisible();
  return canvas;
}

async function guess(page: Page, dx = 0, dy = 0) {
  const canvas = await openMap(page);
  const confirm = page.getByRole('button', { name: 'Potvrdit tip' });
  // Při souběžném běhu testů se mapa může dokreslovat; klik případně zopakujeme.
  for (let attempt = 0; attempt < 3 && !(await confirm.isEnabled()); attempt++) {
    const box = await canvas.boundingBox();
    if (!box) throw new Error('mapa nemá rozměr');
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    await page.waitForTimeout(300);
  }
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

type Region = 'Svět' | 'Česko' | 'Česko + Slovensko';
const REGION_RE: Record<Region, RegExp> = {
  Svět: /^Svět /,
  Česko: /^Česko Jen Česko\./,
  'Česko + Slovensko': /^Česko \+ Slovensko/,
};

async function startGame(
  page: Page,
  region: Region = 'Svět',
  limit = 'Bez limitu',
  opts: { type?: 'Klasika' | 'Countdown' | 'Země'; gray?: boolean; players?: string[] } = {},
) {
  await page.goto('/');
  await page.getByRole('radio', { name: REGION_RE[region] }).check();
  if (opts.type) await page.getByRole('radio', { name: new RegExp(`^${opts.type} `) }).check();
  if (opts.type !== 'Countdown')
    await page.getByRole('radio', { name: limit, exact: true }).check();
  if (opts.gray) await page.getByRole('checkbox', { name: /Černobílé panorama/ }).check();
  if (opts.players) {
    await page.getByRole('radio', { name: 'Víc hráčů na jednom zařízení' }).check();
    for (let i = 2; i < opts.players.length; i++) {
      await page.getByRole('button', { name: '+ Přidat hráče' }).click();
    }
    for (const [i, name] of opts.players.entries()) {
      await page.getByRole('textbox', { name: `Jméno hráče ${i + 1}` }).fill(name);
    }
  }
  await page.getByRole('button', { name: 'Hrát' }).click();
  if (!opts.players) await expect(page.getByTestId('fake-pano')).toBeVisible();
}

/** Klikne do mapy pro tip na danou zeměpisnou polohu (testovací build zpřístupní mapu). */
async function clickLngLat(page: Page, lng: number, lat: number) {
  await openMap(page);
  await page.waitForFunction(() =>
    (window as unknown as { __ggMap?: { loaded(): boolean } }).__ggMap?.loaded(),
  );
  const pt = await page.evaluate(
    ([x, y]) => {
      const m = (
        window as unknown as {
          __ggMap: {
            project(c: [number, number]): { x: number; y: number };
            getCanvas(): HTMLCanvasElement;
          };
        }
      ).__ggMap;
      const p = m.project([x as number, y as number]);
      const r = m.getCanvas().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    },
    [lng, lat],
  );
  await page.mouse.click(pt.x, pt.y);
}

test('celá hra o pěti kolech', async ({ page }) => {
  await offline(page);
  await startGame(page, 'Česko');
  for (let i = 1; i <= 5; i++) {
    await expect(page.locator('.hud')).toContainText(`${i}/5`);
    await guess(page, 10 * i, 0);
    await expect(page.getByRole('heading', { name: `Kolo ${i} z 5` })).toBeVisible();
    await expect(page.locator('.stats')).toContainText('Vzdálenost');
    await expect(page.locator('.place')).toContainText('Název místa není k dispozici');
    await page.getByRole('button', { name: i < 5 ? 'Další kolo' : 'Celkový výsledek' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Konec hry' })).toBeVisible();
  await expect(page.locator('.bigscore')).toContainText('25');
  await expect(page.locator('.rounds tbody tr')).toHaveCount(5);
  await page.getByRole('button', { name: 'Nová hra' }).click();
  await expect(page.locator('.hud')).toContainText('1/5');
});

test('ovládací prvky se vejdou a nepřekrývají spodní okraj panoramatu', async ({ page }) => {
  await offline(page);
  await startGame(page);
  const v = page.viewportSize();
  if (!v) throw new Error('bez viewportu');
  for (const sel of ['.hud', '.mappanel']) {
    const box = await page.locator(sel).boundingBox();
    if (!box || !(await page.locator(sel).isVisible())) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(v.width + 1);
  }
  const pano = await page.locator('.game__pano').boundingBox();
  if (isNarrow(page) && pano) {
    const fab = await page.getByRole('button', { name: 'Mapa a tip' }).boundingBox();
    // Spodních 40 px panoramatu zůstává volných pro atribuci poskytovatele.
    expect((fab?.y ?? 0) + (fab?.height ?? 0)).toBeLessThan(pano.y + pano.height - 40);
    expect(fab?.height ?? 0).toBeGreaterThanOrEqual(48);
  }
  await page.screenshot({ path: `test-results/hra-${test.info().project.name}.png` });
});

test('mapa na mobilu jde otevřít přes celou obrazovku a zavřít', async ({ page }) => {
  test.skip(!isNarrow(page), 'jen úzké displeje');
  await offline(page);
  await startGame(page);
  const panel = page.locator('.mappanel');
  await expect(panel).toHaveAttribute('data-state', 'closed');
  await page.getByRole('button', { name: 'Mapa a tip' }).click();
  await expect(panel).toHaveAttribute('data-state', 'open');
  await page.getByRole('button', { name: 'Zvětšit mapu' }).click();
  await expect(panel).toHaveAttribute('data-state', 'full');
  await page.waitForTimeout(400);
  const box = await panel.boundingBox();
  expect(box?.height).toBeGreaterThan((page.viewportSize()?.height ?? 0) - 2);
  await page.getByRole('button', { name: 'Zavřít mapu' }).click();
  await expect(panel).toHaveAttribute('data-state', 'closed');
});

test('potvrzení je dostupné až po umístění špendlíku a dvojí odeslání nic nezdvojí', async ({
  page,
}) => {
  await offline(page);
  await startGame(page);
  await openMap(page);
  await expect(page.getByRole('button', { name: 'Potvrdit tip' })).toBeDisabled();
  const canvas = page.locator('.guessmap canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('mapa nemá rozměr');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const confirm = page.getByRole('button', { name: 'Potvrdit tip' });
  await confirm.dblclick();
  await expect(page.getByRole('heading', { name: 'Kolo 1 z 5' })).toBeVisible();
  const saved = await page.evaluate(() =>
    (
      window as unknown as {
        ggState: () => { rounds: { turns: { result: Record<string, number> }[] }[]; phase: string };
      }
    ).ggState(),
  );
  expect(saved.rounds).toHaveLength(1);
  expect(saved.rounds[0]?.turns).toHaveLength(1);
  expect(saved.phase).toBe('result');
});

test('obnovení stránky zachová kolo, špendlík i zbývající čas', async ({ page }) => {
  await page.clock.install();
  await offline(page);
  await startGame(page, 'Svět', '1 min');
  const canvas = await openMap(page);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('mapa nemá rozměr');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.clock.fastForward(20_000);
  await page.reload();
  await expect(page.locator('.hud')).toContainText('1/5');
  await expect(page.locator('.hud__timer')).toContainText(/0:(3\d|40|41)/);
  await openMap(page);
  await expect(page.getByRole('button', { name: 'Potvrdit tip' })).toBeEnabled();
});

test('vypršení času bez tipu dá 0 bodů a nekreslí tip', async ({ page }) => {
  await page.clock.install();
  await offline(page);
  await startGame(page, 'Svět', '1 min');
  await page.clock.fastForward(61_000);
  await expect(page.getByText('Čas vypršel a netipoval jsi.')).toBeVisible();
  await expect(page.locator('.dot--guess')).toHaveCount(0);
  await expect(page.locator('.total')).toContainText('Celkem 0 bodů');
});

test('vypršení času se špendlíkem vyhodnotí poslední polohu', async ({ page }) => {
  await page.clock.install();
  await offline(page);
  await startGame(page, 'Svět', '1 min');
  const canvas = await openMap(page);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('mapa nemá rozměr');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.clock.fastForward(61_000);
  await expect(page.getByText('Čas vypršel, počítá se poslední tip.')).toBeVisible();
  await expect(page.locator('.stats')).toContainText('Body');
});

test('bez klíčů se knihovny poskytovatelů nenačtou a hra to srozumitelně řekne', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'stačí jednou');
  const log: string[] = [];
  await offline(page, log);
  await page.goto('http://localhost:5174/');
  await expect(page.getByRole('alert')).toContainText('Hra teď nemůže načíst panoramata.');
  await expect(page.getByRole('button', { name: 'Hrát' })).toBeDisabled();
  await page.waitForTimeout(500);
  expect(log.filter((u) => /mapillary|mapy\.(cz|com)/.test(u))).toEqual([]);
});

// ---------- fáze 2 ----------

test('Countdown: 30 s na tah a body násobené zbývajícím časem', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop' && test.info().project.name !== 'mobil');
  await page.clock.install();
  await offline(page);
  await startGame(page, 'Česko', 'Bez limitu', { type: 'Countdown' });
  await expect(page.locator('.hud__timer')).toContainText(/0:(29|30)/);
  await page.clock.fastForward(15_000);
  await clickLngLat(page, 14.4213, 50.0875);
  await page.getByRole('button', { name: 'Potvrdit tip' }).click();
  await expect(page.locator('.result__panel')).toContainText('za čas');
  const saved = await page.evaluate(() =>
    (
      window as unknown as {
        ggState: () => { rounds: { turns: { result: Record<string, number> }[] }[]; phase: string };
      }
    ).ggState(),
  );
  const r = saved.rounds[0]?.turns[0]?.result ?? {};
  const mult = r['multiplier'] ?? 0;
  expect(mult).toBeGreaterThan(0.3);
  expect(mult).toBeLessThan(0.55);
  expect(r['points']).toBe(Math.round((r['basePoints'] ?? 0) * mult));
});

test('Země: výběr státu kliknutím, moře nic nevybere, správný stát 5 000 bodů', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop' && test.info().project.name !== 'mobil');
  await offline(page);
  await startGame(page, 'Svět', 'Bez limitu', { type: 'Země' });
  await clickLngLat(page, -30, 0);
  await expect(page.locator('.maphint')).toContainText('Tady žádný stát není');
  await expect(page.getByRole('button', { name: 'Potvrdit tip' })).toBeDisabled();
  await clickLngLat(page, 2.35, 46.5);
  await expect(page.locator('.maphint')).toContainText('Vybráno: Francie');
  await page.getByRole('button', { name: 'Potvrdit tip' }).click();
  await expect(page.locator('.verdict')).toContainText('Správně! 5 000 bodů');
  await expect(page.locator('.stats')).toContainText('Francie');
});

test('Země není nabízená pro Česko a černobíle ne pro Mapy.com', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop');
  await offline(page);
  await page.goto('/');
  await page.getByRole('radio', { name: REGION_RE['Česko'] }).check();
  await expect(page.getByRole('radio', { name: /^Země / })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /Černobílé panorama/ })).toBeDisabled();
  await page.getByRole('radio', { name: REGION_RE['Česko + Slovensko'] }).check();
  await expect(page.getByRole('checkbox', { name: /Černobílé panorama/ })).toBeEnabled();
});

test('Grayscale: panorama se zobrazí černobíle a je to vidět v liště', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop' && test.info().project.name !== 'fold-zavreny');
  await offline(page);
  await startGame(page, 'Česko + Slovensko', 'Bez limitu', { gray: true });
  await expect(page.locator('.pano.pano--gray')).toHaveCount(1);
  await expect(page.locator('.hud')).toContainText('Černobíle');
});

test('Víc hráčů: předávání, skryté tipy, společný výsledek a pořadí', async ({ page }) => {
  // Deset tahů trvá při souběžném běhu testů déle než výchozích 30 s.
  test.setTimeout(120_000);
  await offline(page);
  await startGame(page, 'Česko', 'Bez limitu', { players: ['Ana', 'Bob'] });
  for (let round = 1; round <= 5; round++) {
    for (const [i, name] of ['Ana', 'Bob'].entries()) {
      await expect(page.getByRole('dialog')).toContainText(`Na tahu je ${name}`);
      await page.getByRole('button', { name: `Jsem ${name}, začít` }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByTestId('fake-pano')).toBeVisible();
      await expect(page.locator('.hud')).toContainText(name);
      await openMap(page);
      // Na mapě nesmí být tip jiného hráče.
      await expect(page.locator('.guessmap .maplibregl-marker')).toHaveCount(0);
      await guess(page, i === 0 ? 0 : 40, 0);
    }
    await expect(page.getByRole('heading', { name: `Kolo ${round} z 5` })).toBeVisible();
    await expect(page.locator('.rounds tbody tr')).toHaveCount(2);
    await page.getByRole('button', { name: round < 5 ? 'Další kolo' : 'Celkový výsledek' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Konec hry' })).toBeVisible();
  await expect(page.locator('.standing')).toHaveCount(2);
  await expect(page.locator('.bigscore')).toContainText(/Vyhrává|Remíza/);
  // Klepnutí na hráče ukáže jeho kola jako v sólo hře, druhé klepnutí je skryje.
  await page.locator('.standing', { hasText: 'Bob' }).click();
  await expect(page.locator('.final__who')).toContainText('Bob');
  await expect(page.locator('.final__detail .rounds tbody tr')).toHaveCount(5);
  await page.locator('.standing', { hasText: 'Bob' }).click();
  await expect(page.locator('.final__detail .rounds')).toHaveCount(0);
});

test('Víc hráčů: obnovení stránky během tahu nejdřív ukáže předávací obrazovku', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop' && test.info().project.name !== 'mobil');
  await offline(page);
  await startGame(page, 'Svět', 'Bez limitu', { players: ['Ana', 'Bob', 'Cyril'] });
  await page.getByRole('button', { name: 'Jsem Ana, začít' }).click();
  await guess(page);
  await page.getByRole('button', { name: 'Jsem Bob, začít' }).click();
  await expect(page.getByTestId('fake-pano')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('dialog')).toContainText('Na tahu je Bob');
  // Hra pod oknem je neaktivní, dokud hráč nepotvrdí, že je u zařízení.
  await expect(page.locator('main.game')).toHaveAttribute('inert', '');
  await page.getByRole('button', { name: 'Jsem Bob, pokračovat' }).click();
  await expect(page.locator('.hud')).toContainText('Bob');
});

test('Víc hráčů: stejná jména nejdou', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop');
  await offline(page);
  await page.goto('/');
  await page.getByRole('radio', { name: 'Víc hráčů na jednom zařízení' }).check();
  await page.getByRole('textbox', { name: 'Jméno hráče 1' }).fill('Ana');
  await page.getByRole('textbox', { name: 'Jméno hráče 2' }).fill('ana');
  await page.getByRole('button', { name: 'Hrát' }).click();
  await expect(page.locator('.form-error')).toContainText('nesmí opakovat');
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: '+ Přidat hráče' }).click();
  await expect(page.getByRole('textbox')).toHaveCount(6);
  await expect(page.getByRole('button', { name: '+ Přidat hráče' })).toBeHidden();
});

// ---------- fáze 3 ----------

test('Učení: hrají se jen schválená místa a po kole se ukážou vodítka', async ({ page }) => {
  test.skip(!['desktop', 'mobil', 'fold-zavreny'].includes(test.info().project.name));
  await offline(page);
  await page.goto('/');
  await page.getByRole('radio', { name: /^Učení / }).check();
  await page.getByRole('button', { name: 'Hrát' }).click();
  // Testovací data mají 3 schválená místa (2 Mapillary, 1 Mapy.com) a 1 návrh, hra má tedy 3 kola.
  const titles: string[] = [];
  for (let i = 1; i <= 3; i++) {
    await expect(page.locator('.hud')).toContainText(`${i}/3`);
    await guess(page);
    await expect(page.locator('.hints')).toContainText('Podle čeho šlo místo poznat');
    const n = await page.locator('.hints li').count();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(3);
    titles.push((await page.locator('.place').textContent()) ?? '');
    await page.getByRole('button', { name: i < 3 ? 'Další kolo' : 'Celkový výsledek' }).click();
  }
  expect(titles.join()).not.toContain('Neschválený');
  expect(titles.join()).toContain('Tábor');
  await expect(page.locator('.bigscore')).toContainText('z 15 000 bodů');
});

test('Správa míst: úprava vrátí místo mezi návrhy, schválení chce jméno, export JSON', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop');
  await offline(page);
  await page.goto('/#sprava');
  await expect(page.getByRole('heading', { name: 'Správa výukových míst' })).toBeVisible();
  await expect(page.locator('.ed-item')).toHaveCount(4);
  await page.locator('.ed-item', { hasText: 'Praha' }).click();
  await expect(page.getByTestId('fake-pano')).toBeVisible();
  await page.getByRole('textbox', { name: 'Vodítko 3' }).fill('Nové vodítko k výhledu.');
  await expect(page.locator('.ed-item', { hasText: 'Praha' })).toContainText('Návrh');
  await page.getByRole('button', { name: 'Uložit tento výhled jako výchozí' }).click();
  await page.getByPlaceholder('Tvoje jméno').fill('');
  await page.getByRole('button', { name: 'Zkontroloval jsem, schválit' }).click();
  await expect(page.locator('.ed-status')).toContainText('napiš, kdo');
  await page.getByPlaceholder('Tvoje jméno').fill('Pepa');
  await page.getByRole('button', { name: 'Zkontroloval jsem, schválit' }).click();
  await expect(page.locator('.ed-status')).toContainText('Schváleno (Pepa');
  const json = await page.evaluate(() =>
    (window as unknown as { ggPlacesJson: () => string }).ggPlacesJson(),
  );
  const praha = JSON.parse(json).places.find((p: { id: string }) => p.id === 'test-praha');
  expect(praha).toMatchObject({
    status: 'approved',
    reviewedBy: 'Pepa',
    view: { center: [0.25, 0.5], zoom: 0.5 },
  });
  expect(praha.hints).toHaveLength(3);
  // Přidání místa přes hledání v okolí
  await page.getByRole('button', { name: 'Přidat místo' }).click();
  await page.getByPlaceholder('Např. Praha, Karlův most').fill('Brno, náměstí Svobody');
  await page.getByPlaceholder('Souřadnice').fill('49.1951, 16.6081');
  await page.getByRole('button', { name: 'Najít v okolí' }).click();
  await page.locator('.ed-result').getByRole('button', { name: 'Přidat' }).click();
  await expect(page.locator('.ed-item')).toHaveCount(5);
  await expect(page.locator('.ed-detail h2')).toContainText('Brno, náměstí Svobody');
  // Přidání místa z Mapy.com
  await page.getByRole('button', { name: 'Přidat místo' }).click();
  await page.getByPlaceholder('Např. Praha, Karlův most').fill('Soběslav, náměstí');
  await page.getByPlaceholder('Souřadnice').fill('49.2595, 14.7186');
  await page.getByRole('button', { name: 'Přidat z Mapy.com' }).click();
  await expect(page.locator('.ed-item')).toHaveCount(6);
  await expect(page.locator('.ed-detail')).toContainText('panorama Mapy.com');
  // Zpět do hry
  await page.getByRole('button', { name: 'Zpět do hry' }).click();
  await expect(page.getByRole('heading', { name: 'Kde na světě jsem?' })).toBeVisible();
});

test('uložená hra není čitelná a odkazy v panoramatu nevedou ven', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop');
  await offline(page);
  await startGame(page, 'Česko');
  const raw = await page.evaluate(() => localStorage.getItem('gg.game.v3') ?? '');
  expect(raw.startsWith('gg3:')).toBe(true);
  expect(raw).not.toContain('50.0875');
  expect(raw).not.toContain('position');
  // Odkaz vložený do panoramatu (jako atribuce poskytovatele) přijde o href.
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = 'https://example.invalid/?pos=50,14';
    a.textContent = 'autor';
    document.querySelector('.pano')?.append(a);
  });
  await expect(page.locator('.pano a')).not.toHaveAttribute('href', /.*/);
  await expect(page.locator('.pano a')).toHaveText('autor');
});
