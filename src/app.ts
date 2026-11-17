import { ROUNDS_PER_GAME, TIME_LIMITS_SEC } from './core/config';
import {
  advance,
  createGame,
  currentRound,
  expireIfNeeded,
  placePin,
  remainingMs,
  replaceTarget,
  startRound,
  submitGuess,
  totalPoints,
  type GameState,
  type Round,
} from './core/game';
import { formatDistance, type LatLng } from './core/geo';
import { MODES, type ModeDef, type ModeId, type ProviderId } from './core/modes';
import { newId } from './core/random';
import { MAX_POINTS } from './core/scoring';
import { clearGame, loadGame, saveGame } from './core/storage';
import { env } from './env';
import { MapillaryProvider } from './providers/mapillary';
import { MapyProvider } from './providers/mapy';
import { PLACE_NAME_UNAVAILABLE, fetchPlaceName } from './providers/placeName';
import { ProviderError, type PanoramaProvider, type PanoramaViewer } from './providers/types';
import { formatClock, formatLimit, formatPoints, h } from './ui/dom';
import { createGuessMap, createResultMap, type GuessMap } from './ui/maps';

type Cleanup = () => void;

const PREFS_KEY = 'gg.prefs.v1';

interface Prefs {
  mode: ModeId;
  timeLimitSec: number;
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      mode: p.mode && p.mode in MODES ? p.mode : 'world',
      timeLimitSec: TIME_LIMITS_SEC.includes(p.timeLimitSec ?? -1) ? (p.timeLimitSec as number) : 0,
    };
  } catch {
    return { mode: 'world', timeLimitSec: 0 };
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // ignorovat
  }
}

function errorText(e: unknown): string {
  if (e instanceof ProviderError) return e.message;
  if (!navigator.onLine) return 'Jsi offline. Připoj se k internetu a zkus to znovu.';
  return 'Něco se pokazilo. Zkus to znovu.';
}

export class App {
  private state: GameState | null = null;
  private cleanups: Cleanup[] = [];
  private abort: AbortController | null = null;
  /** Názvy míst jen v paměti, nikam se neukládají. */
  private placeNames = new Map<string, string | null>();
  private readonly providers: Record<ProviderId, PanoramaProvider>;

  constructor(
    private readonly root: HTMLElement,
    providers?: Record<ProviderId, PanoramaProvider>,
  ) {
    this.providers = providers ?? {
      mapillary: new MapillaryProvider(env.mapillaryToken),
      mapy: new MapyProvider(env.mapyApiKey),
    };
    window.addEventListener('online', () => this.updateOffline());
    window.addEventListener('offline', () => this.updateOffline());
  }

  start(): void {
    const saved = loadGame(Date.now());
    if (saved && saved.phase !== 'finished') {
      this.setState(expireIfNeeded(saved, Date.now()));
      this.route();
    } else {
      this.renderIntro();
    }
  }

  // ---------- stav ----------

  private setState(s: GameState): void {
    if (s === this.state) return;
    this.state = s;
    saveGame(s);
  }

  private mode(): ModeDef {
    return MODES[this.state?.mode ?? 'world'];
  }

  private provider(): PanoramaProvider {
    return this.providers[this.mode().provider];
  }

  private route(): void {
    switch (this.state?.phase) {
      case 'loading':
        return void this.loadRound();
      case 'playing':
        return this.renderGame();
      case 'result':
        return this.renderResult();
      case 'finished':
        return this.renderFinal();
      default:
        return this.renderIntro();
    }
  }

  private mount(screen: HTMLElement, focus?: HTMLElement): void {
    for (const c of this.cleanups.splice(0)) c();
    this.abort?.abort();
    this.abort = null;
    this.root.replaceChildren(screen, this.offlineBanner());
    this.updateOffline();
    (focus ?? screen.querySelector<HTMLElement>('h1, h2'))?.focus({ preventScroll: true });
  }

  private offlineBanner(): HTMLElement {
    return h(
      'div',
      { class: 'offline', role: 'status', id: 'offline', hidden: true },
      'Jsi offline. Hra počká, až se připojíš.',
    );
  }

  private updateOffline(): void {
    const el = document.getElementById('offline');
    if (el) el.hidden = navigator.onLine;
  }

  // ---------- úvod ----------

  private renderIntro(): void {
    const prefs = loadPrefs();
    const saved = loadGame(Date.now());
    const resumable = saved && saved.phase !== 'finished' ? saved : null;
    const configured = (id: ModeId) => this.providers[MODES[id].provider].isConfigured();
    if (!configured(prefs.mode)) {
      const firstOk = (Object.keys(MODES) as ModeId[]).find(configured);
      if (firstOk) prefs.mode = firstOk;
    }

    const modeInputs = (Object.values(MODES) as ModeDef[]).map((m) => {
      const ok = configured(m.id);
      return h(
        'label',
        { class: `choice${ok ? '' : ' choice--disabled'}` },
        h('input', {
          type: 'radio',
          name: 'mode',
          value: m.id,
          checked: ok && prefs.mode === m.id,
          disabled: !ok,
        }),
        h(
          'span',
          { class: 'choice__body' },
          h('strong', {}, m.name),
          h('span', {}, ok ? m.description : 'Není k dispozici: chybí klíč poskytovatele.'),
        ),
      );
    });

    const limitInputs = TIME_LIMITS_SEC.map((sec) =>
      h(
        'label',
        { class: 'pill' },
        h('input', {
          type: 'radio',
          name: 'limit',
          value: sec,
          checked: prefs.timeLimitSec === sec,
        }),
        h('span', {}, formatLimit(sec)),
      ),
    );

    const anyConfigured = (Object.keys(MODES) as ModeId[]).some(configured);
    const form = h(
      'form',
      {
        class: 'intro__form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const data = new FormData(form);
          const mode = data.get('mode') as ModeId | null;
          const limit = Number(data.get('limit') ?? 0);
          if (!mode || !configured(mode)) return;
          savePrefs({ mode, timeLimitSec: limit });
          this.newGame(mode, limit);
        },
      },
      h('fieldset', {}, h('legend', {}, 'Kde budeš hrát'), ...modeInputs),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Čas na jedno kolo'),
        h('div', { class: 'pills' }, ...limitInputs),
      ),
      h(
        'button',
        { class: 'btn btn--primary btn--big', type: 'submit', disabled: !anyConfigured },
        'Hrát',
      ),
    );

    const screen = h(
      'main',
      { class: 'screen intro' },
      h(
        'header',
        { class: 'intro__head' },
        h('p', { class: 'logo', 'aria-hidden': 'true' }, 'GG'),
        h('h1', { tabindex: -1 }, 'Kde na světě jsem?'),
        h(
          'p',
          { class: 'lead' },
          'Rozhlédni se po panoramatu a na mapě označ, kde podle tebe jsi. Čím blíž, tím víc bodů, za kolo až 5 000.',
        ),
      ),
      resumable &&
        h(
          'section',
          { class: 'card resume' },
          h(
            'p',
            {},
            `Máš rozehranou hru (${MODES[resumable.mode].name}, kolo ${Math.max(1, resumable.rounds.length)} z ${ROUNDS_PER_GAME}).`,
          ),
          h(
            'button',
            {
              class: 'btn btn--primary',
              type: 'button',
              onclick: () => {
                this.setState(expireIfNeeded(resumable, Date.now()));
                this.route();
              },
            },
            'Pokračovat',
          ),
        ),
      !anyConfigured &&
        h(
          'section',
          { class: 'card card--warn', role: 'alert' },
          h('strong', {}, 'Hra teď nemůže načíst panoramata.'),
          h(
            'p',
            {},
            'Pro provozovatele: chybí klíče VITE_MAPILLARY_TOKEN a VITE_MAPY_API_KEY. Postup je v README.',
          ),
        ),
      form,
      h(
        'footer',
        { class: 'intro__foot' },
        'Panoramata: Mapillary (CC BY-SA) a Mapy.com. Mapa: OpenFreeMap, © přispěvatelé OpenStreetMap.',
      ),
    );
    this.mount(screen);
  }

  private newGame(mode: ModeId, timeLimitSec: number): void {
    this.placeNames.clear();
    this.setState(createGame(mode, timeLimitSec, Date.now(), newId()));
    this.route();
  }

  private quitToIntro(): void {
    this.renderIntro();
  }

  // ---------- načítání kola ----------

  private async loadRound(): Promise<void> {
    const state = this.state;
    if (!state) return;
    const status = h('p', { class: 'status', role: 'status' }, 'Hledám nové místo...');
    const actions = h('div', { class: 'actions' });
    const screen = h(
      'main',
      { class: 'screen center' },
      h('h2', { tabindex: -1 }, `Kolo ${state.rounds.length + 1} z ${ROUNDS_PER_GAME}`),
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      status,
      actions,
    );
    this.mount(screen);
    const ctrl = new AbortController();
    this.abort = ctrl;
    try {
      const target = await this.provider().findRandom(this.mode(), ctrl.signal);
      if (ctrl.signal.aborted || this.state !== state) return;
      this.setState(startRound(state, target, Date.now()));
      this.route();
    } catch (e) {
      if (ctrl.signal.aborted) return;
      screen.querySelector('.spinner')?.remove();
      status.textContent = errorText(e);
      status.setAttribute('role', 'alert');
      actions.append(
        h(
          'button',
          { class: 'btn btn--primary', type: 'button', onclick: () => void this.loadRound() },
          'Zkusit znovu',
        ),
        h('button', { class: 'btn', type: 'button', onclick: () => this.quitToIntro() }, 'Na úvod'),
      );
    }
  }

  // ---------- hra ----------

  private renderGame(): void {
    const state = this.state;
    const round = state && currentRound(state);
    if (!state || !round) return this.renderIntro();

    const panoEl = h('div', { class: 'pano', 'aria-label': 'Panorama místa', role: 'region' });
    const panoOverlay = h(
      'div',
      { class: 'pano__overlay', role: 'status' },
      h('div', { class: 'spinner' }),
      'Načítám panorama...',
    );
    const timerEl = h('span', { class: 'hud__timer', 'aria-live': 'off' });
    const confirmBtn = h(
      'button',
      { class: 'btn btn--primary btn--confirm', type: 'button', disabled: true },
      'Potvrdit tip',
    );
    const mapEl = h('div', {
      class: 'guessmap',
      role: 'application',
      'aria-label': 'Mapa pro tip. Klepni na místo, kde si myslíš, že jsi.',
    });
    const mapMsg = h('p', { class: 'mapmsg', role: 'alert', hidden: true });
    const hint = h('p', { class: 'maphint' }, 'Klepni do mapy a umísti špendlík.');

    const panel = h(
      'section',
      { class: 'mappanel', 'data-state': 'closed', 'aria-label': 'Mapa pro tipování' },
      h(
        'div',
        { class: 'mappanel__bar' },
        h(
          'button',
          { class: 'btn btn--ghost mappanel__size', type: 'button', 'aria-label': 'Zvětšit mapu' },
          'Zvětšit',
        ),
        h(
          'button',
          { class: 'btn btn--ghost mappanel__close', type: 'button', 'aria-label': 'Zavřít mapu' },
          'Zavřít',
        ),
      ),
      h('div', { class: 'mappanel__map' }, mapEl, mapMsg),
      h('div', { class: 'mappanel__foot' }, hint, confirmBtn),
    );
    const openBtn = h(
      'button',
      { class: 'btn btn--primary fab', type: 'button', 'aria-expanded': 'false' },
      'Mapa a tip',
    );

    const hud = h(
      'header',
      { class: 'hud' },
      h(
        'div',
        { class: 'hud__info' },
        h('span', {}, h('small', {}, 'Kolo '), `${state.rounds.length}/${ROUNDS_PER_GAME}`),
        h('span', {}, h('small', {}, 'Body '), formatPoints(totalPoints(state))),
        state.timeLimitSec > 0 && timerEl,
      ),
      h(
        'div',
        { class: 'hud__actions' },
        h(
          'button',
          {
            class: 'btn btn--hud',
            type: 'button',
            onclick: () => viewer?.reset(),
            title: 'Zpět na výchozí místo a výhled',
          },
          'Výchozí pohled',
        ),
        h(
          'button',
          {
            class: 'btn btn--hud',
            type: 'button',
            onclick: () => this.quitToIntro(),
            title: 'Hra zůstane uložená',
          },
          'Odejít',
        ),
      ),
    );

    const screen = h(
      'main',
      { class: 'game' },
      h('h2', { class: 'sr-only', tabindex: -1 }, `Kolo ${state.rounds.length}`),
      h('div', { class: 'game__pano' }, panoEl, panoOverlay, hud, openBtn),
      panel,
    );
    this.mount(screen);

    // --- rozbalovací mapa ---
    let guessMap: GuessMap | null = null;
    const setPanel = (s: 'closed' | 'open' | 'full') => {
      panel.dataset['state'] = s;
      openBtn.setAttribute('aria-expanded', String(s !== 'closed'));
      const sizeBtn = panel.querySelector<HTMLButtonElement>('.mappanel__size');
      if (sizeBtn) {
        sizeBtn.textContent = s === 'full' ? 'Zmenšit' : 'Zvětšit';
        sizeBtn.setAttribute('aria-label', s === 'full' ? 'Zmenšit mapu' : 'Zvětšit mapu');
      }
      requestAnimationFrame(() => guessMap?.resize());
    };
    openBtn.addEventListener('click', () => {
      setPanel('open');
      panel.querySelector<HTMLButtonElement>('.mappanel__close')?.focus();
    });
    panel.querySelector('.mappanel__close')?.addEventListener('click', () => {
      setPanel('closed');
      openBtn.focus();
    });
    panel
      .querySelector('.mappanel__size')
      ?.addEventListener('click', () =>
        setPanel(panel.dataset['state'] === 'full' ? 'open' : 'full'),
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && panel.dataset['state'] !== 'closed') setPanel('closed');
    };
    document.addEventListener('keydown', onKey);
    this.cleanups.push(() => document.removeEventListener('keydown', onKey));

    const refreshConfirm = () => {
      const r = this.state && currentRound(this.state);
      confirmBtn.disabled = !r?.pin;
      hint.textContent = r?.pin
        ? 'Špendlík můžeš ještě přesunout.'
        : 'Klepni do mapy a umísti špendlík.';
    };

    const afterChange = (prev: GameState) => {
      if (this.state && this.state.phase !== prev.phase) this.route();
      else refreshConfirm();
    };

    const onPin = (p: LatLng) => {
      const prev = this.state;
      if (!prev) return;
      this.setState(placePin(prev, p, Date.now()));
      guessMap?.setPin(this.state && currentRound(this.state)?.pin ? p : null);
      afterChange(prev);
    };

    confirmBtn.addEventListener('click', () => {
      const prev = this.state;
      if (!prev) return;
      confirmBtn.disabled = true;
      this.setState(submitGuess(prev, Date.now()));
      afterChange(prev);
    });

    let destroyed = false;
    this.cleanups.push(() => {
      destroyed = true;
      guessMap?.destroy();
    });
    void createGuessMap(mapEl, this.mode().viewBBox, round.pin, onPin, () => {
      mapMsg.hidden = false;
      mapMsg.textContent = 'Mapu se nepodařilo načíst. Zkontroluj připojení a obnov stránku.';
    }).then(
      (gm) => {
        if (destroyed) return gm.destroy();
        guessMap = gm;
      },
      () => {
        mapMsg.hidden = false;
        mapMsg.textContent = 'Mapu se nepodařilo načíst. Zkontroluj připojení a obnov stránku.';
      },
    );
    refreshConfirm();

    // --- panorama ---
    let viewer: PanoramaViewer | null = null;
    const showPano = async () => {
      panoOverlay.hidden = false;
      panoOverlay.replaceChildren(h('div', { class: 'spinner' }), 'Načítám panorama...');
      try {
        const r = this.state && currentRound(this.state);
        if (!r) return;
        const v = await this.provider().createViewer(panoEl, r.target);
        if (destroyed) return v.destroy();
        viewer = v;
        panoOverlay.hidden = true;
      } catch (e) {
        if (destroyed) return;
        panoOverlay.replaceChildren(
          h(
            'p',
            { role: 'alert' },
            e instanceof ProviderError && e.kind === 'config'
              ? e.message
              : 'Panorama se nepodařilo načíst.',
          ),
          h(
            'div',
            { class: 'actions' },
            h(
              'button',
              { class: 'btn btn--primary', type: 'button', onclick: () => void showPano() },
              'Zkusit znovu',
            ),
            h(
              'button',
              { class: 'btn', type: 'button', onclick: () => void swapLocation() },
              'Jiné místo',
            ),
          ),
        );
      }
    };
    const swapLocation = async () => {
      panoOverlay.replaceChildren(h('div', { class: 'spinner' }), 'Hledám jiné místo...');
      try {
        const ctrl = new AbortController();
        this.abort = ctrl;
        const target = await this.provider().findRandom(this.mode(), ctrl.signal);
        if (destroyed || !this.state) return;
        this.setState(replaceTarget(this.state, target, Date.now()));
        this.renderGame();
      } catch (e) {
        if (destroyed) return;
        panoOverlay.replaceChildren(
          h('p', { role: 'alert' }, errorText(e)),
          h(
            'div',
            { class: 'actions' },
            h(
              'button',
              { class: 'btn btn--primary', type: 'button', onclick: () => void swapLocation() },
              'Zkusit znovu',
            ),
          ),
        );
      }
    };
    this.cleanups.push(() => viewer?.destroy());
    void showPano();

    // --- velikost (otočení, složení a rozložení Foldu) ---
    const ro = new ResizeObserver(() => {
      viewer?.resize();
      guessMap?.resize();
    });
    ro.observe(screen);
    this.cleanups.push(() => ro.disconnect());

    // --- časomíra ---
    if (state.timeLimitSec > 0) {
      const tick = () => {
        const s = this.state;
        if (!s) return;
        const rest = remainingMs(s, Date.now());
        if (rest === null) return;
        timerEl.textContent = `⏱ ${formatClock(rest)}`;
        timerEl.classList.toggle('hud__timer--low', rest <= 10_000);
        if (rest <= 0) {
          const prev = s;
          this.setState(expireIfNeeded(s, Date.now()));
          afterChange(prev);
        }
      };
      tick();
      const id = window.setInterval(tick, 250);
      this.cleanups.push(() => window.clearInterval(id));
    }
  }

  // ---------- výsledek kola ----------

  private placeNameEl(round: Round): HTMLElement {
    const el = h('span', {}, 'Zjišťuju název místa...');
    const key = round.target.panoId;
    const show = (name: string | null) => (el.textContent = name ?? PLACE_NAME_UNAVAILABLE);
    if (this.placeNames.has(key)) {
      show(this.placeNames.get(key) ?? null);
    } else {
      void fetchPlaceName(round.target.position, env.mapyApiKey).then((name) => {
        this.placeNames.set(key, name);
        show(name);
      });
    }
    return el;
  }

  private renderResult(): void {
    const state = this.state;
    const round = state && currentRound(state);
    const result = round?.result;
    if (!state || !round || !result) return this.renderIntro();
    const last = state.rounds.length >= ROUNDS_PER_GAME;

    const mapEl = h('div', {
      class: 'resultmap',
      role: 'img',
      'aria-label': 'Mapa s cílem a tvým tipem',
    });
    const verdict = result.guess
      ? h(
          'dl',
          { class: 'stats' },
          h(
            'div',
            {},
            h('dt', {}, 'Vzdálenost'),
            h('dd', {}, formatDistance(result.distanceKm ?? 0)),
          ),
          h('div', {}, h('dt', {}, 'Body'), h('dd', {}, formatPoints(result.points))),
        )
      : h(
          'p',
          { class: 'stats stats--none' },
          'Čas vypršel a netipoval jsi. Tohle kolo je za 0 bodů.',
        );

    const nextBtn = h(
      'button',
      {
        class: 'btn btn--primary btn--big',
        type: 'button',
        onclick: () => {
          this.setState(advance(state, Date.now()));
          this.route();
        },
      },
      last ? 'Celkový výsledek' : 'Další kolo',
    );

    const screen = h(
      'main',
      { class: 'screen result' },
      h('div', { class: 'result__map' }, mapEl),
      h(
        'section',
        { class: 'result__panel' },
        h('h2', { tabindex: -1 }, `Kolo ${state.rounds.length} z ${ROUNDS_PER_GAME}`),
        result.timedOut &&
          result.guess &&
          h('p', { class: 'note' }, 'Čas vypršel, počítá se poslední poloha špendlíku.'),
        verdict,
        h('p', { class: 'place' }, h('small', {}, 'Místo: '), this.placeNameEl(round)),
        h(
          'p',
          { class: 'legend' },
          h('span', { class: 'dot dot--target' }),
          'cíl',
          result.guess && h('span', { class: 'dot dot--guess' }),
          result.guess && 'tvůj tip',
        ),
        h('p', { class: 'total' }, `Celkem ${formatPoints(totalPoints(state))} bodů`),
        nextBtn,
      ),
    );
    this.mount(screen, nextBtn);

    let destroyed = false;
    let map: { resize(): void; destroy(): void } | null = null;
    this.cleanups.push(() => {
      destroyed = true;
      map?.destroy();
    });
    void createResultMap(
      mapEl,
      [{ guess: result.guess, target: round.target.position }],
      this.mode().viewBBox,
      () => {
        mapEl.append(h('p', { class: 'mapmsg', role: 'alert' }, 'Mapu se nepodařilo načíst.'));
      },
    ).then((m) => {
      if (destroyed) m.destroy();
      else map = m;
    });
    const ro = new ResizeObserver(() => map?.resize());
    ro.observe(mapEl);
    this.cleanups.push(() => ro.disconnect());
  }

  // ---------- konec hry ----------

  private renderFinal(): void {
    const state = this.state;
    if (!state) return this.renderIntro();
    const total = totalPoints(state);
    const max = MAX_POINTS * ROUNDS_PER_GAME;

    const rows = state.rounds.map((r, i) =>
      h(
        'tr',
        {},
        h('th', { scope: 'row' }, String(i + 1)),
        h('td', {}, this.placeNameEl(r)),
        h('td', {}, r.result?.guess ? formatDistance(r.result.distanceKm ?? 0) : 'bez tipu'),
        h('td', { class: 'num' }, formatPoints(r.result?.points ?? 0)),
      ),
    );
    const mapEl = h('div', { class: 'resultmap', role: 'img', 'aria-label': 'Mapa všech kol' });

    const screen = h(
      'main',
      { class: 'screen result final' },
      h('div', { class: 'result__map' }, mapEl),
      h(
        'section',
        { class: 'result__panel' },
        h('h2', { tabindex: -1 }, 'Konec hry'),
        h(
          'p',
          { class: 'bigscore' },
          h('strong', {}, formatPoints(total)),
          ` z ${formatPoints(max)} bodů`,
        ),
        h(
          'table',
          { class: 'rounds' },
          h('caption', { class: 'sr-only' }, 'Přehled kol'),
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, 'Kolo'),
              h('th', { scope: 'col' }, 'Místo'),
              h('th', { scope: 'col' }, 'Vzdálenost'),
              h('th', { scope: 'col', class: 'num' }, 'Body'),
            ),
          ),
          h('tbody', {}, ...rows),
        ),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'btn btn--primary',
              type: 'button',
              onclick: () => this.newGame(state.mode, state.timeLimitSec),
            },
            'Nová hra',
          ),
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                clearGame();
                this.state = null;
                this.renderIntro();
              },
            },
            'Na úvod',
          ),
        ),
      ),
    );
    this.mount(screen);

    let destroyed = false;
    let map: { resize(): void; destroy(): void } | null = null;
    this.cleanups.push(() => {
      destroyed = true;
      map?.destroy();
    });
    void createResultMap(
      mapEl,
      state.rounds.map((r) => ({ guess: r.result?.guess ?? null, target: r.target.position })),
      this.mode().viewBBox,
      () => mapEl.append(h('p', { class: 'mapmsg', role: 'alert' }, 'Mapu se nepodařilo načíst.')),
    ).then((m) => {
      if (destroyed) m.destroy();
      else map = m;
    });
    const ro = new ResizeObserver(() => map?.resize());
    ro.observe(mapEl);
    this.cleanups.push(() => ro.disconnect());
  }
}
