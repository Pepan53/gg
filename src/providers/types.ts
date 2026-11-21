import type { PanoView, Target } from '../core/game';
import type { LatLng } from '../core/geo';
import type { RegionDef } from '../core/modes';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'network' | 'not-found' | 'unavailable',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface PanoramaViewer {
  /** Vrátí hráče na počáteční panorama a výhled. */
  reset(): void;
  /** Přepočítá velikost po změně rozložení (složení Foldu, otočení). */
  resize(): void;
  destroy(): void;
  /** Aktuální výhled (pro editor výukových míst), pokud ho poskytovatel umí zjistit. */
  getView?(): Promise<PanoView>;
}

export interface PanoramaProvider {
  readonly id: Target['provider'];
  /** Název a odkaz pro atribuci v UI. */
  readonly attribution: { label: string; url: string };
  /** Je nastavený klíč? Bez něj se knihovna poskytovatele vůbec nenačítá. */
  isConfigured(): boolean;
  /** Najde náhodné panorama v oblasti. */
  findRandom(region: RegionDef, signal: AbortSignal): Promise<Target>;
  /** Panorama nejblíž bodu do dané vzdálenosti (volba Města). */
  findNear?(p: LatLng, radiusM?: number, signal?: AbortSignal): Promise<Target | null>;
  /** Zobrazí panorama v kontejneru. Při chybě vyhodí ProviderError. */
  createViewer(container: HTMLElement, target: Target): Promise<PanoramaViewer>;
}
