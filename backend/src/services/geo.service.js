import { HttpError } from '../lib/errors.js';

// Búsqueda de direcciones a través de un geocodificador compatible con
// Nominatim (idealmente propio). El servidor hace de proxy: oculta claves,
// limita el área a Manta, aplica caché y límites de uso.
const MANTA_VIEWBOX = '-80.86,-0.90,-80.60,-1.06';
const CACHE_TTL_MS = 24 * 3600 * 1000;
const CACHE_MAX = 1000;

export function createGeoService({ config, logger, fetchImpl = fetch }) {
  const cache = new Map();

  async function cached(key, loader) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await loader();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  async function call(path) {
    if (!config.geocoderUrl) throw new HttpError(503, 'GEOCODER_DISABLED', 'Búsqueda no disponible; marca el punto en el mapa');
    try {
      const res = await fetchImpl(`${config.geocoderUrl}${path}`, {
        headers: { 'User-Agent': 'UberMarT/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      logger.warn({ err: err.message }, 'Geocodificador no disponible');
      throw new HttpError(503, 'GEOCODER_UNAVAILABLE', 'Búsqueda no disponible; marca el punto en el mapa');
    }
  }

  return {
    search(q) {
      const query = q.toLowerCase();
      return cached(`s:${query}`, async () => {
        const data = await call(`/search?format=jsonv2&limit=6&countrycodes=ec&bounded=1&viewbox=${MANTA_VIEWBOX}&q=${encodeURIComponent(query)}`);
        return (Array.isArray(data) ? data : []).map((d) => ({ label: d.display_name, lat: Number(d.lat), lng: Number(d.lon) }));
      });
    },
    reverse({ lat, lng }) {
      const key = `r:${lat.toFixed(4)},${lng.toFixed(4)}`;
      return cached(key, async () => {
        const d = await call(`/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`);
        return { label: d?.display_name ?? null, lat, lng };
      });
    },
  };
}
