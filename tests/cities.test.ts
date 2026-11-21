import { describe, expect, it, vi } from 'vitest';
import { citiesAllowed, validateSettings } from '../src/core/game';
import { CAPITAL_SQUARES, CZ_TOWNS } from '../src/data/cities';
import { MapillaryProvider } from '../src/providers/mapillary';
import { MapyProvider } from '../src/providers/mapy';
import { MapySquareFinder, pickCapitalSquare, pickCzSquare } from '../src/providers/squares';

const cz = (name: string, town: string, lat = 49.41, lon = 14.66) => ({
  name,
  type: 'regional.street',
  location: `${town}, Česko`,
  position: { lon, lat },
  regionalStructure: [
    { name, type: 'regional.street' },
    { name: town, type: 'regional.municipality' },
    { name: 'Česko', type: 'regional.country', isoCode: 'CZ' },
  ],
});

describe('volba Města: výběr náměstí', () => {
  it('bere jen náměstí ve zvoleném městě v Česku', () => {
    const items = [
      cz('Pražská', 'Tábor'),
      cz('Žižkovo náměstí', 'Tábor', 49.4137, 14.6585),
      cz('náměstí Míru', 'Sezimovo Ústí'),
    ];
    for (let i = 0; i < 10; i++) {
      expect(pickCzSquare(items, 'Tábor')).toEqual({
        position: { lat: 49.4137, lng: 14.6585 },
        label: 'Žižkovo náměstí, Tábor',
      });
    }
  });

  it('bez náměstí ve městě nic nevrátí', () => {
    expect(pickCzSquare([cz('Pražská', 'Tábor')], 'Tábor')).toBeNull();
    const abroad = {
      ...cz('Hlavné námestie', 'Tábor'),
      regionalStructure: [{ name: 'Slovensko', type: 'regional.country', isoCode: 'SK' }],
    };
    expect(pickCzSquare([abroad], 'Tábor')).toBeNull();
  });

  it('u hlavního města vezme první nalezené místo', () => {
    expect(
      pickCapitalSquare([
        {
          name: 'Trafalgar Square',
          location: 'Londýn, Spojené království',
          position: { lon: -0.128, lat: 51.508 },
        },
      ]),
    ).toEqual({
      position: { lat: 51.508, lng: -0.128 },
      label: 'Trafalgar Square, Londýn, Spojené království',
    });
    expect(pickCapitalSquare([])).toBeNull();
  });

  it('hledá přes Mapy.com s městem jako lokalitou', async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (u: string) => {
      urls.push(u);
      return Response.json({ items: [] });
    });
    const f = new MapySquareFinder('klic', () => 0, fetchFn as unknown as typeof fetch);
    await f.random('cz');
    await f.random('world');
    const a = new URL(urls[0] as string).searchParams;
    expect(a.get('query')).toBe('náměstí');
    expect(a.get('locality')).toBe(CZ_TOWNS[0]);
    expect(a.getAll('type')).toEqual(['regional.street']);
    const b = new URL(urls[1] as string).searchParams;
    expect(b.get('query')).toBe(CAPITAL_SQUARES[0]?.square);
    expect(b.get('locality')).toBe(CAPITAL_SQUARES[0]?.city);
  });

  it('bez klíče Mapy.com nic nehledá', async () => {
    const fetchFn = vi.fn();
    const f = new MapySquareFinder(undefined, () => 0, fetchFn as unknown as typeof fetch);
    expect(f.isConfigured()).toBe(false);
    expect(await f.random('cz')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('volba jde jen v Česku a ve Světě, ne v Učení', () => {
    expect(citiesAllowed('cz', 'classic')).toBe(true);
    expect(citiesAllowed('world', 'country')).toBe(true);
    expect(citiesAllowed('czsk', 'classic')).toBe(false);
    expect(citiesAllowed('world', 'learning')).toBe(false);
    const base = { type: 'classic' as const, grayscale: false, timeLimitSec: 0, players: ['A'] };
    expect(validateSettings({ ...base, region: 'czsk', cities: true })).not.toBeNull();
    expect(validateSettings({ ...base, region: 'cz', cities: true })).toBeNull();
  });
});

describe('volba Města: panorama u náměstí', () => {
  it('Mapillary vezme nejbližší snímek do 100 m', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        data: [
          { id: 'far', is_pano: true, geometry: { coordinates: [-0.1265, 51.508] } },
          { id: 'near', is_pano: true, geometry: { coordinates: [-0.1281, 51.5082] } },
        ],
      }),
    );
    const p = new MapillaryProvider('tok', () => 0, fetchFn as unknown as typeof fetch);
    expect(await p.findNear({ lat: 51.508, lng: -0.1281 })).toMatchObject({ panoId: 'near' });
    expect(await p.findNear({ lat: 51.508, lng: -0.1281 }, 10)).toBeNull();
  });

  it('Mapy.com nevrátí panorama mimo Česko', async () => {
    const answers = [
      { exists: true, info: { lon: 16.37, lat: 48.21, date: '' } },
      { exists: true, info: { lon: 14.4213, lat: 50.0875, date: '' } },
    ];
    const load = async () => ({
      panoramaExists: vi.fn(async () => answers.shift()),
      panoramaFromPosition: vi.fn(),
    });
    const p = new MapyProvider('klic', () => 0, load as never);
    expect(await p.findNear({ lat: 48.21, lng: 16.37 })).toBeNull();
    expect(await p.findNear({ lat: 50.0875, lng: 14.4213 })).toMatchObject({ provider: 'mapy' });
  });
});
