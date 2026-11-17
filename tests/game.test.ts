import { describe, expect, it } from 'vitest';
import {
  advance,
  beginTurn,
  countdownMultiplier,
  createGame,
  currentRound,
  currentTurn,
  expireIfNeeded,
  placeGuess,
  playerTotal,
  remainingMs,
  replaceTarget,
  standings,
  startRound,
  submitGuess,
  validateSettings,
  type GameSettings,
  type GameState,
  type Guess,
  type Target,
} from '../src/core/game';
import { loadGame, saveGame, type KeyValueStore } from '../src/core/storage';

const PRAGUE = { lat: 50.0755, lng: 14.4378 };
const at = (lat: number, lng: number): Guess => ({ kind: 'point', point: { lat, lng } });
const HIT: Guess = { kind: 'point', point: PRAGUE };
const target = (id = 'p1', country?: string): Target => ({
  provider: 'mapillary',
  panoId: id,
  position: PRAGUE,
  country,
});

const settings = (patch: Partial<GameSettings> = {}): GameSettings => ({
  region: 'world',
  type: 'classic',
  grayscale: false,
  timeLimitSec: 0,
  players: ['Pepa'],
  ...patch,
});

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

function playing(patch: Partial<GameSettings> = {}, now = 1000): GameState {
  return startRound(createGame(settings(patch), now, 'g1'), target('p1', 'CZ'), now);
}

describe('nastavení', () => {
  it('odmítne nesmyslné kombinace', () => {
    expect(validateSettings(settings())).toBeNull();
    expect(validateSettings(settings({ type: 'country', region: 'cz' }))).not.toBeNull();
    expect(validateSettings(settings({ grayscale: true, region: 'cz' }))).not.toBeNull();
    expect(validateSettings(settings({ grayscale: true, region: 'czsk' }))).toBeNull();
    expect(validateSettings(settings({ players: [] }))).not.toBeNull();
    expect(
      validateSettings(settings({ players: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })),
    ).not.toBeNull();
    expect(validateSettings(settings({ players: ['Ana', ' ana '] }))).not.toBeNull();
    expect(validateSettings(settings({ players: ['Ana', '  '] }))).not.toBeNull();
  });
});

describe('sólo hra', () => {
  it('pět kol a konec', () => {
    let s = createGame(settings(), 0, 'g1');
    for (let i = 0; i < 5; i++) {
      expect(s.phase).toBe('loading');
      s = startRound(s, target(`p${i}`), i * 10);
      expect(s.phase).toBe('playing');
      s = placeGuess(s, HIT, i * 10 + 1);
      s = submitGuess(s, i * 10 + 2);
      expect(s.phase).toBe('result');
      s = advance(s, i * 10 + 3);
    }
    expect(s.phase).toBe('finished');
    expect(playerTotal(s, 0)).toBe(25000);
  });

  it('bez tipu nejde potvrdit', () => {
    const s = playing();
    expect(submitGuess(s, 2000)).toBe(s);
  });

  it('tip jde před potvrzením přesouvat', () => {
    let s = placeGuess(playing(), at(0, 0), 1100);
    s = placeGuess(s, HIT, 1200);
    expect(currentTurn(s)?.pending).toEqual(HIT);
  });

  it('odmítne neplatné souřadnice a špatný druh tipu', () => {
    const s = playing();
    expect(placeGuess(s, at(100, 0), 1100)).toBe(s);
    expect(placeGuess(s, { kind: 'country', code: 'CZ' }, 1100)).toBe(s);
  });

  it('opakované potvrzení nevytvoří další výsledek', () => {
    let s = placeGuess(playing(), at(49, 14), 1100);
    s = submitGuess(s, 1200);
    const again = submitGuess(s, 1300);
    expect(again).toBe(s);
    expect(s.rounds).toHaveLength(1);
  });
});

describe('časový limit', () => {
  it('po vypršení s tipem vyhodnotí poslední polohu', () => {
    let s = placeGuess(playing({ timeLimitSec: 60 }), at(49, 14), 2000);
    s = expireIfNeeded(s, 61000);
    const r = currentTurn(s)?.result;
    expect(s.phase).toBe('result');
    expect(r?.timedOut).toBe(true);
    expect(r?.points).toBeGreaterThan(0);
  });

  it('po vypršení bez tipu je 0 bodů a žádný tip', () => {
    const s = expireIfNeeded(playing({ timeLimitSec: 60 }), 61000);
    expect(currentTurn(s)?.result).toMatchObject({
      guess: null,
      distanceKm: null,
      points: 0,
      timedOut: true,
    });
  });

  it('tip po vypršení se nezapočítá', () => {
    const s = placeGuess(playing({ timeLimitSec: 60 }), HIT, 61001);
    expect(currentTurn(s)?.result?.guess).toBeNull();
  });

  it('bez limitu nevyprší', () => {
    const s = playing();
    expect(expireIfNeeded(s, 10 ** 12)).toBe(s);
    expect(remainingMs(s, 5000)).toBeNull();
  });
});

describe('Countdown', () => {
  it('násobitel je zbývající čas / 30', () => {
    expect(countdownMultiplier(30000, 30)).toBe(1);
    expect(countdownMultiplier(15000, 30)).toBe(0.5);
    expect(countdownMultiplier(0, 30)).toBe(0);
    expect(countdownMultiplier(-5, 30)).toBe(0);
    expect(countdownMultiplier(45000, 30)).toBe(1);
  });

  it('má pevných 30 s bez ohledu na zvolený limit', () => {
    const s = playing({ type: 'countdown', timeLimitSec: 300 }, 1000);
    expect(currentTurn(s)?.deadline).toBe(31000);
  });

  it('přesný zásah za polovinu času dá 2 500 bodů', () => {
    let s = placeGuess(playing({ type: 'countdown' }, 0), HIT, 1000);
    s = submitGuess(s, 15000);
    expect(currentTurn(s)?.result).toMatchObject({
      basePoints: 5000,
      multiplier: 0.5,
      points: 2500,
    });
  });

  it('zaokrouhlí výsledek', () => {
    let s = placeGuess(playing({ type: 'countdown' }, 0), HIT, 1000);
    s = submitGuess(s, 10000); // zbývá 20 s -> 5000 * 2/3 = 3333,3
    expect(currentTurn(s)?.result?.points).toBe(3333);
  });

  it('po vypršení je násobitel 0, i když je tip umístěný', () => {
    let s = placeGuess(playing({ type: 'countdown' }, 0), HIT, 1000);
    s = expireIfNeeded(s, 30000);
    expect(currentTurn(s)?.result).toMatchObject({
      timedOut: true,
      multiplier: 0,
      points: 0,
      basePoints: 5000,
    });
  });
});

describe('Země', () => {
  it('správný stát 5 000, jiný 0', () => {
    let s = placeGuess(playing({ type: 'country' }), { kind: 'country', code: 'CZ' }, 1100);
    s = submitGuess(s, 1200);
    expect(currentTurn(s)?.result).toMatchObject({ points: 5000, distanceKm: null });
    let w = placeGuess(playing({ type: 'country' }), { kind: 'country', code: 'SK' }, 1100);
    w = submitGuess(w, 1200);
    expect(currentTurn(w)?.result?.points).toBe(0);
  });

  it('bodový tip v módu Země nejde', () => {
    const s = playing({ type: 'country' });
    expect(placeGuess(s, HIT, 1100)).toBe(s);
  });
});

describe('víc hráčů na jednom zařízení', () => {
  const three = { players: ['Ana', 'Bob', 'Cyril'] };

  it('kolo začíná předávací obrazovkou a hráči se střídají', () => {
    let s = startRound(createGame(settings(three), 0, 'g'), target(), 0);
    expect(s.phase).toBe('handoff');
    expect(s.current).toBe(0);
    for (let p = 0; p < 3; p++) {
      expect(s.phase).toBe('handoff');
      s = beginTurn(s, 100 * p);
      expect(s.phase).toBe('playing');
      expect(s.current).toBe(p);
      s = submitGuess(placeGuess(s, at(50, 14 + p), 100 * p + 1), 100 * p + 2);
    }
    expect(s.phase).toBe('result');
    expect(currentRound(s)?.turns.every((t) => t.result)).toBe(true);
  });

  it('všichni hrají stejné panorama', () => {
    const s = startRound(createGame(settings(three), 0, 'g'), target('stejne'), 0);
    expect(currentRound(s)?.turns).toHaveLength(3);
    expect(currentRound(s)?.target.panoId).toBe('stejne');
  });

  it('čas běží každému až od jeho začátku tahu', () => {
    let s = startRound(createGame(settings({ ...three, timeLimitSec: 60 }), 0, 'g'), target(), 0);
    expect(currentTurn(s)?.deadline).toBeNull();
    s = beginTurn(s, 5000);
    expect(currentTurn(s)?.deadline).toBe(65000);
    s = expireIfNeeded(s, 70000);
    expect(s.phase).toBe('handoff');
    expect(s.current).toBe(1);
    expect(currentRound(s)?.turns[0]?.result?.timedOut).toBe(true);
    s = beginTurn(s, 100000);
    expect(currentTurn(s)?.deadline).toBe(160000);
  });

  it('výměna panoramatu zahodí tahy kola a začne od prvního hráče', () => {
    let s = startRound(createGame(settings(three), 0, 'g'), target('a'), 0);
    s = submitGuess(placeGuess(beginTurn(s, 1), HIT, 2), 3);
    s = beginTurn(s, 4);
    s = replaceTarget(s, target('b'), 5);
    expect(s.phase).toBe('handoff');
    expect(s.current).toBe(0);
    expect(currentRound(s)?.turns.every((t) => t.result === null)).toBe(true);
    expect(currentRound(s)?.target.panoId).toBe('b');
  });

  it('pořadí se společným místem při shodě', () => {
    let s = createGame(settings({ players: ['Ana', 'Bob', 'Cyril', 'Dana'] }), 0, 'g');
    s = startRound(s, target(), 0);
    const guesses = [HIT, at(0, 0), HIT, at(49, 14)];
    guesses.forEach((g, i) => {
      s = submitGuess(placeGuess(beginTurn(s, i * 10), g, i * 10 + 1), i * 10 + 2);
    });
    const st = standings(s);
    expect(st.map((x) => [x.name, x.rank])).toEqual([
      ['Ana', 1],
      ['Cyril', 1],
      ['Dana', 3],
      ['Bob', 4],
    ]);
  });
});

describe('uložení a obnovení stavu', () => {
  it('přežije obnovení stránky včetně tipu a času', () => {
    const store = memoryStore();
    const s = placeGuess(playing({ timeLimitSec: 60 }), HIT, 2000);
    saveGame(s, store);
    const loaded = loadGame(3000, store);
    expect(loaded).toEqual(s);
    expect(remainingMs(loaded as GameState, 31000)).toBe(30000);
  });

  it('zahodí poškozená, stará nebo starší verze dat', () => {
    const store = memoryStore();
    store.setItem('gg.game.v2', '{"version":2}');
    expect(loadGame(0, store)).toBeNull();
    store.setItem('gg.game.v2', 'nejde-o-json');
    expect(loadGame(0, store)).toBeNull();
    saveGame(playing({}, 0), store);
    expect(loadGame(2 * 24 * 3600 * 1000, store)).toBeNull();
    store.setItem('gg.game.v1', '{}');
    loadGame(0, store);
    expect(store.getItem('gg.game.v1')).toBeNull();
  });
});
