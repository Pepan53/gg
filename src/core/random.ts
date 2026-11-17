/** Náhodné číslo 0 <= x < 1; v testech lze podstrčit vlastní generátor. */
export type Rng = () => number;

export const defaultRng: Rng = () => Math.random();

export function randomItem<T>(items: readonly T[], rng: Rng = defaultRng): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}

export function randomBetween(min: number, max: number, rng: Rng = defaultRng): number {
  return min + rng() * (max - min);
}

/** Neprůhledné ID hry. */
export function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
