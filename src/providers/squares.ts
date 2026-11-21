import type { LatLng } from '../core/geo';
import { defaultRng, randomItem, type Rng } from '../core/random';
import { CAPITAL_SQUARES, CZ_TOWNS } from '../data/cities';

export interface SquareHit {
  position: LatLng;
  /** Název náměstí a města pro výsledek kola. */
  label: string;
}

export interface SquareFinder {
  /** Náhodné náměstí: v Česku některého města, ve světě některého hlavního města. */
  random(scope: 'cz' | 'world', signal?: AbortSignal): Promise<SquareHit | null>;
}

interface GeoItem {
  name?: string;
  type?: string;
  location?: string;
  position?: { lon: number; lat: number };
  regionalStructure?: { name?: string; type?: string; isoCode?: string }[];
}

const SQUARE_RE = /n[áa]m[ěe]st[íi]|námestie|\bnám\./i;

/** Z výsledků hledání vybere náměstí, které leží ve zvoleném městě v Česku. */
export function pickCzSquare(
  items: GeoItem[],
  town: string,
  rng: Rng = defaultRng,
): SquareHit | null {
  const inTown = items.filter((it) => {
    if (!it.position || !it.name || !SQUARE_RE.test(it.name)) return false;
    const rs = it.regionalStructure ?? [];
    const country = rs.find((r) => r.type === 'regional.country');
    const municipality = rs.find((r) => r.type === 'regional.municipality');
    const czech = !country || country.isoCode === 'CZ' || country.name === 'Česko';
    const sameTown = municipality ? municipality.name === town : (it.location ?? '').includes(town);
    return czech && sameTown;
  });
  const it = randomItem(inTown, rng);
  if (!it?.position || !it.name) return null;
  return { position: { lat: it.position.lat, lng: it.position.lon }, label: `${it.name}, ${town}` };
}

/** Z výsledků hledání vezme první místo (náměstí hlavního města). */
export function pickCapitalSquare(items: GeoItem[]): SquareHit | null {
  const it = items.find((x) => x.position && x.name);
  if (!it?.position || !it.name) return null;
  return {
    position: { lat: it.position.lat, lng: it.position.lon },
    label: [it.name, it.location].filter(Boolean).join(', '),
  };
}

/** Hledání náměstí přes Mapy.com (forward geocoding). Bez klíče nic nenajde. */
export class MapySquareFinder implements SquareFinder {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly rng: Rng = defaultRng,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  private async geocode(params: [string, string][], signal?: AbortSignal): Promise<GeoItem[]> {
    if (!this.apiKey) return [];
    const q = new URLSearchParams([
      ...params,
      ['lang', 'cs'],
      ['limit', '15'],
      ['apikey', this.apiKey],
    ]);
    try {
      const res = await this.fetchFn(`https://api.mapy.com/v1/geocode?${q.toString()}`, { signal });
      if (!res.ok) return [];
      return ((await res.json()) as { items?: GeoItem[] }).items ?? [];
    } catch {
      return [];
    }
  }

  async random(scope: 'cz' | 'world', signal?: AbortSignal): Promise<SquareHit | null> {
    if (scope === 'cz') {
      const town = randomItem(CZ_TOWNS, this.rng);
      if (!town) return null;
      const items = await this.geocode(
        [
          ['query', 'náměstí'],
          ['locality', town],
          ['type', 'regional.street'],
        ],
        signal,
      );
      return pickCzSquare(items, town, this.rng);
    }
    const sq = randomItem(CAPITAL_SQUARES, this.rng);
    if (!sq) return null;
    const items = await this.geocode(
      [
        ['query', sq.square],
        ['locality', sq.city],
        ['type', 'regional.street'],
        ['type', 'poi'],
      ],
      signal,
    );
    return pickCapitalSquare(items);
  }
}
