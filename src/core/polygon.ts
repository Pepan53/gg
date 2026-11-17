import type { Polygon, MultiPolygon } from 'geojson';
import type { LatLng } from './geo';

type Ring = number[][];

function inRing(p: LatLng, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const [xi = 0, yi = 0] = a;
    const [xj = 0, yj = 0] = b;
    const crosses = yi > p.lat !== yj > p.lat;
    if (crosses && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygonRings(p: LatLng, rings: Ring[]): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !inRing(p, outer)) return false;
  return !holes.some((h) => inRing(p, h));
}

/**
 * Bod v polygonu (rovinný ray casting ve stupních). Pro státy velikosti Česka
 * je přesnost dostatečná; nepoužívat pro polygony přes datovou hranici.
 */
export function pointInGeometry(p: LatLng, geometry: Polygon | MultiPolygon): boolean {
  if (geometry.type === 'Polygon') return inPolygonRings(p, geometry.coordinates);
  return geometry.coordinates.some((poly) => inPolygonRings(p, poly));
}
