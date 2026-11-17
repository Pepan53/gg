import { SAVED_GAME_TTL_MS } from './config';
import { validateSettings, type GameState, type Guess } from './game';
import { isValidLatLng } from './geo';

const KEY = 'gg.game.v3';
const OLD_KEYS = ['gg.game.v1', 'gg.game.v2'];
const PREFIX = 'gg3:';
/**
 * Klíč pro zakódování uložené hry. Nejde o bezpečné šifrování (klíč je
 * v kódu hry), jen o to, aby cíl kola a tipy ostatních nebyly v nástrojích
 * prohlížeče čitelné na první pohled a nešly snadno ručně upravit.
 */
const OBFUSCATION_KEY = 'GG-kde-na-svete-jsem';

function xorBytes(data: Uint8Array): Uint8Array {
  const key = new TextEncoder().encode(OBFUSCATION_KEY);
  return data.map((b, i) => b ^ (key[i % key.length] ?? 0) ^ ((i * 31) % 251));
}

export function encodeState(state: GameState): string {
  const bytes = xorBytes(new TextEncoder().encode(JSON.stringify(state)));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return PREFIX + btoa(bin);
}

export function decodeState(raw: string): unknown {
  if (!raw.startsWith(PREFIX)) return null;
  const bin = atob(raw.slice(PREFIX.length));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(xorBytes(bytes)));
}

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
    store?.setItem(KEY, encodeState(state));
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
    for (const k of OLD_KEYS) store?.removeItem(k);
    raw = store?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = decodeState(raw);
    if (!isGameState(parsed)) return null;
    if (now - parsed.updatedAt > SAVED_GAME_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isGuess(g: unknown): g is Guess {
  if (typeof g !== 'object' || g === null) return false;
  const x = g as Partial<Guess> & { point?: unknown; code?: unknown };
  return (
    (x.kind === 'point' && isValidLatLng(x.point)) ||
    (x.kind === 'country' && typeof x.code === 'string')
  );
}

function isGameState(v: unknown): v is GameState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<GameState>;
  if (s.version !== 2 || typeof s.id !== 'string' || typeof s.updatedAt !== 'number') return false;
  if (!s.settings || validateSettings(s.settings) !== null) return false;
  if (!['loading', 'handoff', 'playing', 'result', 'finished'].includes(s.phase ?? ''))
    return false;
  const players = s.settings.players.length;
  if (typeof s.current !== 'number' || s.current < 0 || s.current >= players) return false;
  return (
    Array.isArray(s.rounds) &&
    s.rounds.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        typeof r.target?.panoId === 'string' &&
        isValidLatLng(r.target.position) &&
        Array.isArray(r.turns) &&
        r.turns.length === players &&
        r.turns.every((t) => t && (t.pending === null || isGuess(t.pending))),
    )
  );
}
