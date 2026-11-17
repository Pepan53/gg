import type { LatLng } from './geo';

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * Body na hlavní kružnici mezi a a b jako [lng, lat] pro kreslení spojnice.
 * Délky jsou „rozbalené“ (mohou přesáhnout ±180), aby čára přes datovou
 * hranici vedla kratší cestou a nepřeskakovala přes celou mapu.
 */
export function greatCirclePoints(a: LatLng, b: LatLng, segments = 64): [number, number][] {
  const φ1 = rad(a.lat);
  const λ1 = rad(a.lng);
  const φ2 = rad(b.lat);
  const λ2 = rad(b.lng);
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
      ),
    );
  if (d === 0)
    return [
      [a.lng, a.lat],
      [b.lng, b.lat],
    ];

  const out: [number, number][] = [];
  let prevLng = a.lng;
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    let lng = deg(Math.atan2(y, x));
    const lat = deg(Math.atan2(z, Math.sqrt(x * x + y * y)));
    while (lng - prevLng > 180) lng -= 360;
    while (lng - prevLng < -180) lng += 360;
    prevLng = lng;
    out.push([lng, lat]);
  }
  return out;
}
