export interface LatLng {
  lat: number;
  lng: number;
}

/** Hranice oblasti: [minLng, minLat, maxLng, maxLat]. */
export type BBox = readonly [number, number, number, number];

/** Střední poloměr Země (IUGG), km. */
export const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Vzdálenost po povrchu Země (haversinův vzorec), nezaokrouhlená, v km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidLatLng(p: unknown): p is LatLng {
  if (typeof p !== 'object' || p === null) return false;
  const { lat, lng } = p as Record<string, unknown>;
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** Úhlopříčka oblasti (z jihozápadního do severovýchodního rohu), km. */
export function bboxDiagonalKm(bbox: BBox): number {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return haversineKm({ lat: minLat, lng: minLng }, { lat: maxLat, lng: maxLng });
}

export function isInBBox(p: LatLng, bbox: BBox): boolean {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return p.lng >= minLng && p.lng <= maxLng && p.lat >= minLat && p.lat <= maxLat;
}

/** Formát vzdálenosti pro zobrazení (zaokrouhlení až tady). */
export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1).replace('.', ',')} km`;
  return `${Math.round(km).toLocaleString('cs-CZ')} km`;
}
