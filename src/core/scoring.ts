import { bboxDiagonalKm, type BBox } from './geo';

export const MAX_POINTS = 5000;

/** Škála pro celý svět (zadání), km. */
export const WORLD_SCALE_KM = 1500;

/**
 * Referenční „úhlopříčka světa“: polovina obvodu Země, tedy největší možná
 * vzdálenost dvou bodů na povrchu (~20 015 km).
 */
export const WORLD_REFERENCE_KM = Math.PI * 6371.0088;

/**
 * Škála pro menší mapu: světová škála zmenšená v poměru úhlopříčky oblasti
 * k největší možné vzdálenosti na Zemi. Tip mimo oblast o stejný podíl
 * jejího rozměru tak dává stejné body jako ve světové hře.
 *
 * Příklad: Česko (úhlopříčka ~ 560 km) -> škála ~ 42 km.
 */
export function scaleForBBox(bbox: BBox): number {
  return WORLD_SCALE_KM * (bboxDiagonalKm(bbox) / WORLD_REFERENCE_KM);
}

/**
 * body = round(5000 * e^(-vzdálenost / škála)), omezeno na 0..5000.
 * Vstupní vzdálenost je nezaokrouhlená.
 */
export function scoreForDistance(distanceKm: number, scaleKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return 0;
  if (!Number.isFinite(scaleKm) || scaleKm <= 0) throw new Error('Škála musí být kladná.');
  const raw = Math.round(MAX_POINTS * Math.exp(-distanceKm / scaleKm));
  return Math.min(MAX_POINTS, Math.max(0, raw));
}
