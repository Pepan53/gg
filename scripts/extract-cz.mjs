// Vytáhne hranici Česka z Natural Earth 1:50m (balíček world-atlas) do src/data/cz.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { feature } from 'topojson-client';
const topo = JSON.parse(
  readFileSync(new URL('../node_modules/world-atlas/countries-50m.json', import.meta.url)),
);
const fc = feature(topo, topo.objects.countries);
const cz = fc.features.find((f) => f.id === '203');
if (!cz) throw new Error('Česko nenalezeno');
const round = (c) => c.map((x) => (Array.isArray(x) ? round(x) : Math.round(x * 1e4) / 1e4));
const out = {
  type: 'Feature',
  properties: { name: 'Czechia', source: 'Natural Earth 1:50m via world-atlas' },
  geometry: { type: cz.geometry.type, coordinates: round(cz.geometry.coordinates) },
};
writeFileSync(new URL('../src/data/cz.json', import.meta.url), JSON.stringify(out));
console.log(cz.geometry.type, JSON.stringify(out).length, 'bytes');
