import { describe, expect, it } from 'vitest';
import {
  judgeAvailability,
  placeToTarget,
  playablePlaces,
  validateFile,
  validatePlace,
  type LearningPlace,
} from '../src/core/places';
import published from '../src/data/learning-places.json';
import fixture from '../src/data/learning-places.e2e.json';

const base: LearningPlace = {
  id: 'praha-1',
  title: 'Praha',
  provider: 'mapillary',
  imageId: '123456789',
  position: { lat: 50.08, lng: 14.42 },
  view: { center: [0.5, 0.5], zoom: 0 },
  hints: ['Jedna.', 'Dvě.'],
  status: 'draft',
};

describe('výuková místa', () => {
  it('platné místo projde', () => {
    expect(validatePlace(base)).toEqual([]);
  });

  it('vyžaduje 2 až 3 vodítka', () => {
    expect(validatePlace({ ...base, hints: ['Jen jedno.'] })).not.toEqual([]);
    expect(validatePlace({ ...base, hints: ['a', 'b', 'c', 'd'] })).not.toEqual([]);
    expect(validatePlace({ ...base, hints: ['a', '  ', 'b'] })).toEqual([]);
  });

  it('odmítne dlouhé pomlčky a příliš dlouhá vodítka', () => {
    expect(validatePlace({ ...base, hints: ['Most — řeka', 'Dvě.'] })).not.toEqual([]);
    expect(validatePlace({ ...base, hints: ['x'.repeat(161), 'Dvě.'] })).not.toEqual([]);
  });

  it('schválení vyžaduje kontrolora a datum', () => {
    expect(validatePlace({ ...base, status: 'approved' })).not.toEqual([]);
    expect(
      validatePlace({ ...base, status: 'approved', reviewedBy: 'Pepa', reviewedAt: '2026-11-17' }),
    ).toEqual([]);
  });

  it('hrají se jen schválená bezchybná místa', () => {
    const { file, errors } = validateFile(fixture);
    expect(errors).toEqual([]);
    const ids = playablePlaces(file!).map((p) => p.id);
    expect(ids).toEqual(['test-praha', 'test-pariz']);
  });

  it('opakované ID je chyba', () => {
    const { errors } = validateFile({ version: 1, places: [base, base] });
    expect(errors.join()).toContain('opakuje');
  });

  it('zveřejněný soubor je platný', () => {
    expect(validateFile(published).errors).toEqual([]);
  });

  it('převod na cíl kola nese výhled a ID místa', () => {
    expect(placeToTarget(base)).toMatchObject({
      panoId: '123456789',
      placeId: 'praha-1',
      view: base.view,
    });
  });

  it('dostupnost: chybějící, posunutý a v pořádku', () => {
    expect(judgeAvailability(base, null)).toMatchObject({ ok: false, reason: 'network' });
    expect(judgeAvailability(base, { exists: false })).toMatchObject({
      ok: false,
      reason: 'missing',
    });
    expect(
      judgeAvailability(base, { exists: true, isPano: false, position: base.position }),
    ).toMatchObject({
      ok: false,
      reason: 'not-pano',
    });
    expect(
      judgeAvailability(base, {
        exists: true,
        isPano: true,
        position: { lat: 50.081, lng: 14.42 },
      }),
    ).toMatchObject({ ok: false, reason: 'moved' });
    expect(
      judgeAvailability(base, {
        exists: true,
        isPano: true,
        position: { lat: 50.0801, lng: 14.4201 },
      }),
    ).toMatchObject({ ok: true });
  });
});
