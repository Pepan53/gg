import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { isMapyView, type Target } from '../core/game';
import { haversineKm, isValidLatLng, type LatLng } from '../core/geo';
import type { RegionArea, RegionDef } from '../core/modes';
import { pointInGeometry } from '../core/polygon';
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

const hitPosition = (h: ImageHit): LatLng | null => {
  const c = h.computed_geometry?.coordinates ?? h.geometry?.coordinates;
  if (!c) return null;
  const p = { lng: c[0], lat: c[1] };
  return isValidLatLng(p) ? p : null;
};

/**
 * Vybere z výsledků vyhledávání jen skutečná 360° panoramata; s oblastí jen ta,
 * jejichž skutečná (zpřesněná) poloha leží uvnitř území.
 */
export function pickPano(
  hits: ImageHit[],
  rng: Rng = defaultRng,
  area?: RegionArea,
): Target | null {
  const panos = hits.filter((h) => {
    const okType =
      h.is_pano === true &&
      (h.camera_type === undefined ||
        h.camera_type === 'spherical' ||
        h.camera_type === 'equirectangular');
    if (!okType) return false;
    const p = hitPosition(h);
    return !!p && (!area || pointInGeometry(p, area.geometry));
  });
  const hit = randomItem(panos, rng);
  const position = hit && hitPosition(hit);
  if (!hit || !position) return null;
  return {
    provider: 'mapillary',
    panoId: hit.id,
    position,
    heading: hit.compass_angle,
  };
}

export interface ImageInfo {
  exists: boolean;
  isPano?: boolean;
  position?: LatLng | null;
}

export interface NearbyImage {
  id: string;
  position: LatLng;
  thumbUrl?: string;
  capturedAt?: number;
  creator?: string;
  /** Vzdálenost od hledaného bodu, m. */
  distanceM: number;
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

  /** Existuje snímek a kde je? null = nepodařilo se ověřit (síť). */
  async imageInfo(imageId: string, signal?: AbortSignal): Promise<ImageInfo | null> {
    const token = this.requireToken();
    const params = new URLSearchParams({
      access_token: token,
      fields: 'id,is_pano,geometry,computed_geometry',
    });
    try {
      const res = await this.fetchFn(
        `${GRAPH}/${encodeURIComponent(imageId)}?${params.toString()}`,
        {
          signal,
        },
      );
      if (res.status === 400 || res.status === 404) return { exists: false };
      if (!res.ok) return null;
      const body = (await res.json()) as ImageHit & { error?: unknown };
      if (body.error || !body.id) return { exists: false };
      return { exists: true, isPano: body.is_pano === true, position: hitPosition(body) };
    } catch {
      return null;
    }
  }

  /** 360° snímky v okolí bodu (editor výukových míst). */
  async nearby(p: LatLng, signal?: AbortSignal): Promise<NearbyImage[]> {
    const token = this.requireToken();
    const d = SEARCH_HALF_DEG * 0.6;
    const params = new URLSearchParams({
      access_token: token,
      bbox: [p.lng - d, p.lat - d, p.lng + d, p.lat + d].map((v) => v.toFixed(6)).join(','),
      is_pano: 'true',
      fields: 'id,is_pano,geometry,computed_geometry,thumb_256_url,captured_at,creator',
      limit: '300',
    });
    const res = await this.get(
      `${GRAPH}/images?${params.toString()}`,
      signal ?? new AbortController().signal,
    );
    if (!res.ok) throw new ProviderError('Hledání v Mapillary selhalo.', 'network');
    const body = (await res.json()) as {
      data?: (ImageHit & {
        thumb_256_url?: string;
        captured_at?: number;
        creator?: { username?: string };
      })[];
    };
    return (body.data ?? [])
      .flatMap((h) => {
        const pos = hitPosition(h);
        return h.is_pano && pos
          ? [
              {
                id: h.id,
                position: pos,
                thumbUrl: h.thumb_256_url,
                capturedAt: h.captured_at,
                creator: h.creator?.username,
                distanceM: Math.round(haversineKm(p, pos) * 1000),
              },
            ]
          : [];
      })
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 40);
  }

  /** 360° snímek nejblíž bodu (např. náměstí) do dané vzdálenosti, nebo null. */
  async findNear(p: LatLng, radiusM = 100, signal?: AbortSignal): Promise<Target | null> {
    const found = await this.nearby(p, signal);
    const best = found.find((f) => f.distanceM <= radiusM);
    if (!best) return null;
    return { provider: 'mapillary', panoId: best.id, position: best.position };
  }

  /** Výchozí bod hledání: v oblasti náhodně uvnitř území, jinak u některého z výchozích bodů. */
  private startPoint(area: RegionArea | undefined): LatLng | null {
    if (area) {
      const [minLng, minLat, maxLng, maxLat] = area.bbox;
      for (let i = 0; i < 1000; i++) {
        const p = {
          lng: randomBetween(minLng, maxLng, this.rng),
          lat: randomBetween(minLat, maxLat, this.rng),
        };
        if (pointInGeometry(p, area.geometry)) return p;
      }
      return null;
    }
    const seed = randomItem(MAPILLARY_SEEDS, this.rng);
    if (!seed) return null;
    return {
      lng: seed[0] + randomBetween(-1, 1, this.rng),
      lat: Math.max(-80, Math.min(80, seed[1] + randomBetween(-0.7, 0.7, this.rng))),
    };
  }

  async findRandom(region: RegionDef, signal: AbortSignal): Promise<Target> {
    const token = this.requireToken();
    const area = region.area;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const around = this.startPoint(area);
      if (!around) break;
      const t = tileFor(around, COVERAGE_ZOOM);
      const tileRes = await this.get(
        `${TILES}/${t.z}/${t.x}/${t.y}?access_token=${encodeURIComponent(token)}`,
        signal,
      );
      if (!tileRes.ok) continue;
      const points = panoPointsFromTile(await tileRes.arrayBuffer(), t.x, t.y, t.z).filter(
        (pt) => !area || pointInGeometry(pt, area.geometry),
      );
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
      const target = pickPano(body.data ?? [], this.rng, area);
      if (target) return target;
    }
    throw new ProviderError(
      area
        ? `V oblasti ${region.name} se teď nepodařilo najít panorama. Zkus to znovu.`
        : 'Nepodařilo se najít panorama. Zkus to znovu.',
      'not-found',
    );
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
      // Dlaždicové načítání obrazu (image_tiles) aktuální API odmítá chybou
      // "Param z must be a number"; celé snímky v rozlišení 2048 px fungují.
      imageTiling: false,
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
    // Panorama načítáme jen přes moveTo (ne zároveň přes imageId v konstruktoru),
    // jinak druhý požadavek zruší první a moveTo skončí chybou CancelMapillaryError.
    const view = target.view && !isMapyView(target.view) ? target.view : null;
    const applyView = () => {
      if (!view) return;
      viewer.setCenter(view.center);
      viewer.setZoom(view.zoom);
    };
    try {
      await viewer.moveTo(target.panoId);
      applyView();
    } catch (e) {
      viewer.remove();
      if ((e as Error).name === 'CancelMapillaryError') {
        throw new ProviderError('Načítání panoramatu bylo přerušeno. Zkus to znovu.', 'network');
      }
      throw new ProviderError('Panorama teď není dostupné.', 'unavailable');
    }
    return {
      reset: () => {
        void viewer
          .moveTo(target.panoId)
          .then(() => {
            if (view) return applyView();
            viewer.setZoom(0);
            viewer.setCenter([0.5, 0.5]);
          })
          .catch(() => undefined);
      },
      resize: () => viewer.resize(),
      destroy: () => viewer.remove(),
      getView: async () => {
        const [center, zoom] = await Promise.all([viewer.getCenter(), viewer.getZoom()]);
        return { center: [center[0] ?? 0.5, center[1] ?? 0.5], zoom };
      },
    };
  }
}
