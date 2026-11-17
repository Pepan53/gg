import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
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

export const COLORS = { guess: '#2563eb', target: '#dc2626' };

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
  return map;
}

export interface GuessMap {
  setPin(p: LatLng | null): void;
  resize(): void;
  destroy(): void;
}

/** Mapa pro tipování: klepnutím (nebo přetažením špendlíku) hráč volí místo. */
export async function createGuessMap(
  container: HTMLElement,
  bbox: BBox,
  initialPin: LatLng | null,
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
      marker = new m.Marker({ color: COLORS.guess, draggable: true })
        .setLngLat([p.lng, p.lat])
        .addTo(map);
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

export interface ResultEntry {
  guess: LatLng | null;
  target: LatLng;
  label?: string;
}

/** Mapa výsledku: cíl, tip a spojnice. Bez tipu jen cíl. */
export async function createResultMap(
  container: HTMLElement,
  entries: ResultEntry[],
  fallbackBBox: BBox,
  onError: () => void,
): Promise<{ resize(): void; destroy(): void }> {
  const m = await loadMapLibre();
  const map = createMap(m, container, fallbackBBox, onError);

  const lines = entries
    .filter((e): e is ResultEntry & { guess: LatLng } => e.guess !== null)
    .map((e) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates: greatCirclePoints(e.guess, e.target) },
    }));

  const bounds = new m.LngLatBounds();
  for (const e of entries) {
    const target = new m.Marker({ color: COLORS.target })
      .setLngLat([e.target.lng, e.target.lat])
      .addTo(map);
    target.getElement().setAttribute('aria-label', e.label ? `Cíl: ${e.label}` : 'Cíl');
    bounds.extend([e.target.lng, e.target.lat]);
    if (e.guess) {
      const g = new m.Marker({ color: COLORS.guess })
        .setLngLat([e.guess.lng, e.guess.lat])
        .addTo(map);
      g.getElement().setAttribute('aria-label', 'Tvůj tip');
    }
  }
  for (const l of lines) for (const c of l.geometry.coordinates) bounds.extend(c);

  map.on('load', () => {
    map.addSource('lines', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: lines },
    });
    map.addLayer({
      id: 'lines',
      type: 'line',
      source: 'lines',
      paint: { 'line-color': '#111827', 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
    });
  });

  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 56, maxZoom: 15, duration: 0 });
  }

  return { resize: () => map.resize(), destroy: () => map.remove() };
}
