import type { MapillaryView, MapyView, PanoView, Target } from './game';
import { haversineKm, isValidLatLng, type LatLng } from './geo';

/**
 * Výukové místo: ručně vybrané panorama s vodítky.
 *
 * Mapillary: ukládáme ID snímku, jeho polohu a výhled (CC BY-SA, smí se uložit).
 * Mapy.com: ukládáme jen bod panoramatu a kameru; obraz se vždy načítá z Mapy.com.
 */
export interface LearningPlace {
  /** Naše stálé ID místa (krátký slug). */
  id: string;
  /** Interní název pro editor; hráč ho uvidí až po vyhodnocení kola. */
  title: string;
  provider: 'mapillary' | 'mapy';
  /** ID snímku Mapillary (jen Mapillary). Může zaniknout, proto kontrolujeme dostupnost. */
  imageId?: string;
  /** Poloha panoramatu v době výběru. */
  position: LatLng;
  /** Počáteční výhled, ke kterému se vztahují vodítka. */
  view: PanoView;
  /** 2 až 3 stručná česká vodítka, která odpovídají výhledu. */
  hints: string[];
  /**
   * draft    - návrh, do hry se nedostane
   * approved - ručně zkontrolováno, hraje se
   */
  status: 'draft' | 'approved';
  /** Kdo a kdy místo naposledy ručně zkontroloval (při schválení povinné). */
  reviewedBy?: string;
  reviewedAt?: string;
  /** Poznámka pro správce (zdroj, co ověřit). */
  note?: string;
}

export interface PlacesFile {
  version: 1;
  places: LearningPlace[];
}

export const MIN_HINTS = 2;
export const MAX_HINTS = 3;
export const MAX_HINT_LENGTH = 160;
/** O kolik se smí snímek „posunout“, aby vodítka ještě platila. */
export const MAX_DRIFT_KM = 0.05;

/** Seznam problémů místa; prázdný = v pořádku. */
export function validatePlace(p: LearningPlace): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9-]{2,40}$/.test(p.id))
    errors.push('ID smí mít jen malá písmena, číslice a pomlčky.');
  if (!p.title.trim()) errors.push('Chybí název.');
  if (p.provider !== 'mapillary' && p.provider !== 'mapy') errors.push('Neznámý poskytovatel.');
  if (p.provider === 'mapillary' && !/^\d{5,20}$/.test(p.imageId ?? '')) {
    errors.push('ID snímku Mapillary musí být číslo.');
  }
  if (!isValidLatLng(p.position)) errors.push('Neplatná poloha.');
  if (!validView(p)) errors.push('Neplatný výhled.');
  const hints = p.hints.map((h) => h.trim()).filter(Boolean);
  if (hints.length < MIN_HINTS || hints.length > MAX_HINTS) {
    errors.push(`Místo potřebuje ${MIN_HINTS} až ${MAX_HINTS} vodítka.`);
  }
  if (hints.some((h) => h.length > MAX_HINT_LENGTH)) {
    errors.push(`Vodítko smí mít nejvýš ${MAX_HINT_LENGTH} znaků.`);
  }
  if (hints.some((h) => /[—–]/.test(h))) errors.push('Ve vodítkách používej jen běžnou pomlčku -.');
  if (p.status === 'approved' && (!p.reviewedBy?.trim() || !p.reviewedAt)) {
    errors.push('Schválené místo musí mít kontrolora a datum kontroly.');
  }
  return errors;
}

function validView(p: LearningPlace): boolean {
  const v = p.view as Partial<MapillaryView & MapyView> | undefined;
  if (!v) return false;
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (p.provider === 'mapy') {
    return num(v.yaw) && num(v.pitch) && num(v.fov) && v.fov > 0 && v.fov <= Math.PI;
  }
  const [cx, cy] = v.center ?? [];
  return (
    num(cx) &&
    num(cy) &&
    cx >= 0 &&
    cx <= 1 &&
    cy >= 0 &&
    cy <= 1 &&
    num(v.zoom) &&
    v.zoom >= 0 &&
    v.zoom <= 3
  );
}

export function validateFile(f: unknown): { file: PlacesFile | null; errors: string[] } {
  if (typeof f !== 'object' || f === null)
    return { file: null, errors: ['Soubor není JSON objekt.'] };
  const file = f as Partial<PlacesFile>;
  if (file.version !== 1 || !Array.isArray(file.places)) {
    return { file: null, errors: ['Chybí version 1 nebo seznam places.'] };
  }
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const p of file.places) {
    for (const e of validatePlace(p)) errors.push(`${p.id || '?'}: ${e}`);
    if (ids.has(p.id)) errors.push(`${p.id}: ID se opakuje.`);
    ids.add(p.id);
  }
  return { file: file as PlacesFile, errors };
}

/** Do hry jdou jen schválená a bezchybná místa. */
export function playablePlaces(file: PlacesFile): LearningPlace[] {
  return file.places.filter((p) => p.status === 'approved' && validatePlace(p).length === 0);
}

export function placeToTarget(p: LearningPlace, actual?: LatLng): Target {
  const position = actual ?? p.position;
  return {
    provider: p.provider,
    panoId:
      p.provider === 'mapy'
        ? `${position.lng.toFixed(6)},${position.lat.toFixed(6)}`
        : (p.imageId ?? ''),
    position,
    view: p.view,
    placeId: p.id,
  };
}

export type Availability =
  | { ok: true; position: LatLng }
  | {
      ok: false;
      reason: 'missing' | 'not-pano' | 'moved' | 'network' | 'no-key';
      position?: LatLng;
    };

/** Výsledek kontroly snímku proti uloženému místu. */
export function judgeAvailability(
  place: LearningPlace,
  found: { exists: boolean; isPano?: boolean; position?: LatLng | null } | null,
): Availability {
  if (!found) return { ok: false, reason: 'network' };
  if (!found.exists) return { ok: false, reason: 'missing' };
  if (found.isPano === false) return { ok: false, reason: 'not-pano' };
  if (!found.position) return { ok: false, reason: 'missing' };
  if (haversineKm(found.position, place.position) > MAX_DRIFT_KM) {
    return { ok: false, reason: 'moved', position: found.position };
  }
  return { ok: true, position: found.position };
}

export const AVAILABILITY_TEXT: Record<Exclude<Availability, { ok: true }>['reason'], string> = {
  missing: 'Panorama už u poskytovatele není.',
  'not-pano': 'Snímek už není 360° panorama.',
  moved: 'Poloha snímku se změnila, vodítka je potřeba zkontrolovat.',
  network: 'Dostupnost se nepodařilo ověřit (síť).',
  'no-key': 'Chybí klíč poskytovatele panoramat.',
};
