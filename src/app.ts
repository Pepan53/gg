import { MAX_PLAYERS, ROUNDS_PER_GAME, TIME_LIMITS_SEC } from './core/config';
import { loadCountries, type CountryIndex } from './core/countries';
import {
  advance,
  beginTurn,
  citiesAllowed,
  createGame,
  currentRound,
  currentTurn,
  expireIfNeeded,
  finishEarly,
  isMultiplayer,
  placeGuess,
  playerTotal,
  remainingMs,
  replaceTarget,
  roundsOf,
  standings,
  startRound,
  submitGuess,
  turnLimitSec,
  validateSettings,
  type GameSettings,
  type GameState,
  type Guess,
  type Round,
  type Target,
  type TurnResult,
} from './core/game';
import { formatDistance, type LatLng } from './core/geo';
import {
  GAME_TYPES,
  REGIONS,
  type GameType,
  type ProviderId,
  type RegionDef,
  type RegionId,
} from './core/modes';
import { placeToTarget, playablePlaces, type LearningPlace } from './core/places';
import { pointInGeometry } from './core/polygon';
import { newId, randomItem } from './core/random';
import { checkPlace } from './learning/check';
import { publishedPlaces } from './learning/store';
import { MAX_POINTS } from './core/scoring';
import { clearGame, loadGame, saveGame } from './core/storage';
import { env } from './env';
import { MapillaryProvider } from './providers/mapillary';
import { MapyProvider } from './providers/mapy';
import { MapySquareFinder, type SquareFinder } from './providers/squares';
import { PLACE_NAME_UNAVAILABLE, fetchPlaceName } from './providers/placeName';
import { ProviderError, type PanoramaProvider, type PanoramaViewer } from './providers/types';
import { formatClock, formatLimit, formatPoints, h } from './ui/dom';
import {
  TARGET_COLOR,
  createCountryMap,
  createGuessMap,
  createResultMap,
  playerColor,
  type CountryMap,
  type GuessMap,
} from './ui/maps';

type Cleanup = () => void;

const PREFS_KEY = 'gg.prefs.v2';
/** Kolikrát zkusit jiné panorama, když v módu Země neleží v žádném státě. */
const COUNTRY_RETRIES = 6;
/** Kolik náměstí zkusit, než hra ohlásí chybu (volba Města). */
const CITY_RETRIES = 8;

type Prefs = GameSettings & { multi: boolean };

const DEFAULT_PREFS: Prefs = {
  region: 'world',
  type: 'classic',
  grayscale: false,
  cities: false,
  timeLimitSec: 0,
  players: ['Hráč 1', 'Hráč 2'],
  multi: false,
};

function loadPrefs(): Prefs {
  try {
    const p = {
      ...DEFAULT_PREFS,
      ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>),
    };
    if (!(p.region in REGIONS)) p.region = 'world';
    if (!(p.type in GAME_TYPES)) p.type = 'classic';
    if (!TIME_LIMITS_SEC.includes(p.timeLimitSec)) p.timeLimitSec = 0;
    if (!Array.isArray(p.players) || p.players.length < 2) p.players = [...DEFAULT_PREFS.players];
    p.players = p.players.slice(0, MAX_PLAYERS).map(String);
    return p;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // ignorovat
  }
}

class NoMorePlaces extends Error {
  constructor() {
    super('Žádné další dostupné schválené výukové místo.');
  }
}

function errorText(e: unknown): string {
  if (e instanceof NoMorePlaces) {
    return 'Žádné výukové místo teď není dostupné. Zkontroluj místa ve Správě výukových míst.';
  }
  if (e instanceof ProviderError) return e.message;
  if (!navigator.onLine) return 'Jsi offline. Připoj se k internetu a zkus to znovu.';
  return 'Něco se pokazilo. Zkus to znovu.';
}

const pct = (x: number) => x.toLocaleString('cs-CZ', { maximumFractionDigits: 2 });

export class App {
  private state: GameState | null = null;
  private cleanups: Cleanup[] = [];
  private abort: AbortController | null = null;
  /** Názvy míst jen v paměti, nikam se neukládají. */
  private placeNames = new Map<string, string | null>();
  /** Výuková místa, která jsou v této relaci nedostupná (přeskočí se). */
  private unavailablePlaces = new Set<string>();
  private readonly places = playablePlaces(publishedPlaces());

  /** Schválená místa v oblasti (Učení v Česku má přísnější škálu i výřez mapy). */
  private placesIn(region: RegionId): LearningPlace[] {
    const area = REGIONS[region].area;
    return area
      ? this.places.filter((p) => pointInGeometry(p.position, area.geometry))
      : this.places;
  }
  private readonly providers: Record<ProviderId, PanoramaProvider>;

  private readonly squares: SquareFinder;

  constructor(
    private readonly root: HTMLElement,
    providers?: Record<ProviderId, PanoramaProvider>,
    squares?: SquareFinder,
  ) {
    this.squares = squares ?? new MapySquareFinder(env.mapyApiKey);
    this.providers = providers ?? {
      mapillary: new MapillaryProvider(env.mapillaryToken),
      mapy: new MapyProvider(env.mapyApiKey),
    };
    window.addEventListener('online', () => this.updateOffline());
    window.addEventListener('offline', () => this.updateOffline());
  }

  private editorCleanup: (() => void) | null = null;
  private hashListening = false;

  /** Správa výukových míst na adrese #sprava. */
  private async openEditor(): Promise<void> {
    for (const c of this.cleanups.splice(0)) c();
    this.root.replaceChildren(
      h('main', { class: 'screen center' }, h('div', { class: 'spinner' })),
    );
    const { renderEditor } = await import('./ui/editor');
    this.editorCleanup = renderEditor(this.root, this.providers, () => {
      history.pushState(null, '', location.pathname);
      this.closeEditor();
    });
  }

  private closeEditor(): void {
    this.editorCleanup?.();
    this.editorCleanup = null;
    this.start(true);
  }

  start(skipEditor = false): void {
    if (!this.hashListening) {
      this.hashListening = true;
      window.addEventListener('hashchange', () => {
        if (location.hash === '#sprava') void this.openEditor();
        else if (this.editorCleanup) this.closeEditor();
      });
    }
    if (!skipEditor && location.hash === '#sprava') {
      void this.openEditor();
      return;
    }
    const saved = loadGame(Date.now());
    if (saved && saved.phase !== 'finished') {
      this.setState(expireIfNeeded(saved, Date.now()));
      // Po obnovení stránky při hře více hráčů nejdřív předávací obrazovka,
      // aby se cizí tah neukázal někomu jinému.
      if (isMultiplayer(this.state as GameState) && this.state?.phase === 'playing') {
        return this.renderGame(true);
      }
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

  private region(): RegionDef {
    return REGIONS[this.state?.settings.region ?? 'world'];
  }

  private provider(): PanoramaProvider {
    return this.providers[this.region().provider];
  }

  private route(): void {
    switch (this.state?.phase) {
      case 'loading':
        return void this.loadRound();
      case 'handoff':
        return this.renderGame();
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

  /** Mapa výsledku s úklidem při odchodu z obrazovky. */
  private mountResultMap(
    mapEl: HTMLElement,
    build: () => ReturnType<typeof createResultMap>,
  ): void {
    let destroyed = false;
    let map: { resize(): void; destroy(): void } | null = null;
    this.cleanups.push(() => {
      destroyed = true;
      map?.destroy();
    });
    void build().then(
      (m) => {
        if (destroyed) m.destroy();
        else map = m;
      },
      () => mapEl.append(h('p', { class: 'mapmsg', role: 'alert' }, 'Mapu se nepodařilo načíst.')),
    );
    const ro = new ResizeObserver(() => map?.resize());
    ro.observe(mapEl);
    this.cleanups.push(() => ro.disconnect());
  }

  // ---------- úvod ----------

  private renderIntro(): void {
    const prefs = loadPrefs();
    const saved = loadGame(Date.now());
    const resumable = saved && saved.phase !== 'finished' ? saved : null;
    const configured = (id: RegionId) => this.providers[REGIONS[id].provider].isConfigured();
    const regionIds = Object.keys(REGIONS) as RegionId[];
    const anyConfigured = regionIds.some(configured);
    if (!configured(prefs.region)) prefs.region = regionIds.find(configured) ?? 'world';

    // --- hráči ---
    const playerList = h('ol', { class: 'players' });
    const addBtn = h('button', { class: 'btn', type: 'button' }, '+ Přidat hráče');
    const renderPlayers = () => {
      playerList.replaceChildren(
        ...prefs.players.map((name, i) =>
          h(
            'li',
            {},
            h('input', {
              type: 'text',
              class: 'input',
              value: name,
              maxlength: 20,
              required: true,
              'aria-label': `Jméno hráče ${i + 1}`,
              oninput: (e: Event) => (prefs.players[i] = (e.target as HTMLInputElement).value),
            }),
            prefs.players.length > 2 &&
              h(
                'button',
                {
                  class: 'btn btn--ghost',
                  type: 'button',
                  'aria-label': `Odebrat hráče ${i + 1}`,
                  onclick: () => {
                    prefs.players.splice(i, 1);
                    renderPlayers();
                  },
                },
                'Odebrat',
              ),
          ),
        ),
      );
      addBtn.hidden = prefs.players.length >= MAX_PLAYERS;
    };
    addBtn.addEventListener('click', () => {
      prefs.players.push(`Hráč ${prefs.players.length + 1}`);
      renderPlayers();
      playerList.querySelector<HTMLInputElement>('li:last-child input')?.select();
    });
    renderPlayers();
    const playersBox = h('div', { class: 'players-box' }, playerList, addBtn);

    const whoInputs = [
      ['solo', 'Sám'],
      ['multi', 'Víc hráčů na jednom zařízení'],
    ].map(([v, label]) =>
      h(
        'label',
        { class: 'pill' },
        h('input', {
          type: 'radio',
          name: 'who',
          value: v,
          checked: (v === 'multi') === prefs.multi,
        }),
        h('span', {}, label),
      ),
    );

    // --- oblast, typ, čas, černobíle ---
    const regionInputs = regionIds.map((id) => {
      const r = REGIONS[id];
      const ok = configured(id);
      return h(
        'label',
        { class: `choice${ok ? '' : ' choice--disabled'}` },
        h('input', {
          type: 'radio',
          name: 'region',
          value: id,
          checked: ok && prefs.region === id,
          disabled: !ok,
        }),
        h(
          'span',
          { class: 'choice__body' },
          h('strong', {}, r.name),
          h('span', {}, ok ? r.description : 'Není k dispozici: chybí klíč poskytovatele.'),
        ),
      );
    });

    const typeInputs = (Object.keys(GAME_TYPES) as GameType[]).map((id) => {
      const t = GAME_TYPES[id];
      return h(
        'label',
        { class: 'choice', 'data-type': id },
        h('input', { type: 'radio', name: 'type', value: id, checked: prefs.type === id }),
        h(
          'span',
          { class: 'choice__body' },
          h('strong', {}, t.name),
          h('span', {}, t.rules),
          h('em', { class: 'choice__note', hidden: true }),
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
    const limitNote = h(
      'p',
      { class: 'field-note', hidden: true },
      'V módu Countdown má každý tah pevně 30 sekund.',
    );
    const limitPills = h('div', { class: 'pills' }, ...limitInputs);

    const grayInput = h('input', { type: 'checkbox', name: 'grayscale', checked: prefs.grayscale });
    const grayNote = h('span', { class: 'field-note' });
    const grayLabel = h(
      'label',
      { class: 'check' },
      grayInput,
      h('span', {}, h('strong', {}, 'Černobílé panorama'), grayNote),
    );

    const citiesInput = h('input', { type: 'checkbox', name: 'cities', checked: !!prefs.cities });
    const citiesNote = h('span', { class: 'field-note' });
    const citiesLabel = h(
      'label',
      { class: 'check' },
      citiesInput,
      h('span', {}, h('strong', {}, 'Města'), citiesNote),
    );

    const errorEl = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const submit = h(
      'button',
      { class: 'btn btn--primary btn--big', type: 'submit', disabled: !anyConfigured },
      'Hrát',
    );

    const form = h(
      'form',
      { class: 'intro__form', novalidate: true },
      h(
        'fieldset',
        {},
        h('legend', {}, 'Kdo hraje'),
        h('div', { class: 'pills' }, ...whoInputs),
        playersBox,
      ),
      h('fieldset', {}, h('legend', {}, 'Kde budeš hrát'), ...regionInputs, citiesLabel),
      h('fieldset', {}, h('legend', {}, 'Typ hry'), ...typeInputs),
      h('fieldset', {}, h('legend', {}, 'Čas na jeden tah'), limitPills, limitNote),
      h('fieldset', {}, h('legend', {}, 'Ztížení'), grayLabel),
      errorEl,
      submit,
    );

    const sync = () => {
      const data = new FormData(form);
      prefs.multi = data.get('who') === 'multi';
      prefs.region = (data.get('region') as RegionId | null) ?? prefs.region;
      const region = REGIONS[prefs.region];
      playersBox.hidden = !prefs.multi;
      // Typ hry dostupný jen pro některé oblasti.
      for (const label of form.querySelectorAll<HTMLLabelElement>('[data-type]')) {
        const id = label.dataset['type'] as GameType;
        const inRegion = GAME_TYPES[id].regions.includes(prefs.region);
        const hasPlaces = id !== 'learning' || this.placesIn(prefs.region).length > 0;
        const allowed = inRegion && hasPlaces;
        const input = label.querySelector('input') as HTMLInputElement;
        input.disabled = !allowed;
        label.classList.toggle('choice--disabled', !allowed);
        const note = label.querySelector<HTMLElement>('.choice__note');
        if (note) {
          note.hidden = allowed;
          note.textContent = allowed
            ? ''
            : !inRegion
              ? 'Jen v oblasti Svět.'
              : 'V této oblasti zatím není žádné schválené místo.';
        }
        if (!allowed && input.checked) {
          input.checked = false;
          (form.querySelector('input[name="type"][value="classic"]') as HTMLInputElement).checked =
            true;
        }
      }
      prefs.type = (new FormData(form).get('type') as GameType | null) ?? 'classic';
      const fixed = GAME_TYPES[prefs.type].fixedTimeSec;
      limitPills.hidden = !!fixed;
      limitNote.hidden = !fixed;
      prefs.timeLimitSec = Number(data.get('limit') ?? 0);
      grayInput.disabled = !region.grayscaleAllowed;
      if (!region.grayscaleAllowed) grayInput.checked = false;
      grayNote.textContent = region.grayscaleAllowed
        ? 'Bez barev se místo hádá hůř. Snímek se jen zobrazí černobíle.'
        : 'U panoramat Mapy.com není úprava obrazu podle podmínek ověřená, proto ji nenabízíme.';
      prefs.grayscale = grayInput.checked;
      const scope = prefs.region === 'cz' ? 'cz' : 'world';
      const citiesOk = citiesAllowed(prefs.region, prefs.type) && this.squares.isConfigured(scope);
      citiesInput.disabled = !citiesOk;
      if (!citiesOk) citiesInput.checked = false;
      citiesNote.textContent = !this.squares.isConfigured(scope)
        ? 'Potřebuje klíč Mapy.com.'
        : prefs.type === 'learning'
          ? 'V Učení se hrají ručně vybraná místa.'
          : prefs.region === 'czsk'
            ? 'Jen v oblasti Česko nebo Svět.'
            : prefs.region === 'cz'
              ? 'Místo bude vždy na náměstí některého českého města.'
              : 'Místo bude vždy na náměstí některého hlavního města.';
      prefs.cities = citiesInput.checked;
    };
    form.addEventListener('change', sync);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      sync();
      if (!configured(prefs.region)) return;
      const settings: GameSettings = {
        region: prefs.region,
        type: prefs.type,
        grayscale: prefs.grayscale,
        cities: prefs.cities || undefined,
        timeLimitSec: prefs.timeLimitSec,
        players: prefs.multi ? prefs.players.map((p) => p.trim()) : ['Ty'],
        rounds:
          prefs.type === 'learning'
            ? Math.min(ROUNDS_PER_GAME, this.placesIn(prefs.region).length)
            : undefined,
      };
      const err = validateSettings(settings);
      errorEl.hidden = !err;
      errorEl.textContent = err ?? '';
      if (err) return;
      savePrefs(prefs);
      this.newGame(settings);
    });

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
          'Rozhlédni se po panoramatu a na mapě označ, kde podle tebe jsi. Hra má 5 kol, za každé až 5 000 bodů.',
        ),
      ),
      resumable &&
        h(
          'section',
          { class: 'card resume' },
          h(
            'p',
            {},
            `Máš rozehranou hru (${REGIONS[resumable.settings.region].name}, ${GAME_TYPES[resumable.settings.type].name}, kolo ${Math.max(1, resumable.rounds.length)} z ${roundsOf(resumable)}).`,
          ),
          h(
            'button',
            {
              class: 'btn btn--primary',
              type: 'button',
              onclick: () => {
                this.setState(expireIfNeeded(resumable, Date.now()));
                if (isMultiplayer(resumable) && this.state?.phase === 'playing')
                  this.renderGame(true);
                else this.route();
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
        'Panoramata: Mapillary (CC BY-SA) a Mapy.com. Mapa: OpenFreeMap, © přispěvatelé OpenStreetMap. Hranice států: Natural Earth. ',
        h('a', { href: '#sprava' }, 'Správa výukových míst'),
      ),
    );
    this.mount(screen);
    sync();
  }

  private newGame(settings: GameSettings): void {
    this.placeNames.clear();
    this.setState(createGame(settings, Date.now(), newId()));
    this.route();
  }

  private quitToIntro(): void {
    this.renderIntro();
  }

  // ---------- načítání kola ----------

  /** Najde panorama; v módu Země jen takové, které leží v některém státě. */
  /** Další dostupné schválené výukové místo, které se v této hře ještě nehrálo. */
  private async nextLearningTarget(signal: AbortSignal): Promise<Target> {
    const used = new Set(this.state?.rounds.map((r) => r.target.placeId));
    for (;;) {
      const candidates = this.placesIn(this.state?.settings.region ?? 'world').filter(
        (p) => !used.has(p.id) && !this.unavailablePlaces.has(p.id),
      );
      const place = randomItem(candidates);
      if (!place) throw new NoMorePlaces();
      const a = await checkPlace(place, this.providers, signal);
      // Cílem je skutečná poloha panoramatu, jak ji poskytovatel vrátil teď.
      if (a.ok) return placeToTarget(place, a.position);
      if (a.reason === 'network') {
        throw new ProviderError('Nepodařilo se ověřit výukové místo. Zkus to znovu.', 'network');
      }
      // Nedostupné nebo posunuté místo se do hry nezařadí, dokud ho někdo nezkontroluje.
      this.unavailablePlaces.add(place.id);
      used.add(place.id);
    }
  }

  /** Volba Města: panorama na náměstí (Česko) nebo na náměstí hlavního města (svět). */
  private async cityTarget(signal: AbortSignal): Promise<Target> {
    const settings = this.state?.settings;
    const scope = settings?.region === 'cz' ? 'cz' : 'world';
    const provider = this.provider();
    for (let i = 0; i < CITY_RETRIES; i++) {
      if (signal.aborted) throw new DOMException('Zrušeno', 'AbortError');
      const sq = await this.squares.random(scope, signal);
      if (!sq || !provider.findNear) continue;
      const t = await provider.findNear(sq.position, scope === 'cz' ? 80 : 100, signal);
      if (!t) continue;
      const target: Target = { ...t, label: sq.label };
      if (settings?.type === 'country') {
        const f = (await loadCountries()).countryAt(target.position);
        if (!f) continue;
        target.country = f.properties.code;
      }
      return target;
    }
    throw new ProviderError('Nepodařilo se najít panorama na náměstí. Zkus to znovu.', 'not-found');
  }

  private async findTarget(signal: AbortSignal): Promise<Target> {
    const settings = this.state?.settings;
    if (settings?.type === 'learning') return this.nextLearningTarget(signal);
    if (settings?.cities) return this.cityTarget(signal);
    if (settings?.type !== 'country') return this.provider().findRandom(this.region(), signal);
    const countries = await loadCountries();
    for (let i = 0; i < COUNTRY_RETRIES; i++) {
      const t = await this.provider().findRandom(this.region(), signal);
      const f = countries.countryAt(t.position);
      if (f) return { ...t, country: f.properties.code };
    }
    throw new ProviderError(
      'Nepodařilo se najít panorama v žádném státě. Zkus to znovu.',
      'not-found',
    );
  }

  private async loadRound(): Promise<void> {
    const state = this.state;
    if (!state) return;
    const status = h('p', { class: 'status', role: 'status' }, 'Hledám nové místo...');
    const actions = h('div', { class: 'actions' });
    const screen = h(
      'main',
      { class: 'screen center' },
      h('h2', { tabindex: -1 }, `Kolo ${state.rounds.length + 1} z ${roundsOf(state)}`),
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      status,
      actions,
    );
    this.mount(screen);
    const ctrl = new AbortController();
    this.abort = ctrl;
    try {
      const target = await this.findTarget(ctrl.signal);
      if (ctrl.signal.aborted || this.state !== state) return;
      this.setState(startRound(state, target, Date.now()));
      this.route();
    } catch (e) {
      if (ctrl.signal.aborted) return;
      if (e instanceof NoMorePlaces && state.rounds.length > 0) {
        // Došla dostupná místa: hra skončí s odehranými koly.
        this.setState(finishEarly(state, Date.now()));
        return this.route();
      }
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

  // ---------- předávací okno ----------

  /**
   * Okno nad hrou: kdo je na tahu. Pozadí je rozmazané, takže se nic neprozradí,
   * a obrazovka nepřeblikává (panorama se zatím načítá pod oknem).
   */
  private handoffGate(resume: boolean, onStart: () => void): HTMLElement {
    const state = this.state as GameState;
    const name = state.settings.players[state.current] ?? '';
    const limit = turnLimitSec(state.settings);
    return h(
      'div',
      { class: 'gate' },
      h(
        'div',
        {
          class: 'gate__card',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'gate-title',
        },
        h('p', { class: 'handoff__round' }, `Kolo ${state.rounds.length} z ${roundsOf(state)}`),
        h(
          'span',
          {
            class: 'avatar',
            style: `background:${playerColor(state.current)}`,
            'aria-hidden': 'true',
          },
          name.slice(0, 1).toUpperCase(),
        ),
        h('h2', { id: 'gate-title', tabindex: -1 }, `Na tahu je ${name}`),
        h(
          'p',
          { class: 'status' },
          resume
            ? 'Tah už běží a čas se počítá dál. Předej zařízení hráči, který je na tahu.'
            : 'Předej mu zařízení. Ostatní se teď nedívejte, ať je hra férová.',
        ),
        limit > 0 &&
          !resume &&
          h(
            'p',
            { class: 'field-note' },
            `Čas na tah: ${formatLimit(limit)}. Začne běžet po stisku tlačítka.`,
          ),
        h(
          'button',
          { class: 'btn btn--primary btn--big gate__start', type: 'button', onclick: onStart },
          resume ? `Jsem ${name}, pokračovat` : `Jsem ${name}, začít`,
        ),
        h(
          'button',
          { class: 'btn btn--ghost', type: 'button', onclick: () => this.quitToIntro() },
          'Odejít (hra zůstane uložená)',
        ),
      ),
    );
  }

  // ---------- hra ----------

  private renderGame(resume = false): void {
    const state = this.state;
    const round = state && currentRound(state);
    const turn = state && currentTurn(state);
    if (!state || !round || !turn) return this.renderIntro();
    const settings = state.settings;
    const multi = isMultiplayer(state);
    const countryMode = settings.type === 'country';
    const color = playerColor(state.current);
    const limitSec = turnLimitSec(settings);
    const region = this.region();

    const panoEl = h('div', {
      // Černobíle jen u Mapillary (u Mapy.com úprava obrazu není ověřená).
      class: `pano${settings.grayscale && round.target.provider === 'mapillary' ? ' pano--gray' : ''}`,
      'aria-label': 'Panorama místa',
      role: 'region',
    });
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
      'aria-label': countryMode
        ? 'Mapa pro tip. Klepni na stát, ve kterém si myslíš, že jsi.'
        : 'Mapa pro tip. Klepni na místo, kde si myslíš, že jsi.',
    });
    const mapMsg = h('p', { class: 'mapmsg', role: 'alert', hidden: true });
    const hint = h('p', { class: 'maphint', 'aria-live': 'polite' });

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
        multi &&
          h(
            'span',
            { class: 'hud__player', style: `box-shadow: inset 4px 0 0 ${color}` },
            settings.players[state.current] ?? '',
          ),
        h('span', {}, h('small', {}, 'Kolo '), `${state.rounds.length}/${roundsOf(state)}`),
        h('span', {}, h('small', {}, 'Body '), formatPoints(playerTotal(state, state.current))),
        limitSec > 0 && timerEl,
        settings.grayscale &&
          h('span', { title: 'Snímek je upravený: zobrazený černobíle' }, 'Černobíle'),
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
      h(
        'h2',
        { class: 'sr-only', tabindex: -1 },
        `Kolo ${state.rounds.length}${multi ? `, hraje ${settings.players[state.current]}` : ''}`,
      ),
      h('div', { class: 'game__pano' }, panoEl, panoOverlay, hud, openBtn),
      panel,
    );

    // Předávací okno nad hrou (víc hráčů): při předání tahu nebo po obnovení stránky.
    const gated = state.phase === 'handoff' || (resume && multi);
    let gate: HTMLElement | null = null;
    if (gated) {
      gate = this.handoffGate(state.phase !== 'handoff', () => {
        const s = this.state;
        if (!s) return;
        this.setState(
          s.phase === 'handoff' ? beginTurn(s, Date.now()) : expireIfNeeded(s, Date.now()),
        );
        if (this.state && this.state.phase !== 'playing') return this.route();
        gate?.remove();
        gate = null;
        screen.removeAttribute('inert');
        (screen.querySelector('h2') as HTMLElement | null)?.focus({ preventScroll: true });
      });
      screen.setAttribute('inert', '');
    }
    this.mount(gate ? h('div', { class: 'gate-wrap' }, screen, gate) : screen);
    gate?.querySelector<HTMLElement>('.gate__start')?.focus();

    // --- rozbalovací mapa ---
    let guessMap: GuessMap | null = null;
    let countryMap: CountryMap | null = null;
    let countries: CountryIndex | null = null;
    const resizeMaps = () => {
      guessMap?.resize();
      countryMap?.resize();
    };
    const setPanel = (s: 'closed' | 'open' | 'full') => {
      panel.dataset['state'] = s;
      openBtn.setAttribute('aria-expanded', String(s !== 'closed'));
      const sizeBtn = panel.querySelector<HTMLButtonElement>('.mappanel__size');
      if (sizeBtn) {
        sizeBtn.textContent = s === 'full' ? 'Zmenšit' : 'Zvětšit';
        sizeBtn.setAttribute('aria-label', s === 'full' ? 'Zmenšit mapu' : 'Zvětšit mapu');
      }
      requestAnimationFrame(resizeMaps);
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

    let seaClick = false;
    const refreshConfirm = () => {
      const pending = this.state && currentTurn(this.state)?.pending;
      confirmBtn.disabled = !pending;
      if (countryMode) {
        if (seaClick) hint.textContent = 'Tady žádný stát není. Klepni na pevninu.';
        else if (pending?.kind === 'country')
          hint.textContent = `Vybráno: ${countries?.nameOf(pending.code) ?? pending.code}`;
        else hint.textContent = 'Klepni do mapy na stát.';
      } else {
        hint.textContent = pending
          ? 'Špendlík můžeš ještě přesunout.'
          : 'Klepni do mapy a umísti špendlík.';
      }
    };

    const afterChange = (prev: GameState) => {
      if (this.state && (this.state.phase !== prev.phase || this.state.current !== prev.current))
        this.route();
      else refreshConfirm();
    };

    const apply = (guess: Guess) => {
      const prev = this.state;
      if (!prev) return;
      this.setState(placeGuess(prev, guess, Date.now()));
      afterChange(prev);
    };

    const onPin = (p: LatLng) => {
      apply({ kind: 'point', point: p });
      const pending = this.state && currentTurn(this.state)?.pending;
      guessMap?.setPin(pending?.kind === 'point' ? pending.point : null);
    };
    const onCountry = (code: string | null) => {
      seaClick = code === null;
      if (code) apply({ kind: 'country', code });
      else refreshConfirm();
      const pending = this.state && currentTurn(this.state)?.pending;
      countryMap?.select(pending?.kind === 'country' ? pending.code : null);
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
      countryMap?.destroy();
    });
    const mapFailed = () => {
      mapMsg.hidden = false;
      mapMsg.textContent = 'Mapu se nepodařilo načíst. Zkontroluj připojení a obnov stránku.';
    };
    const pending = turn.pending;
    if (countryMode) {
      void loadCountries()
        .then((idx) => {
          countries = idx;
          refreshConfirm();
          return createCountryMap(
            mapEl,
            region.viewBBox,
            idx,
            pending?.kind === 'country' ? pending.code : null,
            color,
            onCountry,
            mapFailed,
          );
        })
        .then((cm) => {
          if (destroyed) return cm.destroy();
          countryMap = cm;
        }, mapFailed);
    } else {
      void createGuessMap(
        mapEl,
        region.viewBBox,
        pending?.kind === 'point' ? pending.point : null,
        color,
        onPin,
        mapFailed,
      ).then((gm) => {
        if (destroyed) return gm.destroy();
        guessMap = gm;
      }, mapFailed);
    }
    refreshConfirm();

    // --- panorama (každý tah začíná na výchozím místě a výhledu) ---
    let viewer: PanoramaViewer | null = null;
    const showPano = async () => {
      panoOverlay.hidden = false;
      panoOverlay.replaceChildren(h('div', { class: 'spinner' }), 'Načítám panorama...');
      try {
        const r = this.state && currentRound(this.state);
        if (!r) return;
        const v = await this.providers[r.target.provider].createViewer(panoEl, r.target);
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
          multi
            ? h('p', { class: 'field-note' }, 'Jiné místo začne kolo znovu pro všechny hráče.')
            : '',
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
      const failedPlace = this.state && currentRound(this.state)?.target.placeId;
      if (failedPlace) this.unavailablePlaces.add(failedPlace);
      panoOverlay.replaceChildren(h('div', { class: 'spinner' }), 'Hledám jiné místo...');
      try {
        const ctrl = new AbortController();
        this.abort = ctrl;
        const target = await this.findTarget(ctrl.signal);
        if (destroyed || !this.state) return;
        this.setState(replaceTarget(this.state, target, Date.now()));
        this.route();
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
    // Odkazy v panoramatu (atribuce, logo) vedou na stránky poskytovatele i s polohou.
    // Text atribuce necháváme viditelný, jen bez prokliku.
    const unlink = () => {
      for (const a of panoEl.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        a.removeAttribute('href');
        a.removeAttribute('target');
        a.setAttribute('tabindex', '-1');
        a.classList.add('pano-unlinked');
      }
    };
    const mo = new MutationObserver(unlink);
    mo.observe(panoEl, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['href'],
    });
    this.cleanups.push(() => mo.disconnect());
    void showPano();

    // --- velikost (otočení, složení a rozložení Foldu) ---
    const ro = new ResizeObserver(() => {
      viewer?.resize();
      resizeMaps();
    });
    ro.observe(screen);
    this.cleanups.push(() => ro.disconnect());

    // --- časomíra ---
    if (limitSec > 0) {
      const tick = () => {
        const s = this.state;
        if (!s) return;
        const rest = remainingMs(s, Date.now());
        if (rest === null) return;
        const mult = settings.type === 'countdown' ? ` · ×${pct(rest / 1000 / limitSec)}` : '';
        timerEl.textContent = `⏱ ${formatClock(rest)}${mult}`;
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

  private placeOf(round: Round): LearningPlace | undefined {
    const id = round.target.placeId;
    return id ? this.places.find((p) => p.id === id) : undefined;
  }

  /** Vodítka výukového místa, zobrazují se až po vyhodnocení kola. */
  private hintsEl(round: Round): HTMLElement | null {
    const place = this.placeOf(round);
    if (!place) return null;
    return h(
      'section',
      { class: 'hints', 'aria-labelledby': 'hints-title' },
      h('h3', { id: 'hints-title' }, 'Podle čeho šlo místo poznat'),
      h('ul', {}, ...place.hints.filter((x) => x.trim()).map((x) => h('li', {}, x))),
    );
  }

  private placeNameEl(round: Round): HTMLElement {
    const curated = this.placeOf(round);
    if (curated) return h('span', {}, curated.title);
    if (round.target.label) return h('span', {}, round.target.label);
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

  /** Popis tipu jednoho hráče pro tabulku a přehled. */
  private guessText(r: TurnResult | null, countries: CountryIndex | null): string {
    if (!r?.guess) return 'bez tipu';
    if (r.guess.kind === 'country') return countries?.nameOf(r.guess.code) ?? r.guess.code;
    return formatDistance(r.distanceKm ?? 0);
  }

  private pointsText(r: TurnResult | null, countdown: boolean): string {
    if (!r) return '0';
    if (countdown && r.guess && !r.timedOut) {
      return `${formatPoints(r.points)} (${formatPoints(r.basePoints)} × ${pct(r.multiplier)})`;
    }
    return formatPoints(r.points);
  }

  private renderResult(): void {
    const state = this.state;
    const round = state && currentRound(state);
    if (!state || !round) return this.renderIntro();
    void (state.settings.type === 'country' ? loadCountries() : Promise.resolve(null)).then((c) =>
      this.renderResultWith(c),
    );
  }

  private renderResultWith(countries: CountryIndex | null): void {
    const state = this.state;
    const round = state && currentRound(state);
    if (!state || !round || state.phase !== 'result') return;
    const settings = state.settings;
    const multi = isMultiplayer(state);
    const countryMode = settings.type === 'country';
    const countdown = settings.type === 'countdown';
    const last = state.rounds.length >= roundsOf(state);
    const targetCountry = round.target.country;

    const mapEl = h('div', {
      class: 'resultmap',
      role: 'img',
      'aria-label': 'Mapa s cílem a tipy',
    });

    let body: HTMLElement;
    if (!multi) {
      const r = round.turns[0]?.result ?? null;
      const timeoutNote =
        r?.timedOut && r.guess
          ? h(
              'p',
              { class: 'note' },
              countdown
                ? 'Čas vypršel. Tip se vyhodnotil, ale časový násobitel je 0.'
                : 'Čas vypršel, počítá se poslední tip.',
            )
          : null;
      if (!r?.guess) {
        body = h(
          'div',
          {},
          h(
            'p',
            { class: 'stats stats--none' },
            'Čas vypršel a netipoval jsi. Tohle kolo je za 0 bodů.',
          ),
        );
      } else if (countryMode) {
        body = h(
          'div',
          {},
          timeoutNote,
          h(
            'dl',
            { class: 'stats' },
            h(
              'div',
              {},
              h('dt', {}, 'Tvůj stát'),
              h('dd', { class: 'dd--text' }, this.guessText(r, countries)),
            ),
            h(
              'div',
              {},
              h('dt', {}, 'Správně'),
              h('dd', { class: 'dd--text' }, countries?.nameOf(targetCountry ?? '') ?? ''),
            ),
          ),
          h(
            'p',
            { class: `verdict ${r.points > 0 ? 'verdict--ok' : 'verdict--bad'}` },
            r.points > 0 ? `Správně! ${formatPoints(r.points)} bodů` : 'Vedle. 0 bodů',
          ),
        );
      } else {
        body = h(
          'div',
          {},
          timeoutNote,
          h(
            'dl',
            { class: 'stats' },
            h('div', {}, h('dt', {}, 'Vzdálenost'), h('dd', {}, formatDistance(r.distanceKm ?? 0))),
            h('div', {}, h('dt', {}, 'Body'), h('dd', {}, formatPoints(r.points))),
          ),
          countdown &&
            !r.timedOut &&
            h(
              'p',
              { class: 'field-note' },
              `${formatPoints(r.basePoints)} bodů za vzdálenost × ${pct(r.multiplier)} za čas`,
            ),
        );
      }
    } else {
      body = h(
        'table',
        { class: 'rounds' },
        h('caption', { class: 'sr-only' }, 'Výsledky hráčů v tomto kole'),
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col' }, 'Hráč'),
            h('th', { scope: 'col' }, countryMode ? 'Tip' : 'Vzdálenost'),
            h('th', { scope: 'col', class: 'num' }, 'Kolo'),
            h('th', { scope: 'col', class: 'num' }, 'Celkem'),
          ),
        ),
        h(
          'tbody',
          {},
          ...settings.players.map((name, i) => {
            const r = round.turns[i]?.result ?? null;
            return h(
              'tr',
              {},
              h(
                'th',
                { scope: 'row' },
                h('span', { class: 'dot', style: `background:${playerColor(i)}` }),
                ` ${name}`,
              ),
              h('td', {}, this.guessText(r, countries), r?.timedOut ? ' (čas)' : ''),
              h('td', { class: 'num' }, this.pointsText(r, countdown)),
              h('td', { class: 'num' }, formatPoints(playerTotal(state, i))),
            );
          }),
        ),
      );
    }

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
        h('h2', { tabindex: -1 }, `Kolo ${state.rounds.length} z ${roundsOf(state)}`),
        body,
        countryMode &&
          multi &&
          h(
            'p',
            { class: 'place' },
            h('small', {}, 'Správný stát: '),
            countries?.nameOf(targetCountry ?? '') ?? '',
          ),
        h('p', { class: 'place' }, h('small', {}, 'Místo: '), this.placeNameEl(round)),
        this.hintsEl(round),
        h(
          'p',
          { class: 'legend' },
          h('span', { class: 'dot', style: `background:${TARGET_COLOR}` }),
          'cíl',
          !multi &&
            round.turns[0]?.result?.guess &&
            h('span', { class: 'dot dot--gap', style: `background:${playerColor(0)}` }),
          !multi && round.turns[0]?.result?.guess && 'tvůj tip',
        ),
        !multi && h('p', { class: 'total' }, `Celkem ${formatPoints(playerTotal(state, 0))} bodů`),
        nextBtn,
      ),
    );
    this.mount(screen, nextBtn);

    const entries = settings.players.map((name, i) => {
      const g = round.turns[i]?.result?.guess;
      return {
        guess: g?.kind === 'point' ? g.point : null,
        target: round.target.position,
        color: playerColor(i),
        label: name,
      };
    });
    const highlights = countryMode
      ? [
          ...settings.players.flatMap((_, i) => {
            const g = round.turns[i]?.result?.guess;
            return g?.kind === 'country' && g.code !== targetCountry
              ? [{ code: g.code, color: playerColor(i) }]
              : [];
          }),
          ...(targetCountry ? [{ code: targetCountry, color: TARGET_COLOR }] : []),
        ]
      : [];
    this.mountResultMap(mapEl, () =>
      createResultMap(
        mapEl,
        entries,
        this.region().viewBBox,
        () =>
          mapEl.append(h('p', { class: 'mapmsg', role: 'alert' }, 'Mapu se nepodařilo načíst.')),
        countries ? { index: countries, highlights } : undefined,
      ),
    );
  }

  // ---------- konec hry ----------

  /** Tabulka kol jednoho hráče (stejná jako v sólo hře). */
  private roundsTable(
    state: GameState,
    player: number,
    countries: CountryIndex | null,
  ): HTMLElement {
    const countdown = state.settings.type === 'countdown';
    return h(
      'table',
      { class: 'rounds' },
      h('caption', { class: 'sr-only' }, `Přehled kol: ${state.settings.players[player] ?? ''}`),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, 'Kolo'),
          h('th', { scope: 'col' }, 'Místo'),
          h('th', { scope: 'col' }, state.settings.type === 'country' ? 'Tip' : 'Vzdálenost'),
          h('th', { scope: 'col', class: 'num' }, 'Body'),
        ),
      ),
      h(
        'tbody',
        {},
        ...state.rounds.map((r, i) => {
          const res = r.turns[player]?.result ?? null;
          return h(
            'tr',
            {},
            h('th', { scope: 'row' }, String(i + 1)),
            h('td', {}, this.placeNameEl(r)),
            h('td', {}, this.guessText(res, countries)),
            h('td', { class: 'num' }, this.pointsText(res, countdown)),
          );
        }),
      ),
    );
  }

  private renderFinal(): void {
    const state = this.state;
    if (!state) return this.renderIntro();
    const settings = state.settings;
    void (settings.type === 'country' ? loadCountries() : Promise.resolve(null)).then(
      (countries) => {
        if (this.state !== state) return;
        this.renderFinalWith(state, countries);
      },
    );
  }

  private renderFinalWith(state: GameState, countries: CountryIndex | null): void {
    const settings = state.settings;
    const multi = isMultiplayer(state);
    const max = MAX_POINTS * roundsOf(state);
    /** Hráč rozkliknutý v pořadí (víc hráčů), null = přehled všech. */
    let selected: number | null = multi ? null : 0;

    const mapEl = h('div', { class: 'resultmap', role: 'img', 'aria-label': 'Mapa všech kol' });
    const detail = h('div', { class: 'final__detail', 'aria-live': 'polite' });
    const rowButtons: HTMLButtonElement[] = [];

    let summary: HTMLElement;
    if (multi) {
      const st = standings(state);
      const top = st.filter((x) => x.rank === 1);
      summary = h(
        'div',
        {},
        h(
          'p',
          { class: 'bigscore' },
          top.length > 1
            ? `Remíza: ${top.map((t) => t.name).join(', ')}`
            : `Vyhrává ${top[0]?.name ?? ''}`,
        ),
        h('p', { class: 'field-note' }, 'Klepni na hráče a uvidíš jeho kola.'),
        h(
          'ol',
          { class: 'standings-list' },
          ...st.map((x) => {
            const btn = h(
              'button',
              {
                class: 'standing',
                type: 'button',
                'aria-pressed': 'false',
                'data-player': x.player,
                onclick: () => select(selected === x.player ? null : x.player),
              },
              h('span', { class: 'standing__rank' }, `${x.rank}.`),
              h('span', { class: 'dot', style: `background:${playerColor(x.player)}` }),
              h('span', { class: 'standing__name' }, x.name),
              h(
                'span',
                { class: 'standing__pts' },
                `${formatPoints(x.points)} / ${formatPoints(max)}`,
              ),
            );
            rowButtons.push(btn);
            return h('li', {}, btn);
          }),
        ),
        detail,
      );
    } else {
      summary = h(
        'div',
        {},
        h(
          'p',
          { class: 'bigscore' },
          h('strong', {}, formatPoints(playerTotal(state, 0))),
          ` z ${formatPoints(max)} bodů`,
        ),
        this.roundsTable(state, 0, countries),
      );
    }

    const screen = h(
      'main',
      { class: 'screen result final' },
      h('div', { class: 'result__map' }, mapEl),
      h(
        'section',
        { class: 'result__panel' },
        h('h2', { tabindex: -1 }, 'Konec hry'),
        summary,
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            { class: 'btn btn--primary', type: 'button', onclick: () => this.newGame(settings) },
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

    // Mapa: všichni hráči, nebo jen rozkliknutý hráč.
    let map: { resize(): void; destroy(): void } | null = null;
    let version = 0;
    const drawMap = () => {
      const v = ++version;
      map?.destroy();
      map = null;
      mapEl.replaceChildren();
      const players = selected === null ? settings.players.map((_, i) => i) : [selected];
      const entries = state.rounds.flatMap((r) =>
        players.map((i) => {
          const g = r.turns[i]?.result?.guess;
          return {
            guess: g?.kind === 'point' ? g.point : null,
            target: r.target.position,
            color: playerColor(i),
          };
        }),
      );
      void createResultMap(mapEl, entries, this.region().viewBBox, () =>
        mapEl.append(h('p', { class: 'mapmsg', role: 'alert' }, 'Mapu se nepodařilo načíst.')),
      ).then((m) => {
        if (v !== version) m.destroy();
        else map = m;
      });
    };
    this.cleanups.push(() => {
      version++;
      map?.destroy();
    });
    const ro = new ResizeObserver(() => map?.resize());
    ro.observe(mapEl);
    this.cleanups.push(() => ro.disconnect());

    const select = (player: number | null) => {
      selected = player;
      for (const b of rowButtons) {
        b.setAttribute('aria-pressed', String(Number(b.dataset['player']) === player));
      }
      if (player === null) {
        detail.replaceChildren();
      } else {
        detail.replaceChildren(
          h(
            'h3',
            { class: 'final__who' },
            h('span', { class: 'dot', style: `background:${playerColor(player)}` }),
            ` ${settings.players[player] ?? ''}: ${formatPoints(playerTotal(state, player))} z ${formatPoints(max)} bodů`,
          ),
          this.roundsTable(state, player, countries),
        );
      }
      drawMap();
    };
    drawMap();
  }
}
