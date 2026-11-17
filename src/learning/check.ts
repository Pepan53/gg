import { judgeAvailability, type Availability, type LearningPlace } from '../core/places';
import type { LatLng } from '../core/geo';
import type { PanoramaProvider } from '../providers/types';

type Info = { exists: boolean; isPano?: boolean; position?: LatLng | null } | null;

/** Poskytovatelé s kontrolou existence panoramatu (Mapillary podle ID, Mapy.com podle bodu). */
interface Checkable {
  isConfigured(): boolean;
  imageInfo?(imageId: string, signal?: AbortSignal): Promise<Info>;
  panoInfo?(p: LatLng, radius?: number): Promise<Info>;
}

/** Ověří, že panorama výukového místa pořád existuje a neposunulo se. */
export async function checkPlace(
  place: LearningPlace,
  providers: Record<'mapillary' | 'mapy', PanoramaProvider>,
  signal?: AbortSignal,
): Promise<Availability> {
  const prov = providers[place.provider] as unknown as Checkable;
  if (!prov.isConfigured()) return { ok: false, reason: 'no-key' };
  let info: Info;
  if (place.provider === 'mapillary') {
    info = prov.imageInfo ? await prov.imageInfo(place.imageId ?? '', signal) : null;
  } else {
    info = prov.panoInfo ? await prov.panoInfo(place.position, 50) : null;
  }
  return judgeAvailability(place, info);
}
