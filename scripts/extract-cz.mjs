// Vytáhne hranice Česka a Česka + Slovenska z Natural Earth 1:50m (balíček world-atlas)
// do src/data/cz.json a src/data/czsk.json. Spuštění: node scripts/extract-cz.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { feature } from 'topojson-client';

const topo = JSON.parse(
  readFileSync(new URL('../node_modules/world-atlas/countries-50m.json', import.meta.url)),
);
const fc = feature(topo, topo.objects.countries);
const round = (c) => (Array.isArray(c) ? c.map(round) : Math.round(c * 1e4) / 1e4);
const polysOf = (id) => {
  const f = fc.features.find((x) => x.id === id);
  if (!f) throw new Error(`Stát ${id} nenalezen`);
  return f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
};
const write = (file, name, polys) => {
  const out = {
    type: 'Feature',
    properties: { name, source: 'Natural Earth 1:50m via world-atlas' },
    geometry: { type: 'MultiPolygon', coordinates: round(polys) },
  };
  writeFileSync(new URL(`../src/data/${file}`, import.meta.url), JSON.stringify(out));
  console.log(file, JSON.stringify(out).length, 'B');
};
write('cz.json', 'Česko', polysOf('203'));
write('czsk.json', 'Česko a Slovensko', [...polysOf('203'), ...polysOf('703')]);
