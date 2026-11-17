// Vytvoří src/data/countries.json: hranice států z Natural Earth 1:50m (balíček world-atlas,
// public domain) s českými názvy. Spuštění: node scripts/build-countries.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const countries = require('i18n-iso-countries');
countries.registerLocale(require('i18n-iso-countries/langs/cs.json'));

const topo = JSON.parse(
  readFileSync(new URL('../node_modules/world-atlas/countries-50m.json', import.meta.url)),
);
/** Území bez kódu ISO v Natural Earth: přiřazení podle mezinárodně uznaného státu. */
const NO_ID = {
  Somaliland: 'SO',
  'N. Cyprus': 'CY',
  'Indian Ocean Ter.': 'AU',
  Kosovo: 'XK',
};
/** Území, která se ve hře nehrají (nejsou cílem ani volbou). */
const SKIP = new Set(['010' /* Antarktida */, 'Siachen Glacier']);
/** Kratší běžné názvy. */
const NAME_OVERRIDES = {
  CZ: 'Česko',
  GB: 'Velká Británie',
  US: 'USA',
  PS: 'Palestina',
  CD: 'Kongo (DR)',
  CG: 'Kongo',
  XK: 'Kosovo',
};

// Topologii (sdílené hrany, kvantizace) necháváme, je to ~4x menší než GeoJSON.
const geoms = topo.objects.countries.geometries;
const byCode = new Map();
for (const g of geoms) {
  const key = g.id ?? g.properties.name;
  if (SKIP.has(key)) continue;
  const code = g.id ? countries.numericToAlpha2(g.id) : NO_ID[g.properties.name];
  if (!code) throw new Error(`Bez kódu: ${key} ${g.properties.name}`);
  const polys = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
  const entry = byCode.get(code) ?? { code, polys: [] };
  entry.polys.push(...polys);
  byCode.set(code, entry);
}
topo.objects = {
  countries: {
    type: 'GeometryCollection',
    geometries: [...byCode.values()].map(({ code, polys }) => ({
      type: 'MultiPolygon',
      arcs: polys,
      properties: { code, name: NAME_OVERRIDES[code] ?? countries.getName(code, 'cs') ?? code },
    })),
  },
};
// Kontrola: převod zpět na GeoJSON musí projít.
const fc = feature(topo, topo.objects.countries);
writeFileSync(new URL('../src/data/countries.topo.json', import.meta.url), JSON.stringify(topo));
console.log(fc.features.length, 'států,', JSON.stringify(topo).length, 'B');
