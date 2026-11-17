import type { LatLng } from '../core/geo';

export const PLACE_NAME_UNAVAILABLE = 'Název místa není k dispozici';

interface RGeocodeItem {
  name?: string;
  location?: string;
  type?: string;
}

/** Z odpovědi reverzního geokódování Mapy.com sestaví krátký název místa. */
export function placeNameFromItems(items: RGeocodeItem[]): string | null {
  const first = items[0];
  if (!first) return null;
  const isAddress = first.type === 'regional.address' || first.type === 'regional.street';
  const name = first.name?.trim() ?? '';
  const location = first.location?.trim() ?? '';
  // "Veselý Žďár" + "Veselý Žďár, Česko" -> jen "Veselý Žďár, Česko".
  const label =
    isAddress || !name || location.startsWith(name)
      ? location || name
      : [name, location].filter(Boolean).join(', ');
  return label || null;
}

/**
 * Název místa přes Mapy.com /v1/rgeocode. Volá se až po uzavření kola.
 * Bez klíče nebo při chybě vrací null (UI pak ukáže PLACE_NAME_UNAVAILABLE).
 */
export async function fetchPlaceName(
  p: LatLng,
  apiKey: string | undefined,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<string | null> {
  if (!apiKey) return null;
  const params = new URLSearchParams({
    lon: p.lng.toFixed(6),
    lat: p.lat.toFixed(6),
    lang: 'cs',
    apikey: apiKey,
  });
  try {
    const res = await fetchFn(`https://api.mapy.com/v1/rgeocode?${params.toString()}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: RGeocodeItem[] };
    return placeNameFromItems(body.items ?? []);
  } catch {
    return null;
  }
}
