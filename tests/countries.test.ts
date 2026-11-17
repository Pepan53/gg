import { describe, expect, it } from 'vitest';
import { loadCountries } from '../src/core/countries';
import { CZSK_GEOMETRY } from '../src/core/modes';
import { pointInGeometry } from '../src/core/polygon';

describe('hranice států (Natural Earth)', () => {
  it('určí stát podle polohy a má české názvy', async () => {
    const c = await loadCountries();
    const cases: [number, number, string, string][] = [
      [50.09, 14.42, 'CZ', 'Česko'],
      [48.15, 17.11, 'SK', 'Slovensko'],
      [48.86, 2.35, 'FR', 'Francie'],
      [-33.87, 151.21, 'AU', 'Austrálie'],
      [39.74, -104.99, 'US', 'USA'],
      [35.68, 139.69, 'JP', 'Japonsko'],
      [55.75, 37.62, 'RU', 'Rusko'],
      [49.61, 6.13, 'LU', 'Lucembursko'],
      [1.35, 103.82, 'SG', 'Singapur'],
    ];
    for (const [lat, lng, code, name] of cases) {
      const f = c.countryAt({ lat, lng });
      expect(f?.properties.code, `${lat},${lng}`).toBe(code);
      expect(f?.properties.name).toBe(name);
    }
  });

  it('státy přes datovou hranici: Čukotka a Fidži', async () => {
    const c = await loadCountries();
    expect(c.countryAt({ lat: 66.5, lng: -175 })?.properties.code).toBe('RU');
    expect(c.countryAt({ lat: 65, lng: 177 })?.properties.code).toBe('RU');
    expect(c.countryAt({ lat: -16.6, lng: 179.4 })?.properties.code).toBe('FJ');
    // Žádný kruh po rozbalení nemá skok přes polovinu světa.
    for (const f of c.collection.features)
      for (const poly of f.geometry.coordinates)
        for (const ring of poly)
          ring.forEach((pt, i) => {
            const prev = ring[i - 1];
            if (prev) expect(Math.abs((pt[0] ?? 0) - (prev[0] ?? 0))).toBeLessThan(180);
          });
  });

  it('moře a Antarktida nejsou stát', async () => {
    const c = await loadCountries();
    expect(c.countryAt({ lat: 0, lng: -30 })).toBeNull();
    expect(c.countryAt({ lat: -80, lng: 0 })).toBeNull();
  });

  it('sporná území podle zdokumentovaných pravidel', async () => {
    const c = await loadCountries();
    // Somaliland se počítá k Somálsku, Severní Kypr ke Kypru, Kosovo je samostatné.
    expect(c.countryAt({ lat: 9.56, lng: 44.06 })?.properties.code).toBe('SO');
    expect(c.countryAt({ lat: 35.19, lng: 33.36 })?.properties.code).toBe('CY');
    expect(c.countryAt({ lat: 42.66, lng: 21.16 })?.properties.code).toBe('XK');
    expect(c.byCode('XK')?.properties.name).toBe('Kosovo');
  });

  it('kódy jsou jedinečné', async () => {
    const c = await loadCountries();
    const codes = c.collection.features.map((f) => f.properties.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThan(200);
  });
});

describe('oblast Česko + Slovensko', () => {
  it('obsahuje Prahu, Bratislavu a Košice, ne Vídeň, Budapešť ani Krakov', () => {
    for (const [lat, lng] of [
      [50.09, 14.42],
      [48.15, 17.11],
      [48.72, 21.26],
    ] as const)
      expect(pointInGeometry({ lat, lng }, CZSK_GEOMETRY)).toBe(true);
    for (const [lat, lng] of [
      [48.21, 16.37],
      [47.5, 19.04],
      [50.06, 19.94],
    ] as const)
      expect(pointInGeometry({ lat, lng }, CZSK_GEOMETRY)).toBe(false);
  });
});
