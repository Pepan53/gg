/** Klíče z proměnných prostředí při sestavení (viz .env.example). */
export const env = {
  mapillaryToken: (import.meta.env.VITE_MAPILLARY_TOKEN as string | undefined)?.trim() || undefined,
  mapyApiKey: (import.meta.env.VITE_MAPY_API_KEY as string | undefined)?.trim() || undefined,
};
