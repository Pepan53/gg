import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import { mainPolygon, type CountryIndex } from '../core/countries';
import type { BBox, LatLng } from '../core/geo';
import { greatCirclePoints } from '../core/greatCircle';

/** Bezplatné vektorové dlaždice z OpenStreetMap, bez klíče. */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

type MapLibre = typeof import('maplibre-gl');
let lib: Promise<MapLibre> | null = null;

async function loadMapLibre(): Promise<MapLibre> {
  lib ??= Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'),
    import('maplibre-gl/dist/maplibre-gl.css'),
  ]).then(([m, worker]) => {
    // Bundler přesouvá knihovnu jinam, proto worker předáváme explicitně.
    m.setWorkerUrl(worker.default);
    return m;
  });
  return lib;
}

export const TARGET_COLOR = '#dc2626';
/** Barvy hráčů (tip, vybraný stát). Odlišné od červené barvy cíle. */
export const PLAYER_COLORS = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#0891b2', '#a16207'];
export const playerColor = (i: number): string =>
  PLAYER_COLORS[i % PLAYER_COLORS.length] ?? '#2563eb';

/** V testovacím buildu zpřístupní mapu e2e testům. */
function exposeForTests(map: MlMap): void {
  if (import.meta.env.VITE_E2E === '1') (window as unknown as { __ggMap?: MlMap }).__ggMap = map;
}

function createMap(m: MapLibre, container: HTMLElement, bbox: BBox, onError: () => void): MlMap {
  const map = new m.Map({
    container,
    style: MAP_STYLE_URL,
    bounds: [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    fitBoundsOptions: { padding: 16 },
    attributionControl: { compact: true },
    dragRotate: false,
    touchPitch: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  let failed = false;
  map.on('error', (e) => {
    // Chyba stylu nebo dlaždic: ohlásit jen jednou, mapa se může zotavit sama.
    const msg = String(e.error?.message ?? '');
    if (!failed && !map.isStyleLoaded() && msg) {
      failed = true;
      onError();
    }
  });
  exposeForTests(map);
  return map;
}

function whenLoaded(map: MlMap, fn: () => void): void {
  if (map.isStyleLoaded()) fn();
  else map.once('load', fn);
}

export interface GuessMap {
  setPin(p: LatLng | null): void;
  resize(): void;
  destroy(): void;
}

/** Mapa pro bodový tip: klepnutím (nebo přetažením špendlíku) hráč volí místo. */
export async function createGuessMap(
  container: HTMLElement,
  bbox: BBox,
  initialPin: LatLng | null,
  color: string,
  onPin: (p: LatLng) => void,
  onError: () => void,
): Promise<GuessMap> {
  const m = await loadMapLibre();
  const map = createMap(m, container, bbox, onError);
  let marker: MlMarker | null = null;

  const setPin = (p: LatLng | null) => {
    if (!p) {
      marker?.remove();
      marker = null;
      return;
    }
    if (!marker) {
      marker = new m.Marker({ color, draggable: true }).setLngLat([p.lng, p.lat]).addTo(map);
      marker.getElement().setAttribute('aria-label', 'Tvůj tip');
      marker.on('dragend', () => {
        const ll = marker?.getLngLat().wrap();
        if (ll) onPin({ lat: ll.lat, lng: ll.lng });
      });
    } else {
      marker.setLngLat([p.lng, p.lat]);
    }
  };

  map.on('click', (e) => {
    const ll = e.lngLat.wrap();
    onPin({ lat: ll.lat, lng: ll.lng });
  });
  setPin(initialPin);

  return { setPin, resize: () => map.resize(), destroy: () => map.remove() };
}

export interface CountryMap {
  select(code: string | null): void;
  resize(): void;
  destroy(): void;
}

/** Mapa pro mód Země: klepnutím hráč vybírá stát. Moře nic nevybere. */
export async function createCountryMap(
  container: HTMLElement,
  bbox: BBox,
  countries: CountryIndex,
  initial: string | null,
  color: string,
  onPick: (code: string | null) => void,
  onError: () => void,
): Promise<CountryMap> {
  const m = await loadMapLibre();
  const map = createMap(m, container, bbox, onError);
  let selected = initial;

  const apply = () => {
    if (map.getLayer('country-selected')) {
      map.setFilter('country-selected', ['==', ['get', 'code'], selected ?? '']);
    }
  };

  whenLoaded(map, () => {
    map.addSource('countries', { type: 'geojson', data: countries.collection });
    map.addLayer({
      id: 'country-selected',
      type: 'fill',
      source: 'countries',
      paint: { 'fill-color': color, 'fill-opacity': 0.45 },
      filter: ['==', ['get', 'code'], ''],
    });
    map.addLayer({
      id: 'country-lines',
      type: 'line',
      source: 'countries',
      paint: { 'line-color': '#334155', 'line-width': 0.8, 'line-opacity': 0.6 },
    });
    apply();
  });

  map.on('click', (e) => {
    const ll = e.lngLat.wrap();
    // Stejné určení státu jako u cíle kola (Natural Earth, bod v polygonu).
    const f = countries.countryAt({ lat: ll.lat, lng: ll.lng });
    onPick(f ? f.properties.code : null);
  });

  return {
    select(code) {
      selected = code;
      apply();
    },
    resize: () => map.resize(),
    destroy: () => map.remove(),
  };
}

export interface ResultEntry {
  guess: LatLng | null;
  target: LatLng;
  color: string;
  label?: string;
}

export interface CountryHighlight {
  code: string;
  color: string;
}

/** Mapa výsledku: cíl, tipy a spojnice; v módu Země i zvýrazněné státy. */
export async function createResultMap(
  container: HTMLElement,
  entries: ResultEntry[],
  fallbackBBox: BBox,
  onError: () => void,
  countries?: { index: CountryIndex; highlights: CountryHighlight[] },
): Promise<{ resize(): void; destroy(): void }> {
  const m = await loadMapLibre();
  const map = createMap(m, container, fallbackBBox, onError);

  const lines = entries
    .filter((e): e is ResultEntry & { guess: LatLng } => e.guess !== null)
    .map((e) => ({
      type: 'Feature' as const,
      properties: { color: e.color },
      geometry: { type: 'LineString' as const, coordinates: greatCirclePoints(e.guess, e.target) },
    }));

  const bounds = new m.LngLatBounds();
  const targets = new Set<string>();
  for (const e of entries) {
    const key = `${e.target.lat},${e.target.lng}`;
    if (!targets.has(key)) {
      targets.add(key);
      const t = new m.Marker({ color: TARGET_COLOR })
        .setLngLat([e.target.lng, e.target.lat])
        .addTo(map);
      t.getElement().setAttribute('aria-label', 'Cíl');
    }
    bounds.extend([e.target.lng, e.target.lat]);
    if (e.guess) {
      const g = new m.Marker({ color: e.color }).setLngLat([e.guess.lng, e.guess.lat]).addTo(map);
      g.getElement().setAttribute('aria-label', e.label ? `Tip: ${e.label}` : 'Tip');
    }
  }
  for (const l of lines) for (const c of l.geometry.coordinates) bounds.extend(c);

  whenLoaded(map, () => {
    if (countries && countries.highlights.length > 0) {
      const features = countries.highlights.flatMap((hl) => {
        const f = countries.index.byCode(hl.code);
        return f ? [{ ...f, properties: { ...f.properties, color: hl.color } }] : [];
      });
      map.addSource('hl', { type: 'geojson', data: { type: 'FeatureCollection', features } });
      map.addLayer({
        id: 'hl-fill',
        type: 'fill',
        source: 'hl',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.35 },
      });
      map.addLayer({
        id: 'hl-line',
        type: 'line',
        source: 'hl',
        paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
      });
    }
    map.addSource('lines', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: lines },
    });
    map.addLayer({
      id: 'lines',
      type: 'line',
      source: 'lines',
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
    });
  });

  if (countries) {
    for (const hl of countries.highlights) {
      const f = countries.index.byCode(hl.code);
      const poly = f && mainPolygon(f);
      // Jen hlavní území (Francie bez Guyany a Réunionu), jinak by výřez byl celý svět.
      for (const [x = 0, y = 0] of poly?.[0] ?? []) bounds.extend([x > 180 ? x - 360 : x, y]);
    }
  }
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 56, maxZoom: 15, duration: 0 });
  }

  return { resize: () => map.resize(), destroy: () => map.remove() };
}
