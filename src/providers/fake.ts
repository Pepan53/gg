import type { Target } from '../core/game';
import type { ModeDef } from '../core/modes';
import type { PanoramaProvider, PanoramaViewer } from './types';

/**
 * Testovací náhrada poskytovatele pro end-to-end testy (build s VITE_E2E=1).
 * Nevolá žádné vnější služby. Do produkčního buildu se nedostane.
 */
const PLACES: Record<string, { lat: number; lng: number }[]> = {
  world: [
    { lat: 48.8584, lng: 2.2945 },
    { lat: -33.8568, lng: 151.2153 },
    { lat: 40.6892, lng: -74.0445 },
    { lat: 35.6586, lng: 139.7454 },
    { lat: -22.9519, lng: -43.2105 },
  ],
  cz: [
    { lat: 50.0875, lng: 14.4213 },
    { lat: 49.1951, lng: 16.6068 },
    { lat: 49.8209, lng: 18.2625 },
    { lat: 50.7671, lng: 15.0562 },
    { lat: 48.9745, lng: 14.4743 },
  ],
};

export class FakeProvider implements PanoramaProvider {
  readonly attribution = { label: 'Test', url: 'https://example.invalid' };
  private n = 0;
  constructor(readonly id: Target['provider']) {}

  isConfigured(): boolean {
    return true;
  }

  async findRandom(mode: ModeDef): Promise<Target> {
    const list = PLACES[mode.id] ?? PLACES['world'] ?? [];
    const position = list[this.n++ % list.length] ?? { lat: 0, lng: 0 };
    await new Promise((r) => setTimeout(r, 50));
    return { provider: this.id, panoId: `fake-${mode.id}-${this.n}`, position, heading: 0 };
  }

  async createViewer(container: HTMLElement): Promise<PanoramaViewer> {
    const el = document.createElement('div');
    el.className = 'fake-pano';
    el.setAttribute('data-testid', 'fake-pano');
    el.style.cssText =
      'position:absolute;inset:0;display:grid;place-items:center;color:#fff;font:600 1.2rem system-ui;' +
      'background:linear-gradient(#7dd3fc 0 55%, #65a30d 55% 100%)';
    el.textContent = 'Testovací panorama';
    container.replaceChildren(el);
    return { reset: () => undefined, resize: () => undefined, destroy: () => el.remove() };
  }
}
