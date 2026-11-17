import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { Target } from '../core/game';
import { isValidLatLng, type LatLng } from '../core/geo';
import type { ModeDef } from '../core/modes';
import { defaultRng, randomBetween, randomItem, type Rng } from '../core/random';
import { MAPILLARY_SEEDS } from '../data/mapillary-seeds';
import { ProviderError, type PanoramaProvider, type PanoramaViewer } from './types';

const GRAPH = 'https://graph.mapillary.com';
const TILES = 'https://tiles.mapillary.com/maps/vtp/mly1_public/2';
/** Zoom dlaždice pokrytí: z8 ~ 150 km, vrstva "sequence" (z6-14) nese is_pano. */
const COVERAGE_ZOOM = 8;
/** Polovina strany hledacího čtverce ve stupních (API vyžaduje plochu pod 0,01 °²). */
const SEARCH_HALF_DEG = 0.003;
const MAX_ATTEMPTS = 12;

export function tileFor(p: LatLng, z: number): { x: number; y: number; z: number } {
  const n = 2 ** z;
  const lat = Math.max(-85.05112878, Math.min(85.05112878, p.lat));
  const latR = (lat * Math.PI) / 180;
  const x = Math.floor(((p.lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)), z };
}

/** Z dlaždice pokrytí vybere body ležící na 360° sekvencích. */
export function panoPointsFromTile(buf: ArrayBuffer, x: number, y: number, z: number): LatLng[] {
  const tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
  const layer = tile.layers['sequence'];
  if (!layer) return [];
  const points: LatLng[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const pano = f.properties['is_pano'];
    if (pano !== true && pano !== 1 && pano !== 'true') continue;
    const geom = f.toGeoJSON(x, y, z).geometry;
    const lines =
      geom.type === 'LineString'
        ? [geom.coordinates]
        : geom.type === 'MultiLineString'
          ? geom.coordinates
          : [];
    for (const line of lines) {
      for (const c of line) {
        const [lng, lat] = c;
        if (typeof lng === 'number' && typeof lat === 'number') points.push({ lat, lng });
      }
    }
  }
  return points;
}

interface ImageHit {
  id: string;
  is_pano?: boolean;
  camera_type?: string;
  compass_angle?: number;
  geometry?: { coordinates: [number, number] };
  computed_geometry?: { coordinates: [number, number] };
}

/** Vybere z výsledků vyhledávání jen skutečná 360° panoramata. */
export function pickPano(hits: ImageHit[], rng: Rng = defaultRng): Target | null {
  const panos = hits.filter(
    (h) =>
      h.is_pano === true &&
      (h.camera_type === undefined ||
        h.camera_type === 'spherical' ||
        h.camera_type === 'equirectangular'),
  );
  const hit = randomItem(panos, rng);
  const coords = hit?.computed_geometry?.coordinates ?? hit?.geometry?.coordinates;
  if (!hit || !coords) return null;
  const position = { lng: coords[0], lat: coords[1] };
  if (!isValidLatLng(position)) return null;
  return {
    provider: 'mapillary',
    panoId: hit.id,
    position,
    heading: hit.compass_angle,
  };
}

export class MapillaryProvider implements PanoramaProvider {
  readonly id = 'mapillary' as const;
  readonly attribution = { label: 'Mapillary (CC BY-SA)', url: 'https://www.mapillary.com' };

  constructor(
    private readonly token: string | undefined,
    private readonly rng: Rng = defaultRng,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  isConfigured(): boolean {
    return typeof this.token === 'string' && this.token.length > 0;
  }

  private requireToken(): string {
    if (!this.isConfigured() || !this.token) {
      throw new ProviderError('Chybí klíč Mapillary (VITE_MAPILLARY_TOKEN).', 'config');
    }
    return this.token;
  }

  private async get(url: string, signal: AbortSignal): Promise<Response> {
    try {
      const res = await this.fetchFn(url, { signal });
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(
          'Mapillary odmítl klíč. Zkontroluj VITE_MAPILLARY_TOKEN.',
          'config',
        );
      }
      return res;
    } catch (e) {
      if (e instanceof ProviderError || (e as Error).name === 'AbortError') throw e;
      throw new ProviderError('Nepodařilo se spojit s Mapillary.', 'network');
    }
  }

  async findRandom(_mode: ModeDef, signal: AbortSignal): Promise<Target> {
    const token = this.requireToken();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const seed = randomItem(MAPILLARY_SEEDS, this.rng);
      if (!seed) break;
      const around: LatLng = {
        lng: seed[0] + randomBetween(-1, 1, this.rng),
        lat: Math.max(-80, Math.min(80, seed[1] + randomBetween(-0.7, 0.7, this.rng))),
      };
      const t = tileFor(around, COVERAGE_ZOOM);
      const tileRes = await this.get(
        `${TILES}/${t.z}/${t.x}/${t.y}?access_token=${encodeURIComponent(token)}`,
        signal,
      );
      if (!tileRes.ok) continue;
      const points = panoPointsFromTile(await tileRes.arrayBuffer(), t.x, t.y, t.z);
      const p = randomItem(points, this.rng);
      if (!p) continue;

      const bbox = [
        p.lng - SEARCH_HALF_DEG,
        p.lat - SEARCH_HALF_DEG,
        p.lng + SEARCH_HALF_DEG,
        p.lat + SEARCH_HALF_DEG,
      ].map((v) => v.toFixed(6));
      const params = new URLSearchParams({
        access_token: token,
        bbox: bbox.join(','),
        is_pano: 'true',
        fields: 'id,is_pano,camera_type,compass_angle,geometry,computed_geometry',
        limit: '50',
      });
      const res = await this.get(`${GRAPH}/images?${params.toString()}`, signal);
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: ImageHit[] };
      const target = pickPano(body.data ?? [], this.rng);
      if (target) return target;
    }
    throw new ProviderError('Nepodařilo se najít panorama. Zkus to znovu.', 'not-found');
  }

  async createViewer(container: HTMLElement, target: Target): Promise<PanoramaViewer> {
    const token = this.requireToken();
    const [{ Viewer }] = await Promise.all([
      import('mapillary-js'),
      import('mapillary-js/dist/mapillary.css'),
    ]);
    const viewer = new Viewer({
      accessToken: token,
      container,
      imageId: target.panoId,
      component: {
        cover: false,
        sequence: false,
        spatial: false,
        tag: false,
        popup: false,
        marker: false,
        slider: false,
        attribution: true,
        direction: true,
        keyboard: { keyPlay: false, keySequenceNavigation: false, keySpatialNavigation: true },
      },
    });
    try {
      await viewer.moveTo(target.panoId);
    } catch {
      viewer.remove();
      throw new ProviderError('Panorama teď není dostupné.', 'unavailable');
    }
    return {
      reset: () => {
        void viewer
          .moveTo(target.panoId)
          .then(() => {
            viewer.setZoom(0);
            viewer.setCenter([0.5, 0.5]);
          })
          .catch(() => undefined);
      },
      resize: () => viewer.resize(),
      destroy: () => viewer.remove(),
    };
  }
}
