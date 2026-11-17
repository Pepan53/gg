import { ROUNDS_PER_GAME } from './config';
import { haversineKm, isValidLatLng, type LatLng } from './geo';
import { MODES, type ModeId, type ProviderId } from './modes';
import { scoreForDistance } from './scoring';

/** Cíl kola: panorama a jeho počáteční poloha a výhled. */
export interface Target {
  provider: ProviderId;
  panoId: string;
  /** Poloha počátečního panoramatu = cíl kola. */
  position: LatLng;
  /** Počáteční směr pohledu ve stupních (0 = sever), pokud je znám. */
  heading?: number;
}

export interface RoundResult {
  guess: LatLng | null;
  distanceKm: number | null;
  points: number;
  timedOut: boolean;
}

export interface Round {
  target: Target;
  startedAt: number;
  /** Okamžik konce kola (ms), null = bez limitu. */
  deadline: number | null;
  /** Poslední umístěný špendlík (ještě nepotvrzený tip). */
  pin: LatLng | null;
  result: RoundResult | null;
}

/**
 * loading  - čeká se na panorama dalšího kola
 * playing  - kolo běží
 * result   - kolo je vyhodnocené, ukazuje se výsledek
 * finished - po posledním kole
 */
export type Phase = 'loading' | 'playing' | 'result' | 'finished';

export interface GameState {
  version: 1;
  id: string;
  mode: ModeId;
  timeLimitSec: number;
  createdAt: number;
  updatedAt: number;
  phase: Phase;
  rounds: Round[];
}

export function createGame(mode: ModeId, timeLimitSec: number, now: number, id: string): GameState {
  if (!(mode in MODES)) throw new Error(`Neznámý mód: ${mode}`);
  if (!Number.isInteger(timeLimitSec) || timeLimitSec < 0)
    throw new Error('Neplatný časový limit.');
  return {
    version: 1,
    id,
    mode,
    timeLimitSec,
    createdAt: now,
    updatedAt: now,
    phase: 'loading',
    rounds: [],
  };
}

export function currentRound(state: GameState): Round | undefined {
  return state.rounds[state.rounds.length - 1];
}

/** Zahájí kolo s nalezeným panoramatem. Funguje jen ve fázi loading. */
export function startRound(state: GameState, target: Target, now: number): GameState {
  if (state.phase !== 'loading') return state;
  if (state.rounds.length >= ROUNDS_PER_GAME) return state;
  const round: Round = {
    target,
    startedAt: now,
    deadline: state.timeLimitSec > 0 ? now + state.timeLimitSec * 1000 : null,
    pin: null,
    result: null,
  };
  return { ...state, phase: 'playing', rounds: [...state.rounds, round], updatedAt: now };
}

/**
 * Panorama běžícího kola se nepodařilo zobrazit: vymění cíl a spustí kolo znovu.
 * Body z odehraných kol zůstávají.
 */
export function replaceTarget(state: GameState, target: Target, now: number): GameState {
  if (state.phase !== 'playing') return state;
  const round = currentRound(state);
  if (!round) return state;
  const replaced: Round = {
    ...round,
    target,
    startedAt: now,
    deadline: state.timeLimitSec > 0 ? now + state.timeLimitSec * 1000 : null,
    pin: null,
  };
  return { ...state, rounds: [...state.rounds.slice(0, -1), replaced], updatedAt: now };
}

export function remainingMs(state: GameState, now: number): number | null {
  const round = currentRound(state);
  if (state.phase !== 'playing' || !round || round.deadline === null) return null;
  return Math.max(0, round.deadline - now);
}

function evaluate(
  state: GameState,
  guess: LatLng | null,
  timedOut: boolean,
  now: number,
): GameState {
  const round = currentRound(state);
  if (!round || state.phase !== 'playing') return state;
  const scale = MODES[state.mode].scaleKm;
  const distanceKm = guess ? haversineKm(guess, round.target.position) : null;
  const points = distanceKm === null ? 0 : scoreForDistance(distanceKm, scale);
  const evaluated: Round = {
    ...round,
    pin: guess,
    result: { guess, distanceKm, points, timedOut },
  };
  return {
    ...state,
    phase: 'result',
    rounds: [...state.rounds.slice(0, -1), evaluated],
    updatedAt: now,
  };
}

/**
 * Pokud čas vypršel, uzavře kolo: s posledním špendlíkem, nebo s 0 body bez tipu.
 */
export function expireIfNeeded(state: GameState, now: number): GameState {
  const round = currentRound(state);
  if (state.phase !== 'playing' || !round || round.deadline === null) return state;
  if (now < round.deadline) return state;
  return evaluate(state, round.pin, true, round.deadline);
}

/** Umístí nebo přesune špendlík. Po vypršení času už nic nezmění. */
export function placePin(state: GameState, pin: LatLng, now: number): GameState {
  const checked = expireIfNeeded(state, now);
  if (checked !== state) return checked;
  if (state.phase !== 'playing' || !isValidLatLng(pin)) return state;
  const round = currentRound(state);
  if (!round) return state;
  const moved: Round = { ...round, pin: { lat: pin.lat, lng: pin.lng } };
  return { ...state, rounds: [...state.rounds.slice(0, -1), moved], updatedAt: now };
}

/**
 * Potvrdí tip. Opakované volání (dvojklik, obnovení stránky) nic nezmění,
 * protože vyhodnotit lze jen kolo ve fázi playing.
 */
export function submitGuess(state: GameState, now: number): GameState {
  const checked = expireIfNeeded(state, now);
  if (checked !== state) return checked;
  const round = currentRound(state);
  if (state.phase !== 'playing' || !round || !round.pin) return state;
  return evaluate(state, round.pin, false, now);
}

/** Přechod z výsledku kola na další kolo, nebo na konec hry. */
export function advance(state: GameState, now: number): GameState {
  if (state.phase !== 'result') return state;
  const phase: Phase = state.rounds.length >= ROUNDS_PER_GAME ? 'finished' : 'loading';
  return { ...state, phase, updatedAt: now };
}

export function totalPoints(state: GameState): number {
  return state.rounds.reduce((sum, r) => sum + (r.result?.points ?? 0), 0);
}
