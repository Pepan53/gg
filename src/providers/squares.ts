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
  /** Jde hledat? Česká náměstí potřebují klíč Mapy.com, hlavní města ne. */
  isConfigured(scope: 'cz' | 'world'): boolean;
}

interface GeoItem {
  name?: string;
  type?: string;
  location?: string;
  position?: { lon: number; lat: number };
  regionalStructure?: { name?: string; type?: string; isoCode?: string }[];
}

const SQUARE_RE = /n[áa]m[ěe]st[íi]|námestie|\bnám\./i;
/** Typické názvy hlavních náměstí. Když je ve městě některé z nich, má přednost. */
const MAIN_SQUARE_RE =
  /masarykovo|mírové|míru|svobody|republiky|horní|dolní|velké|hlavní|staroměstské|žižkovo|husovo|palackého|komenského|přemysla otakara|t\. ?g\. ?masaryka|jiřího z poděbrad|karlovo|smetanovo|riegrovo|mariánské|zámecké|krále|starého města/i;

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
  const main = inTown.filter((x) => MAIN_SQUARE_RE.test(x.name ?? ''));
  const it = randomItem(main.length ? main : inTown, rng);
  if (!it?.position || !it.name) return null;
  return { position: { lat: it.position.lat, lng: it.position.lon }, label: `${it.name}, ${town}` };
}

/** Česká náměstí hledá přes Mapy.com (forward geocoding), hlavní města má v seznamu. */
export class MapySquareFinder implements SquareFinder {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly rng: Rng = defaultRng,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  isConfigured(scope: 'cz' | 'world'): boolean {
    return scope === 'world' || !!this.apiKey;
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
    return { position: { lat: sq.lat, lng: sq.lng }, label: `${sq.square}, ${sq.city}` };
  }
}
