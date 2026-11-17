import type { MultiPolygon, Polygon } from 'geojson';
import czBorder from '../data/cz.json';
import czskBorder from '../data/czsk.json';
import type { BBox } from './geo';
import { WORLD_SCALE_KM, scaleForBBox } from './scoring';

// ---------- oblasti ----------

export type RegionId = 'world' | 'cz' | 'czsk';
export type ProviderId = 'mapillary' | 'mapy';

export interface RegionArea {
  bbox: BBox;
  geometry: Polygon | MultiPolygon;
}

export interface RegionDef {
  id: RegionId;
  name: string;
  description: string;
  provider: ProviderId;
  /** Oblast, kterou ukazuje mapa na začátku kola. */
  viewBBox: BBox;
  scaleKm: number;
  /** Omezení výběru panoramat na území (polygon). Bez něj celý svět. */
  area?: RegionArea;
  /** Smí se panorama zobrazit černobíle? Jen kde to dovoluje licence poskytovatele. */
  grayscaleAllowed: boolean;
}

/** Obálka Česka (Natural Earth, zaokrouhleno ven). */
export const CZ_BBOX: BBox = [12.09, 48.55, 18.86, 51.06];
/** Obálka Česka a Slovenska. */
export const CZSK_BBOX: BBox = [12.09, 47.73, 22.57, 51.06];
export const WORLD_BBOX: BBox = [-180, -60, 180, 75];

export const CZ_GEOMETRY = czBorder.geometry as MultiPolygon;
export const CZSK_GEOMETRY = czskBorder.geometry as MultiPolygon;

export const REGIONS: Record<RegionId, RegionDef> = {
  world: {
    id: 'world',
    name: 'Svět',
    description: 'Kdekoli na světě. Panoramata z Mapillary.',
    provider: 'mapillary',
    viewBBox: WORLD_BBOX,
    scaleKm: WORLD_SCALE_KM,
    grayscaleAllowed: true,
  },
  czsk: {
    id: 'czsk',
    name: 'Česko + Slovensko',
    description: 'Jen Česko a Slovensko. Panoramata z Mapillary.',
    provider: 'mapillary',
    viewBBox: CZSK_BBOX,
    scaleKm: scaleForBBox(CZSK_BBOX),
    area: { bbox: CZSK_BBOX, geometry: CZSK_GEOMETRY },
    grayscaleAllowed: true,
  },
  cz: {
    id: 'cz',
    name: 'Česko',
    description: 'Jen Česko. Panoramata z Mapy.com.',
    provider: 'mapy',
    viewBBox: CZ_BBOX,
    scaleKm: scaleForBBox(CZ_BBOX),
    area: { bbox: CZ_BBOX, geometry: CZ_GEOMETRY },
    // Podmínky Mapy.com úpravu obrazu panoramat výslovně neřeší, proto ji nenabízíme.
    grayscaleAllowed: false,
  },
};

// ---------- typy hry ----------

export type GameType = 'classic' | 'countdown' | 'country' | 'learning';

export interface GameTypeDef {
  id: GameType;
  name: string;
  rules: string;
  /** Pevná délka kola v sekundách (Countdown); jinak volí hráč. */
  fixedTimeSec?: number;
  /** Oblasti, ve kterých má typ smysl. */
  regions: readonly RegionId[];
}

export const COUNTDOWN_SEC = 30;

export const GAME_TYPES: Record<GameType, GameTypeDef> = {
  classic: {
    id: 'classic',
    name: 'Klasika',
    rules: 'Umísti špendlík co nejblíž. Za kolo až 5 000 bodů podle vzdálenosti.',
    regions: ['world', 'czsk', 'cz'],
  },
  countdown: {
    id: 'countdown',
    name: 'Countdown',
    rules:
      'Na kolo máš 30 sekund. Body za vzdálenost se násobí zbývajícím časem, takže se vyplatí tipovat rychle.',
    fixedTimeSec: COUNTDOWN_SEC,
    regions: ['world', 'czsk', 'cz'],
  },
  country: {
    id: 'country',
    name: 'Země',
    rules: 'Klikni do mapy na stát, ve kterém jsi. Správný stát je za 5 000 bodů, jiný za 0.',
    regions: ['world'],
  },
  learning: {
    id: 'learning',
    name: 'Učení',
    rules:
      'Ručně vybraná místa. Hraje se jako Klasika a po každém kole uvidíš 2 až 3 vodítka, podle kterých šlo místo poznat.',
    regions: ['world', 'czsk', 'cz'],
  },
};
