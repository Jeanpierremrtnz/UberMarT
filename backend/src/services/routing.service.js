import { haversineMeters } from '../lib/geo.js';

// Calcula distancia y tiempo con OSRM (servidor propio). Si OSRM no responde,
// usa una estimación conservadora para no bloquear el servicio.
const DETOUR_FACTOR = 1.35;
const FALLBACK_SPEED_KMH = 22;

export function createRoutingService({ config, logger, fetchImpl = fetch }) {
  function estimate(a, b) {
    const distanceM = Math.max(1, Math.round(haversineMeters(a, b) * DETOUR_FACTOR));
    return { distanceM, durationS: Math.max(60, Math.round((distanceM / 1000 / FALLBACK_SPEED_KMH) * 3600)), polyline: null, source: 'estimate' };
  }

  return {
    async route(a, b) {
      if (!config.osrmUrl) return estimate(a, b);
      const url = `${config.osrmUrl}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=simplified&geometries=polyline&alternatives=false&steps=false`;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(2500) });
        const data = await res.json();
        const r = data?.routes?.[0];
        if (data?.code !== 'Ok' || !r) throw new Error(data?.code ?? `HTTP ${res.status}`);
        return { distanceM: Math.max(1, Math.round(r.distance)), durationS: Math.max(60, Math.round(r.duration)), polyline: r.geometry ?? null, source: 'osrm' };
      } catch (err) {
        logger.warn({ err: err.message }, 'OSRM no disponible, usando estimación');
        return estimate(a, b);
      }
    },
  };
}
