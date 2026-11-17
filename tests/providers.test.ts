import GeoJSONVT from 'geojson-vt';
import { fromGeojsonVt } from 'vt-pbf';
import { describe, expect, it, vi } from 'vitest';
import { REGIONS } from '../src/core/modes';
import { pointInGeometry } from '../src/core/polygon';
import {
  MapillaryProvider,
  panoPointsFromTile,
  pickPano,
  tileFor,
} from '../src/providers/mapillary';
import { CZ_GEOMETRY, MapyProvider, randomPointInCzechia } from '../src/providers/mapy';
import {
  PLACE_NAME_UNAVAILABLE,
  fetchPlaceName,
  placeNameFromItems,
} from '../src/providers/placeName';
import { ProviderError } from '../src/providers/types';

/** Deterministický generátor pro testy. */
function seqRng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Sestaví dlaždici pokrytí Mapillary se dvěma sekvencemi: 360° a obyčejnou. */
function coverageTile(
  z: number,
  x: number,
  y: number,
  pano: [number, number],
  flat: [number, number],
) {
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { is_pano: true },
        geometry: { type: 'LineString', coordinates: [pano, [pano[0] + 0.01, pano[1] + 0.01]] },
      },
      {
        type: 'Feature',
        properties: { is_pano: false },
        geometry: { type: 'LineString', coordinates: [flat, [flat[0] + 0.01, flat[1]]] },
      },
    ],
  };
  const index = new GeoJSONVT(fc, { maxZoom: 14, indexMaxZoom: z, tolerance: 0, buffer: 0 });
  const buf = fromGeojsonVt({ sequence: index.getTile(z, x, y) }, { version: 2 });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('Mapillary: výběr panoramat', () => {
  it('tileFor spočítá dlaždici', () => {
    expect(tileFor({ lat: 0, lng: 0 }, 1)).toEqual({ x: 1, y: 1, z: 1 });
    expect(tileFor({ lat: 50.09, lng: 14.42 }, 8)).toEqual({ x: 138, y: 86, z: 8 });
  });

  it('z dlaždice bere jen 360° sekvence', () => {
    const t = tileFor({ lat: 50.09, lng: 14.42 }, 8);
    const buf = coverageTile(8, t.x, t.y, [14.42, 50.09], [14.6, 50.2]);
    const pts = panoPointsFromTile(buf, t.x, t.y, 8);
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) {
      expect(p.lng).toBeLessThan(14.45);
      expect(p.lat).toBeLessThan(50.11);
    }
  });

  it('pickPano odmítne snímky, které nejsou 360°', () => {
    expect(
      pickPano([
        { id: 'a', is_pano: false, geometry: { coordinates: [14, 50] } },
        { id: 'b', is_pano: true, camera_type: 'perspective', geometry: { coordinates: [14, 50] } },
      ]),
    ).toBeNull();
    const t = pickPano([
      {
        id: 'c',
        is_pano: true,
        camera_type: 'spherical',
        compass_angle: 90,
        geometry: { coordinates: [14, 50] },
      },
    ]);
    expect(t).toEqual({
      provider: 'mapillary',
      panoId: 'c',
      position: { lng: 14, lat: 50 },
      heading: 90,
    });
  });

  it('dává přednost zpřesněné poloze computed_geometry', () => {
    const t = pickPano([
      {
        id: 'd',
        is_pano: true,
        geometry: { coordinates: [14, 50] },
        computed_geometry: { coordinates: [14.001, 50.001] },
      },
    ]);
    expect(t?.position).toEqual({ lng: 14.001, lat: 50.001 });
  });

  it('bez klíče nic nevolá a hlásí chybu konfigurace', async () => {
    const fetchFn = vi.fn();
    const p = new MapillaryProvider('', seqRng(), fetchFn as unknown as typeof fetch);
    expect(p.isConfigured()).toBe(false);
    await expect(p.findRandom(REGIONS.world, new AbortController().signal)).rejects.toMatchObject({
      kind: 'config',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('najde panorama přes dlaždici a vyhledávání v okolí', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://tiles.mapillary.com')) {
        const m = /\/(\d+)\/(\d+)\/(\d+)\?/.exec(url);
        const [z, x, y] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
        // Sekvence uprostřed požadované dlaždice.
        const n = 2 ** z;
        const lng = ((x + 0.5) / n) * 360 - 180;
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
        return new Response(coverageTile(z, x, y, [lng, lat], [lng + 0.2, lat]));
      }
      return Response.json({
        data: [
          { id: 'flat', is_pano: false, geometry: { coordinates: [1, 1] } },
          {
            id: 'pano1',
            is_pano: true,
            camera_type: 'spherical',
            geometry: { coordinates: [2, 3] },
          },
        ],
      });
    });
    const p = new MapillaryProvider('tok', seqRng(7), fetchFn as unknown as typeof fetch);
    const t = await p.findRandom(REGIONS.world, new AbortController().signal);
    expect(t).toMatchObject({
      provider: 'mapillary',
      panoId: 'pano1',
      position: { lng: 2, lat: 3 },
    });
    const search = calls.find((u) => u.startsWith('https://graph.mapillary.com/images'));
    expect(search).toContain('is_pano=true');
    const bbox = new URL(search as string).searchParams.get('bbox')?.split(',').map(Number) ?? [];
    const area = ((bbox[2] ?? 0) - (bbox[0] ?? 0)) * ((bbox[3] ?? 0) - (bbox[1] ?? 0));
    expect(area).toBeLessThan(0.01);
  });

  it('po opakovaném neúspěchu vrátí srozumitelnou chybu', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const p = new MapillaryProvider('tok', seqRng(3), fetchFn as unknown as typeof fetch);
    await expect(p.findRandom(REGIONS.world, new AbortController().signal)).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('odmítnutý klíč hlásí jako chybu konfigurace', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 401 }));
    const p = new MapillaryProvider('spatny', seqRng(), fetchFn as unknown as typeof fetch);
    await expect(p.findRandom(REGIONS.world, new AbortController().signal)).rejects.toMatchObject({
      kind: 'config',
    });
  });
});

describe('Mapillary: oblast Česko + Slovensko', () => {
  const tileHandler = (url: string) => {
    const m = /\/(\d+)\/(\d+)\/(\d+)\?/.exec(url);
    const [z, x, y] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
    const n = 2 ** z;
    const lng = ((x + 0.5) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
    return new Response(coverageTile(z, x, y, [lng, lat], [lng + 0.2, lat]));
  };

  it('vybere jen panorama, které skutečně leží v oblasti', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.startsWith('https://tiles.mapillary.com')) return tileHandler(url);
      return Response.json({
        data: [
          { id: 'wien', is_pano: true, geometry: { coordinates: [16.37, 48.21] } },
          { id: 'bratislava', is_pano: true, geometry: { coordinates: [17.11, 48.15] } },
        ],
      });
    });
    const p = new MapillaryProvider('tok', seqRng(11), fetchFn as unknown as typeof fetch);
    for (let i = 0; i < 5; i++) {
      const t = await p.findRandom(REGIONS.czsk, new AbortController().signal);
      expect(t.panoId).toBe('bratislava');
    }
  });

  it('nikdy nevrátí místo mimo oblast, ani když jiné nenajde', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.startsWith('https://tiles.mapillary.com')) return tileHandler(url);
      return Response.json({
        data: [{ id: 'wien', is_pano: true, geometry: { coordinates: [16.37, 48.21] } }],
      });
    });
    const p = new MapillaryProvider('tok', seqRng(5), fetchFn as unknown as typeof fetch);
    await expect(p.findRandom(REGIONS.czsk, new AbortController().signal)).rejects.toMatchObject({
      kind: 'not-found',
      message: expect.stringContaining('Česko + Slovensko'),
    });
  });
});

describe('Mapy.com: jen Česko', () => {
  it('náhodné body leží uvnitř hranic Česka', () => {
    const rng = seqRng(42);
    for (let i = 0; i < 500; i++) {
      expect(pointInGeometry(randomPointInCzechia(rng), CZ_GEOMETRY)).toBe(true);
    }
  });

  it('hranice: Praha uvnitř, Drážďany, Vídeň a Bratislava venku', () => {
    expect(pointInGeometry({ lat: 50.09, lng: 14.42 }, CZ_GEOMETRY)).toBe(true);
    expect(pointInGeometry({ lat: 51.05, lng: 13.74 }, CZ_GEOMETRY)).toBe(false);
    expect(pointInGeometry({ lat: 48.21, lng: 16.37 }, CZ_GEOMETRY)).toBe(false);
    expect(pointInGeometry({ lat: 48.15, lng: 17.11 }, CZ_GEOMETRY)).toBe(false);
  });

  it('ověřuje skutečnou polohu panoramatu a zahodí panorama za hranicí', async () => {
    const answers = [
      { exists: false },
      { exists: true, info: { lon: 13.74, lat: 51.05, date: '' } }, // Drážďany
      { exists: true, info: { lon: 16.6, lat: 49.19, date: '' } }, // Brno
    ];
    const panoramaExists = vi.fn(async () => answers.shift() ?? { exists: false });
    const load = async () => ({ panoramaExists, panoramaFromPosition: vi.fn() });
    const p = new MapyProvider('klic', seqRng(), load as never);
    const t = await p.findRandom(REGIONS.cz, new AbortController().signal);
    expect(t.position).toEqual({ lng: 16.6, lat: 49.19 });
    expect(panoramaExists).toHaveBeenCalledTimes(3);
  });

  it('nikdy nevrátí místo mimo Česko, ani když jiné nenajde', async () => {
    const panoramaExists = vi.fn(async () => ({
      exists: true,
      info: { lon: 16.37, lat: 48.21, date: '' },
    }));
    const load = async () => ({ panoramaExists, panoramaFromPosition: vi.fn() });
    const p = new MapyProvider('klic', seqRng(), load as never);
    await expect(p.findRandom(REGIONS.cz, new AbortController().signal)).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('bez klíče nenačítá knihovnu Mapy.com', async () => {
    const load = vi.fn();
    const p = new MapyProvider(undefined, seqRng(), load as never);
    await expect(p.findRandom(REGIONS.cz, new AbortController().signal)).rejects.toMatchObject({
      kind: 'config',
    });
    expect(load).not.toHaveBeenCalled();
  });
});

describe('název místa', () => {
  it('u adresy použije obec a zemi', () => {
    expect(
      placeNameFromItems([
        {
          name: 'Týnská ulička 610/7',
          location: 'Praha 1 - Staré Město, Česko',
          type: 'regional.address',
        },
      ]),
    ).toBe('Praha 1 - Staré Město, Česko');
  });

  it('u obce neopakuje název dvakrát', () => {
    expect(
      placeNameFromItems([
        { name: 'Veselý Žďár', location: 'Veselý Žďár, Česko', type: 'regional.municipality' },
      ]),
    ).toBe('Veselý Žďár, Česko');
    expect(
      placeNameFromItems([
        { name: 'Milesimov', location: 'Všeradov, Česko', type: 'regional.municipality_part' },
      ]),
    ).toBe('Milesimov, Všeradov, Česko');
  });

  it('bez klíče nebo při chybě vrací null', async () => {
    expect(await fetchPlaceName({ lat: 50, lng: 14 }, undefined)).toBeNull();
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(
      await fetchPlaceName({ lat: 50, lng: 14 }, 'k', failing as unknown as typeof fetch),
    ).toBeNull();
    expect(PLACE_NAME_UNAVAILABLE).toBe('Název místa není k dispozici');
  });
});
