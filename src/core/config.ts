/** Počet kol jedné hry. */
export const ROUNDS_PER_GAME = 5;

/** Nabízené časové limity v sekundách; 0 = bez limitu. */
export const TIME_LIMITS_SEC: readonly number[] = [0, 60, 120, 180, 300];

/** Uložená hra starší než tato doba se při načtení zahodí (ms). */
export const SAVED_GAME_TTL_MS = 24 * 60 * 60 * 1000;
