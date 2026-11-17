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
  if (isNarrow(page)) {
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
  const box = await canvas.boundingBox();
  if (!box) throw new Error('mapa nemá rozměr');
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  const confirm = page.getByRole('button', { name: 'Potvrdit tip' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

async function startGame(page: Page, mode: 'Svět' | 'Česko' = 'Svět', limit = 'Bez limitu') {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(`^${mode}`) }).check();
  await page.getByRole('radio', { name: limit, exact: true }).check();
  await page.getByRole('button', { name: 'Hrát' }).click();
  await expect(page.getByTestId('fake-pano')).toBeVisible();
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
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('gg.game.v1') ?? '{}'));
  expect(saved.rounds).toHaveLength(1);
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
  await expect(page.getByText('Čas vypršel, počítá se poslední poloha špendlíku.')).toBeVisible();
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
