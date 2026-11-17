import type { Feature, FeatureCollection, MultiPolygon } from 'geojson';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { LatLng } from './geo';
import { pointInGeometry } from './polygon';

export interface CountryProps {
  /** ISO 3166-1 alpha-2 (Kosovo XK). */
  code: string;
  /** Český název. */
  name: string;
}
export type CountryFeature = Feature<MultiPolygon, CountryProps>;

export interface CountryIndex {
  collection: FeatureCollection<MultiPolygon, CountryProps>;
  /** Stát, ve kterém leží bod, nebo null (moře, mimo data). */
  countryAt(p: LatLng): CountryFeature | null;
  byCode(code: string): CountryFeature | undefined;
  nameOf(code: string): string;
}

type Box = [number, number, number, number];

function bboxOf(f: CountryFeature): Box {
  let minX = 540;
  let minY = 90;
  let maxX = -540;
  let maxY = -90;
  for (const poly of f.geometry.coordinates)
    for (const ring of poly)
      for (const [x = 0, y = 0] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  return [minX, minY, maxX, maxY];
}

/**
 * Kruhy, které překračují datovou hranici (skok délky přes 180°), „rozbalí“ na
 * východ (záporné délky + 360). Jinak by je mapa kreslila jako čáru přes celý
 * svět a test bodu v polygonu by dával nesmysly (Rusko, Fidži).
 */
export function unwrapAntimeridian(
  collection: FeatureCollection<MultiPolygon, CountryProps>,
): FeatureCollection<MultiPolygon, CountryProps> {
  const fixRing = (ring: number[][]): number[][] => {
    const crosses = ring.some((c, i) => {
      const prev = ring[i - 1];
      return !!prev && Math.abs((c[0] ?? 0) - (prev[0] ?? 0)) > 180;
    });
    return crosses ? ring.map(([x = 0, y = 0]) => [x < 0 ? x + 360 : x, y]) : ring;
  };
  return {
    ...collection,
    features: collection.features.map((f) => ({
      ...f,
      geometry: {
        ...f.geometry,
        coordinates: f.geometry.coordinates.map((poly) => poly.map(fixRing)),
      },
    })),
  };
}

/** Polygon státu s nejvíc body (hlavní území) pro výřez mapy. */
export function mainPolygon(f: CountryFeature): number[][][] | undefined {
  return [...f.geometry.coordinates].sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))[0];
}

export function buildIndex(raw: FeatureCollection<MultiPolygon, CountryProps>): CountryIndex {
  const collection = unwrapAntimeridian(raw);
  const items = collection.features.map((f) => ({ f, box: bboxOf(f) }));
  const codes = new Map(collection.features.map((f) => [f.properties.code, f]));
  return {
    collection,
    countryAt(p) {
      // Bod zkoušíme i posunutý o 360°, kvůli rozbaleným kruhům za datovou hranicí.
      for (const q of p.lng < 0 ? [p, { lat: p.lat, lng: p.lng + 360 }] : [p]) {
        for (const { f, box } of items) {
          if (q.lng < box[0] || q.lng > box[2] || q.lat < box[1] || q.lat > box[3]) continue;
          if (pointInGeometry(q, f.geometry)) return f;
        }
      }
      return null;
    },
    byCode: (code) => codes.get(code),
    nameOf: (code) => codes.get(code)?.properties.name ?? code,
  };
}

type TopoCountries = Topology<{ countries: GeometryCollection<CountryProps> }>;

let loading: Promise<CountryIndex> | null = null;

/**
 * Hranice států (Natural Earth 1:50m, public domain) s českými názvy.
 * Načítají se až v módu Země (~230 kB komprimovaně).
 */
export function loadCountries(): Promise<CountryIndex> {
  loading ??= Promise.all([import('topojson-client'), import('../data/countries.topo.json')]).then(
    ([topo, data]) => {
      const t = (data.default ?? data) as unknown as TopoCountries;
      const fc = topo.feature(t, t.objects.countries);
      return buildIndex(fc as unknown as FeatureCollection<MultiPolygon, CountryProps>);
    },
  );
  return loading;
}
