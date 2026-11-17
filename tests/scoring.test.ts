import { describe, expect, it } from 'vitest';
import { bboxDiagonalKm, formatDistance, haversineKm, isValidLatLng } from '../src/core/geo';
import { CZ_BBOX, MODES } from '../src/core/modes';
import { MAX_POINTS, WORLD_SCALE_KM, scaleForBBox, scoreForDistance } from '../src/core/scoring';

describe('haversineKm', () => {
  it('vrací 0 pro stejný bod', () => {
    expect(haversineKm({ lat: 50, lng: 14 }, { lat: 50, lng: 14 })).toBe(0);
  });

  it('Praha - Brno je zhruba 185 km', () => {
    const d = haversineKm({ lat: 50.0755, lng: 14.4378 }, { lat: 49.1951, lng: 16.6068 });
    expect(d).toBeGreaterThan(183);
    expect(d).toBeLessThan(188);
  });

  it('protinožci jsou od sebe polovinu obvodu Země', () => {
    const d = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    expect(d).toBeCloseTo(Math.PI * 6371.0088, 3);
  });

  it('je symetrická a funguje přes datovou hranici', () => {
    const a = { lat: 10, lng: 179.5 };
    const b = { lat: 10, lng: -179.5 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
    expect(haversineKm(a, b)).toBeLessThan(120);
  });
});

describe('scoreForDistance', () => {
  it('nulová vzdálenost dává 5 000 bodů', () => {
    expect(scoreForDistance(0, WORLD_SCALE_KM)).toBe(MAX_POINTS);
  });

  it('odpovídá vzorci round(5000 * e^(-d/s))', () => {
    for (const d of [0.4, 1, 10, 150, 1500, 4321.7]) {
      expect(scoreForDistance(d, 1500)).toBe(Math.round(5000 * Math.exp(-d / 1500)));
    }
  });

  it('ve vzdálenosti jedné škály dává ~ 1 839 bodů', () => {
    expect(scoreForDistance(1500, 1500)).toBe(1839);
  });

  it('je omezená na 0 až 5 000', () => {
    expect(scoreForDistance(20000, 1500)).toBe(0);
    expect(scoreForDistance(-5, 1500)).toBe(0);
    expect(scoreForDistance(Number.NaN, 1500)).toBe(0);
  });

  it('počítá s nezaokrouhlenou vzdáleností', () => {
    expect(scoreForDistance(0.49, 1)).not.toBe(scoreForDistance(0, 1));
  });

  it('odmítne nesmyslnou škálu', () => {
    expect(() => scoreForDistance(1, 0)).toThrow();
  });
});

describe('škála pro menší mapy', () => {
  it('Česko má úhlopříčku ~ 560 km a škálu ~ 42 km', () => {
    expect(bboxDiagonalKm(CZ_BBOX)).toBeGreaterThan(540);
    expect(bboxDiagonalKm(CZ_BBOX)).toBeLessThan(580);
    expect(scaleForBBox(CZ_BBOX)).toBeGreaterThan(40);
    expect(scaleForBBox(CZ_BBOX)).toBeLessThan(44);
    expect(MODES.cz.scaleKm).toBe(scaleForBBox(CZ_BBOX));
  });

  it('je přísnější než světová', () => {
    expect(MODES.cz.scaleKm).toBeLessThan(MODES.world.scaleKm);
    expect(scoreForDistance(100, MODES.cz.scaleKm)).toBeLessThan(
      scoreForDistance(100, MODES.world.scaleKm),
    );
  });
});

describe('pomocné funkce', () => {
  it('validuje souřadnice', () => {
    expect(isValidLatLng({ lat: 0, lng: 0 })).toBe(true);
    expect(isValidLatLng({ lat: 91, lng: 0 })).toBe(false);
    expect(isValidLatLng({ lat: 0, lng: -181 })).toBe(false);
    expect(isValidLatLng({ lat: '1', lng: 0 })).toBe(false);
    expect(isValidLatLng(null)).toBe(false);
  });

  it('formátuje vzdálenost česky', () => {
    expect(formatDistance(0.25)).toBe('250 m');
    expect(formatDistance(3.456)).toBe('3,5 km');
    expect(formatDistance(1234.4).replace(/\s/g, ' ')).toBe('1 234 km');
  });
});
