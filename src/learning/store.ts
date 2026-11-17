import { validateFile, type PlacesFile } from '../core/places';
import published from '../data/learning-places.json';
import e2eFixture from '../data/learning-places.e2e.json';

/**
 * Zveřejněná výuková místa (soubor v repozitáři). V testovacím buildu se místo
 * nich použijí testovací místa, aby šel režim Učení vyzkoušet bez sítě.
 */
export function publishedPlaces(): PlacesFile {
  const raw = import.meta.env.VITE_E2E === '1' ? e2eFixture : published;
  const { file } = validateFile(raw);
  return file ?? { version: 1, places: [] };
}

const DRAFT_KEY = 'gg.places.draft.v1';

/** Rozpracované změny z editoru, uložené jen v tomto prohlížeči. */
export function loadDraft(): PlacesFile | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const { file } = validateFile(JSON.parse(raw));
    return file;
  } catch {
    return null;
  }
}

export function saveDraft(file: PlacesFile): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(file));
  } catch {
    // plné úložiště: změny zůstanou jen do zavření stránky
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignorovat
  }
}
