import { SAVED_GAME_TTL_MS } from './config';
import type { GameState } from './game';
import { isValidLatLng } from './geo';
import { MODES } from './modes';

const KEY = 'gg.game.v1';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage může v některých prohlížečích chybět nebo házet výjimky. */
function safeStore(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function saveGame(state: GameState, store: KeyValueStore | null = safeStore()): void {
  try {
    store?.setItem(KEY, JSON.stringify(state));
  } catch {
    // Plné úložiště nebo soukromý režim: hra běží dál, jen nepřežije obnovení stránky.
  }
}

export function clearGame(store: KeyValueStore | null = safeStore()): void {
  try {
    store?.removeItem(KEY);
  } catch {
    // ignorovat
  }
}

export function loadGame(now: number, store: KeyValueStore | null = safeStore()): GameState | null {
  let raw: string | null;
  try {
    raw = store?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isGameState(parsed)) return null;
    if (now - parsed.updatedAt > SAVED_GAME_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isGameState(v: unknown): v is GameState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<GameState>;
  return (
    s.version === 1 &&
    typeof s.id === 'string' &&
    typeof s.mode === 'string' &&
    s.mode in MODES &&
    typeof s.timeLimitSec === 'number' &&
    typeof s.updatedAt === 'number' &&
    (s.phase === 'loading' ||
      s.phase === 'playing' ||
      s.phase === 'result' ||
      s.phase === 'finished') &&
    Array.isArray(s.rounds) &&
    s.rounds.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        typeof r.target?.panoId === 'string' &&
        isValidLatLng(r.target.position) &&
        (r.pin === null || isValidLatLng(r.pin)),
    )
  );
}
