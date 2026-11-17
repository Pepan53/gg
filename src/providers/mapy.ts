import type { Target } from '../core/game';
import { isValidLatLng, type LatLng } from '../core/geo';
import { CZ_GEOMETRY, type RegionDef } from '../core/modes';
import { pointInGeometry } from '../core/polygon';
import { defaultRng, randomBetween, type Rng } from '../core/random';
import { ProviderError, type PanoramaProvider, type PanoramaViewer } from './types';

const SCRIPT_URL = 'https://api.mapy.cz/js/panorama/v1/panorama.js';
const SEARCH_RADIUS_M = 400;
const MAX_ATTEMPTS = 15;

export { CZ_GEOMETRY };

interface PanoInfo {
  lon: number;
  lat: number;
  date: string;
}
interface Camera {
  yaw: number;
  pitch: number;
  fov: number;
}
interface PanoHandle {
  info?: PanoInfo;
  error: string;
  errorCode: 'NONE' | 'PANORAMA_NOT_FOUND' | 'MISSING_API_KEY' | 'WRONG_API_KEY';
  setCamera(c: Camera): void;
  destroy(): void;
}
interface PanoramaGlobal {
  panoramaFromPosition(opts: {
    parent: HTMLElement;
    lon: number;
    lat: number;
    apiKey: string;
    radius?: number;
    yaw?: 'auto' | 'point' | number;
    pitch?: number;
    fov?: number;
    showNavigation?: boolean;
    lang?: string;
    hideErrors?: boolean;
  }): Promise<PanoHandle>;
  panoramaExists(opts: {
    lon: number;
    lat: number;
    apiKey: string;
    radius?: number;
  }): Promise<{ exists: boolean; info?: PanoInfo }>;
}

let scriptPromise: Promise<PanoramaGlobal> | null = null;

/** Knihovnu Mapy.com načte až při prvním použití a jen když je nastavený klíč. */
function loadScript(): Promise<PanoramaGlobal> {
  const existing = (globalThis as { Panorama?: PanoramaGlobal }).Panorama;
  if (existing) return Promise.resolve(existing);
  scriptPromise ??= new Promise<PanoramaGlobal>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_URL;
    s.async = true;
    s.onload = () => {
      const g = (globalThis as { Panorama?: PanoramaGlobal }).Panorama;
      if (g) resolve(g);
      else reject(new ProviderError('Knihovna panoramat Mapy.com se nenačetla.', 'network'));
    };
    s.onerror = () => {
      scriptPromise = null;
      reject(new ProviderError('Knihovna panoramat Mapy.com se nenačetla.', 'network'));
    };
    document.head.append(s);
  });
  return scriptPromise;
}

const CZ_BOUNDS = { minLng: 12.09, minLat: 48.55, maxLng: 18.86, maxLat: 51.06 };

/** Náhodný bod uvnitř hranic Česka (rovnoměrně podle zeměpisných stupňů). */
export function randomPointInCzechia(rng: Rng = defaultRng): LatLng {
  for (let i = 0; i < 1000; i++) {
    const p = {
      lng: randomBetween(CZ_BOUNDS.minLng, CZ_BOUNDS.maxLng, rng),
      lat: randomBetween(CZ_BOUNDS.minLat, CZ_BOUNDS.maxLat, rng),
    };
    if (pointInGeometry(p, CZ_GEOMETRY)) return p;
  }
  return { lat: 49.8, lng: 15.47 };
}

export const mapyPanoId = (p: LatLng): string => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

export class MapyProvider implements PanoramaProvider {
  readonly id = 'mapy' as const;
  readonly attribution = { label: 'Mapy.com', url: 'https://mapy.com/' };

  constructor(
    private readonly apiKey: string | undefined,
    private readonly rng: Rng = defaultRng,
    private readonly load: () => Promise<PanoramaGlobal> = loadScript,
  ) {}

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  private requireKey(): string {
    if (!this.isConfigured() || !this.apiKey) {
      throw new ProviderError('Chybí klíč Mapy.com (VITE_MAPY_API_KEY).', 'config');
    }
    return this.apiKey;
  }

  async findRandom(_region: RegionDef, signal: AbortSignal): Promise<Target> {
    const apiKey = this.requireKey();
    const Panorama = await this.load();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) throw new DOMException('Zrušeno', 'AbortError');
      const p = randomPointInCzechia(this.rng);
      let res: { exists: boolean; info?: PanoInfo };
      try {
        res = await Panorama.panoramaExists({
          lon: p.lng,
          lat: p.lat,
          apiKey,
          radius: SEARCH_RADIUS_M,
        });
      } catch {
        throw new ProviderError('Nepodařilo se spojit s Mapy.com.', 'network');
      }
      if (!res.exists || !res.info) continue;
      const position = { lng: res.info.lon, lat: res.info.lat };
      // Ověřujeme skutečnou polohu panoramatu, ne jen hledací bod.
      if (!isValidLatLng(position) || !pointInGeometry(position, CZ_GEOMETRY)) continue;
      return {
        provider: 'mapy',
        panoId: mapyPanoId(position),
        position,
        heading: Math.floor(this.rng() * 360),
      };
    }
    throw new ProviderError(
      'V Česku se teď nepodařilo najít panorama. Zkus to znovu.',
      'not-found',
    );
  }

  async createViewer(container: HTMLElement, target: Target): Promise<PanoramaViewer> {
    const apiKey = this.requireKey();
    const Panorama = await this.load();
    const yaw = (((target.heading ?? 0) % 360) * Math.PI) / 180;
    let handle: PanoHandle | null = null;

    const open = async (): Promise<PanoHandle> => {
      container.replaceChildren();
      const h = await Panorama.panoramaFromPosition({
        parent: container,
        lon: target.position.lng,
        lat: target.position.lat,
        apiKey,
        radius: 5,
        yaw,
        showNavigation: true,
        lang: 'cs',
        hideErrors: true,
      });
      if (h.errorCode === 'MISSING_API_KEY' || h.errorCode === 'WRONG_API_KEY') {
        throw new ProviderError('Mapy.com odmítly klíč. Zkontroluj VITE_MAPY_API_KEY.', 'config');
      }
      if (h.errorCode !== 'NONE')
        throw new ProviderError('Panorama teď není dostupné.', 'unavailable');
      return h;
    };

    handle = await open();
    return {
      reset: () => {
        handle?.destroy();
        handle = null;
        void open()
          .then((h) => (handle = h))
          .catch(() => undefined);
      },
      resize: () => window.dispatchEvent(new Event('resize')),
      destroy: () => {
        handle?.destroy();
        handle = null;
      },
    };
  }
}
