import { describe, expect, it } from 'vitest';
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
  type Target,
} from '../src/core/game';
import { loadGame, saveGame, type KeyValueStore } from '../src/core/storage';

const PRAGUE = { lat: 50.0755, lng: 14.4378 };
const target = (id = 'p1'): Target => ({ provider: 'mapillary', panoId: id, position: PRAGUE });

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

function playing(timeLimit = 0, now = 1000): GameState {
  return startRound(createGame('world', timeLimit, now, 'g1'), target(), now);
}

describe('průběh hry', () => {
  it('pět kol a konec', () => {
    let s = createGame('world', 0, 0, 'g1');
    for (let i = 0; i < 5; i++) {
      expect(s.phase).toBe('loading');
      s = startRound(s, target(`p${i}`), i * 10);
      s = placePin(s, PRAGUE, i * 10 + 1);
      s = submitGuess(s, i * 10 + 2);
      expect(s.phase).toBe('result');
      s = advance(s, i * 10 + 3);
    }
    expect(s.phase).toBe('finished');
    expect(s.rounds).toHaveLength(5);
    expect(totalPoints(s)).toBe(25000);
  });

  it('bez špendlíku nejde tip potvrdit', () => {
    const s = playing();
    expect(submitGuess(s, 2000)).toBe(s);
  });

  it('špendlík jde před potvrzením přesouvat', () => {
    let s = playing();
    s = placePin(s, { lat: 0, lng: 0 }, 1100);
    s = placePin(s, PRAGUE, 1200);
    expect(currentRound(s)?.pin).toEqual(PRAGUE);
  });

  it('odmítne souřadnice mimo rozsah', () => {
    const s = playing();
    expect(placePin(s, { lat: 100, lng: 0 }, 1100)).toBe(s);
  });

  it('opakované potvrzení nevytvoří další výsledek', () => {
    let s = placePin(playing(), { lat: 49, lng: 14 }, 1100);
    s = submitGuess(s, 1200);
    const first = currentRound(s)?.result;
    const again = submitGuess(s, 1300);
    expect(again).toBe(s);
    expect(currentRound(again)?.result).toBe(first);
    expect(again.rounds).toHaveLength(1);
  });

  it('nelze přeskočit kolo bez vyhodnocení', () => {
    const s = playing();
    expect(advance(s, 2000)).toBe(s);
  });

  it('startRound mimo fázi loading nic nedělá', () => {
    const s = playing();
    expect(startRound(s, target('x'), 2000)).toBe(s);
  });
});

describe('časový limit', () => {
  it('počítá zbývající čas', () => {
    const s = playing(60, 1000);
    expect(remainingMs(s, 31000)).toBe(30000);
    expect(remainingMs(s, 99999)).toBe(0);
  });

  it('po vypršení se špendlíkem vyhodnotí poslední polohu', () => {
    let s = playing(60, 1000);
    s = placePin(s, { lat: 49, lng: 14 }, 2000);
    s = expireIfNeeded(s, 61000);
    const r = currentRound(s)?.result;
    expect(s.phase).toBe('result');
    expect(r?.timedOut).toBe(true);
    expect(r?.guess).toEqual({ lat: 49, lng: 14 });
    expect(r?.points).toBeGreaterThan(0);
  });

  it('po vypršení bez špendlíku je 0 bodů a žádný tip', () => {
    const s = expireIfNeeded(playing(60, 1000), 61000);
    const r = currentRound(s)?.result;
    expect(r).toEqual({ guess: null, distanceKm: null, points: 0, timedOut: true });
  });

  it('špendlík po vypršení se už nezapočítá', () => {
    const s = placePin(playing(60, 1000), PRAGUE, 61001);
    expect(s.phase).toBe('result');
    expect(currentRound(s)?.result?.guess).toBeNull();
  });

  it('pozdní potvrzení se vyhodnotí jako vypršení', () => {
    let s = placePin(playing(60, 1000), PRAGUE, 2000);
    s = submitGuess(s, 70000);
    expect(currentRound(s)?.result?.timedOut).toBe(true);
    expect(currentRound(s)?.result?.points).toBe(5000);
  });

  it('bez limitu nevyprší', () => {
    const s = playing(0, 1000);
    expect(expireIfNeeded(s, 10 ** 12)).toBe(s);
    expect(remainingMs(s, 5000)).toBeNull();
  });
});

describe('výměna nedostupného panoramatu', () => {
  it('zachová body odehraných kol a restartuje čas', () => {
    let s = placePin(playing(60, 0), PRAGUE, 10);
    s = advance(submitGuess(s, 20), 30);
    s = startRound(s, target('p2'), 40);
    s = placePin(s, { lat: 0, lng: 0 }, 50);
    s = replaceTarget(s, target('p3'), 100);
    expect(totalPoints(s)).toBe(5000);
    expect(s.rounds).toHaveLength(2);
    expect(currentRound(s)?.target.panoId).toBe('p3');
    expect(currentRound(s)?.pin).toBeNull();
    expect(currentRound(s)?.deadline).toBe(100 + 60000);
  });
});

describe('uložení a obnovení stavu', () => {
  it('přežije obnovení stránky včetně špendlíku a času', () => {
    const store = memoryStore();
    const s = placePin(playing(60, 1000), PRAGUE, 2000);
    saveGame(s, store);
    const loaded = loadGame(3000, store);
    expect(loaded).toEqual(s);
    expect(remainingMs(loaded as GameState, 31000)).toBe(30000);
  });

  it('zahodí poškozená nebo stará data', () => {
    const store = memoryStore();
    store.setItem('gg.game.v1', '{"version":1}');
    expect(loadGame(0, store)).toBeNull();
    store.setItem('gg.game.v1', 'nejde-o-json');
    expect(loadGame(0, store)).toBeNull();
    saveGame(playing(0, 0), store);
    expect(loadGame(2 * 24 * 3600 * 1000, store)).toBeNull();
  });
});
