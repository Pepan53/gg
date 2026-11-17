declare module 'vt-pbf' {
  export function fromGeojsonVt(
    layers: Record<string, unknown>,
    opts?: { version?: number },
  ): Uint8Array;
}
declare module 'geojson-vt' {
  export default class GeoJSONVT {
    constructor(data: unknown, opts?: Record<string, unknown>);
    getTile(z: number, x: number, y: number): unknown;
  }
}
