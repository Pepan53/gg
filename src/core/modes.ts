import type { BBox } from './geo';
import { WORLD_SCALE_KM, scaleForBBox } from './scoring';

export type ModeId = 'world' | 'cz';
export type ProviderId = 'mapillary' | 'mapy';

export interface ModeDef {
  id: ModeId;
  name: string;
  description: string;
  provider: ProviderId;
  /** Oblast, kterou ukazuje mapa na začátku kola. */
  viewBBox: BBox;
  scaleKm: number;
}

/** Obálka Česka (Natural Earth, zaokrouhleno ven). */
export const CZ_BBOX: BBox = [12.09, 48.55, 18.86, 51.06];
export const WORLD_BBOX: BBox = [-180, -60, 180, 75];

export const MODES: Record<ModeId, ModeDef> = {
  world: {
    id: 'world',
    name: 'Svět',
    description: 'Kdekoli na světě. Panoramata z Mapillary.',
    provider: 'mapillary',
    viewBBox: WORLD_BBOX,
    scaleKm: WORLD_SCALE_KM,
  },
  cz: {
    id: 'cz',
    name: 'Česko',
    description: 'Jen Česká republika. Panoramata z Mapy.com.',
    provider: 'mapy',
    viewBBox: CZ_BBOX,
    scaleKm: scaleForBBox(CZ_BBOX),
  },
};
