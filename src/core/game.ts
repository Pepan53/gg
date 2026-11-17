import { MAX_PLAYERS, ROUNDS_PER_GAME } from './config';
import { haversineKm, isValidLatLng, type LatLng } from './geo';
import { GAME_TYPES, REGIONS, type GameType, type ProviderId, type RegionId } from './modes';
import { MAX_POINTS, scoreForDistance } from './scoring';

/** Cíl kola: panorama a jeho počáteční poloha a výhled. */
export interface Target {
  provider: ProviderId;
  panoId: string;
  /** Poloha počátečního panoramatu = cíl kola. */
  position: LatLng;
  /** Počáteční směr pohledu ve stupních (0 = sever), pokud je znám. */
  heading?: number;
  /** Kód státu cíle (ISO 3166-1 alpha-2), jen v módu Země. */
  country?: string;
  /** Počáteční výhled (výuková místa). */
  view?: PanoView;
  /** ID výukového místa (režim Učení). */
  placeId?: string;
}

/** Výhled Mapillary: střed obrazu (0..1, 0..1) a přiblížení. */
export interface MapillaryView {
  center: [number, number];
  zoom: number;
}
/** Výhled Mapy.com: kamera v radiánech (yaw 0 = sever). */
export interface MapyView {
  yaw: number;
  pitch: number;
  fov: number;
}
export type PanoView = MapillaryView | MapyView;
export const isMapyView = (v: PanoView): v is MapyView => 'yaw' in v;

/** Tip: bod na mapě, nebo stát (mód Země). */
export type Guess = { kind: 'point'; point: LatLng } | { kind: 'country'; code: string };

export interface TurnResult {
  guess: Guess | null;
  /** Vzdálenost tipu od cíle (jen bodový tip), km, nezaokrouhlená. */
  distanceKm: number | null;
  /** Body před časovým násobitelem. */
  basePoints: number;
  /** Výsledné body. */
  points: number;
  /** Násobitel Countdown (0..1), jinak 1. */
  multiplier: number;
  timedOut: boolean;
}

export interface Turn {
  /** Okamžik začátku tahu (po předávací obrazovce), null = ještě nezačal. */
  startedAt: number | null;
  /** Okamžik konce tahu (ms), null = bez limitu nebo nezačal. */
  deadline: number | null;
  /** Poslední umístěný (nepotvrzený) tip. */
  pending: Guess | null;
  result: TurnResult | null;
}

export interface Round {
  target: Target;
  /** Tah pro každého hráče, ve stejném pořadí jako GameState.players. */
  turns: Turn[];
}

/**
 * loading  - čeká se na panorama dalšího kola
 * handoff  - předávací obrazovka, další hráč ještě nezačal tah (jen víc hráčů)
 * playing  - tah běží
 * result   - kolo odehráli všichni, ukazuje se společný výsledek
 * finished - po posledním kole
 */
export type Phase = 'loading' | 'handoff' | 'playing' | 'result' | 'finished';

export interface GameSettings {
  region: RegionId;
  type: GameType;
  grayscale: boolean;
  /** Časový limit tahu v sekundách, 0 = bez limitu. Countdown má pevný limit. */
  timeLimitSec: number;
  /** Jména hráčů, 1 až 6. */
  players: string[];
  /** Počet kol (1 až 5), výchozí 5. Učení má méně, když není dost míst. */
  rounds?: number;
}

export function roundsOf(state: { settings: GameSettings }): number {
  return state.settings.rounds ?? ROUNDS_PER_GAME;
}

export interface GameState {
  version: 2;
  id: string;
  settings: GameSettings;
  createdAt: number;
  updatedAt: number;
  phase: Phase;
  rounds: Round[];
  /** Index hráče, který je na tahu (nebo bude po předání). */
  current: number;
}

export function isMultiplayer(s: GameState): boolean {
  return s.settings.players.length > 1;
}

/** Skutečný limit tahu v sekundách (Countdown má pevný). */
export function turnLimitSec(settings: GameSettings): number {
  return GAME_TYPES[settings.type].fixedTimeSec ?? settings.timeLimitSec;
}

export function validateSettings(s: GameSettings): string | null {
  if (!(s.region in REGIONS)) return 'Neznámá oblast.';
  const type = GAME_TYPES[s.type];
  if (!type) return 'Neznámý typ hry.';
  if (!type.regions.includes(s.region)) return 'Tenhle typ hry ve zvolené oblasti nejde.';
  if (s.grayscale && !REGIONS[s.region].grayscaleAllowed) return 'Černobílé panorama tady nejde.';
  if (!Number.isInteger(s.timeLimitSec) || s.timeLimitSec < 0) return 'Neplatný časový limit.';
  if (s.players.length < 1 || s.players.length > MAX_PLAYERS) return 'Počet hráčů musí být 1 až 6.';
  if (s.players.some((p) => !p.trim())) return 'Každý hráč potřebuje jméno.';
  if (
    s.rounds !== undefined &&
    (!Number.isInteger(s.rounds) || s.rounds < 1 || s.rounds > ROUNDS_PER_GAME)
  ) {
    return 'Neplatný počet kol.';
  }
  const lower = s.players.map((p) => p.trim().toLowerCase());
  if (new Set(lower).size !== lower.length) return 'Jména hráčů se nesmí opakovat.';
  return null;
}

export function createGame(settings: GameSettings, now: number, id: string): GameState {
  const err = validateSettings(settings);
  if (err) throw new Error(err);
  return {
    version: 2,
    id,
    settings: { ...settings, players: settings.players.map((p) => p.trim()) },
    createdAt: now,
    updatedAt: now,
    phase: 'loading',
    rounds: [],
    current: 0,
  };
}

export function currentRound(state: GameState): Round | undefined {
  return state.rounds[state.rounds.length - 1];
}

export function currentTurn(state: GameState): Turn | undefined {
  return currentRound(state)?.turns[state.current];
}

const emptyTurn = (): Turn => ({ startedAt: null, deadline: null, pending: null, result: null });

function withTurn(state: GameState, turn: Turn, patch: Partial<GameState>, now: number): GameState {
  const round = currentRound(state);
  if (!round) return state;
  const turns = round.turns.map((t, i) => (i === state.current ? turn : t));
  return {
    ...state,
    ...patch,
    rounds: [...state.rounds.slice(0, -1), { ...round, turns }],
    updatedAt: now,
  };
}

function begin(state: GameState, now: number): GameState {
  const turn = currentTurn(state);
  if (!turn) return state;
  const limit = turnLimitSec(state.settings);
  const started: Turn = {
    ...turn,
    startedAt: now,
    deadline: limit > 0 ? now + limit * 1000 : null,
  };
  return withTurn(state, started, { phase: 'playing' }, now);
}

/**
 * Zahájí kolo se stejným panoramatem pro všechny hráče. Jeden hráč začne hrát
 * hned, při více hráčích se nejdřív ukáže předávací obrazovka.
 */
export function startRound(state: GameState, target: Target, now: number): GameState {
  if (state.phase !== 'loading' || state.rounds.length >= roundsOf(state)) return state;
  const round: Round = { target, turns: state.settings.players.map(emptyTurn) };
  const next: GameState = {
    ...state,
    rounds: [...state.rounds, round],
    current: 0,
    phase: 'handoff',
    updatedAt: now,
  };
  return isMultiplayer(next) ? next : begin(next, now);
}

/** Hráč na předávací obrazovce potvrdil, že je u zařízení. */
export function beginTurn(state: GameState, now: number): GameState {
  if (state.phase !== 'handoff') return state;
  return begin(state, now);
}

/**
 * Panorama kola se nepodařilo zobrazit: vymění cíl. Tahy kola se zahodí
 * (nikdo nesmí mít výhodu z jiného místa) a kolo začne znovu od prvního hráče.
 * Body z odehraných kol zůstávají.
 */
export function replaceTarget(state: GameState, target: Target, now: number): GameState {
  if (state.phase !== 'playing' && state.phase !== 'handoff') return state;
  const round = currentRound(state);
  if (!round) return state;
  const next: GameState = {
    ...state,
    rounds: [
      ...state.rounds.slice(0, -1),
      { target, turns: state.settings.players.map(emptyTurn) },
    ],
    current: 0,
    phase: 'handoff',
    updatedAt: now,
  };
  return isMultiplayer(next) ? next : begin(next, now);
}

export function remainingMs(state: GameState, now: number): number | null {
  const turn = currentTurn(state);
  if (state.phase !== 'playing' || !turn || turn.deadline === null) return null;
  return Math.max(0, turn.deadline - now);
}

/** Body před časovým násobitelem. */
export function basePointsFor(
  state: GameState,
  guess: Guess | null,
): {
  base: number;
  distanceKm: number | null;
} {
  const round = currentRound(state);
  if (!round || !guess) return { base: 0, distanceKm: null };
  if (guess.kind === 'country') {
    const ok = !!round.target.country && guess.code === round.target.country;
    return { base: ok ? MAX_POINTS : 0, distanceKm: null };
  }
  const distanceKm = haversineKm(guess.point, round.target.position);
  return { base: scoreForDistance(distanceKm, REGIONS[state.settings.region].scaleKm), distanceKm };
}

/** Násobitel Countdown: zbývající sekundy / 30, omezený na 0..1. */
export function countdownMultiplier(remainingMsAtSubmit: number, totalSec: number): number {
  if (!Number.isFinite(remainingMsAtSubmit) || totalSec <= 0) return 0;
  return Math.min(1, Math.max(0, remainingMsAtSubmit / 1000 / totalSec));
}

function evaluate(
  state: GameState,
  guess: Guess | null,
  timedOut: boolean,
  now: number,
): GameState {
  const turn = currentTurn(state);
  if (!turn || state.phase !== 'playing') return state;
  const { base, distanceKm } = basePointsFor(state, guess);
  let multiplier = 1;
  if (state.settings.type === 'countdown') {
    const total = turnLimitSec(state.settings);
    multiplier =
      timedOut || turn.deadline === null ? 0 : countdownMultiplier(turn.deadline - now, total);
  }
  const points = Math.min(MAX_POINTS, Math.max(0, Math.round(base * multiplier)));
  const done: Turn = {
    ...turn,
    pending: guess,
    result: { guess, distanceKm, basePoints: base, points, multiplier, timedOut },
  };
  const round = currentRound(state);
  const last = !round || state.current >= round.turns.length - 1;
  const evaluated = withTurn(state, done, {}, now);
  return last
    ? { ...evaluated, phase: 'result' }
    : { ...evaluated, phase: 'handoff', current: state.current + 1 };
}

/** Pokud čas tahu vypršel, uzavře ho: s posledním tipem, nebo s 0 body bez tipu. */
export function expireIfNeeded(state: GameState, now: number): GameState {
  const guarded = guardClock(state, now);
  if (guarded !== state) return guarded;
  const turn = currentTurn(state);
  if (state.phase !== 'playing' || !turn || turn.deadline === null || now < turn.deadline) {
    return state;
  }
  return evaluate(state, turn.pending, true, turn.deadline);
}

function isValidGuess(g: Guess): boolean {
  if (g.kind === 'point') return isValidLatLng(g.point);
  return typeof g.code === 'string' && /^[A-Z]{2}$/.test(g.code);
}

/** O kolik smí hodiny zařízení „couvnout“, než to hra považuje za podvod (ms). */
export const CLOCK_TOLERANCE_MS = 5000;

/**
 * Hodiny zařízení se posunuly zpět (hráč si chtěl přidat čas): běžící tah
 * s časovým limitem se ihned uzavře, jako by čas vypršel.
 */
export function guardClock(state: GameState, now: number): GameState {
  const turn = currentTurn(state);
  if (state.phase !== 'playing' || !turn || turn.deadline === null) return state;
  if (now >= state.updatedAt - CLOCK_TOLERANCE_MS) return state;
  return evaluate(state, turn.pending, true, turn.deadline);
}

/** Umístí nebo přesune tip. Po vypršení času už nic nezmění. */
export function placeGuess(state: GameState, guess: Guess, now: number): GameState {
  const checked = expireIfNeeded(state, now);
  if (checked !== state) return checked;
  const turn = currentTurn(state);
  if (state.phase !== 'playing' || !turn || !isValidGuess(guess)) return state;
  const expected = state.settings.type === 'country' ? 'country' : 'point';
  if (guess.kind !== expected) return state;
  const copy: Guess =
    guess.kind === 'point'
      ? { kind: 'point', point: { lat: guess.point.lat, lng: guess.point.lng } }
      : { kind: 'country', code: guess.code };
  return withTurn(state, { ...turn, pending: copy }, {}, now);
}

/**
 * Potvrdí tip. Opakované volání (dvojklik, obnovení stránky) nic nezmění,
 * protože vyhodnotit lze jen tah ve fázi playing.
 */
export function submitGuess(state: GameState, now: number): GameState {
  const checked = expireIfNeeded(state, now);
  if (checked !== state) return checked;
  const turn = currentTurn(state);
  if (state.phase !== 'playing' || !turn?.pending) return state;
  return evaluate(state, turn.pending, false, now);
}

/** Z výsledku kola na další kolo, nebo na konec hry. */
export function advance(state: GameState, now: number): GameState {
  if (state.phase !== 'result') return state;
  const phase: Phase = state.rounds.length >= roundsOf(state) ? 'finished' : 'loading';
  return { ...state, phase, current: 0, updatedAt: now };
}

/**
 * Hra končí dřív, než bylo plánováno (Učení: došla dostupná schválená místa).
 * Odehraná kola zůstávají; počet kol se zkrátí na odehraná.
 */
export function finishEarly(state: GameState, now: number): GameState {
  if (state.phase !== 'loading' || state.rounds.length === 0) return state;
  return {
    ...state,
    settings: { ...state.settings, rounds: state.rounds.length },
    phase: 'finished',
    updatedAt: now,
  };
}

export function playerTotal(state: GameState, player: number): number {
  return state.rounds.reduce((sum, r) => sum + (r.turns[player]?.result?.points ?? 0), 0);
}

export interface Standing {
  player: number;
  name: string;
  points: number;
  /** Pořadí; při shodě bodů mají hráči stejné (1, 1, 3). */
  rank: number;
}

/** Pořadí hráčů podle součtu bodů, se společným pořadím při shodě. */
export function standings(state: GameState): Standing[] {
  const list = state.settings.players
    .map((name, player) => ({ player, name, points: playerTotal(state, player), rank: 0 }))
    .sort((a, b) => b.points - a.points || a.player - b.player);
  list.forEach((s, i) => {
    const prev = list[i - 1];
    s.rank = prev && prev.points === s.points ? prev.rank : i + 1;
  });
  return list;
}
