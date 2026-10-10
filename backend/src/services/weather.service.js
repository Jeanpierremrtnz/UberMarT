// Gatillo climático: lluvia moderada o fuerte en Manta (OpenWeather "current weather").
// Códigos: https://openweathermap.org/weather-conditions
const RAIN_CODES = new Set([501, 502, 503, 504, 511, 521, 522, 531]);
const MODERATE_RAIN_MM_H = 2.5;
const CACHE_MS = 10 * 60 * 1000;

export function isModerateOrHeavyRain(payload) {
  const codes = (payload?.weather ?? []).map((w) => Number(w.id));
  if (codes.some((c) => c >= 200 && c < 300)) return true; // tormentas eléctricas
  if (codes.some((c) => RAIN_CODES.has(c))) return true;
  return Number(payload?.rain?.['1h'] ?? 0) >= MODERATE_RAIN_MM_H;
}

export function createWeatherService({ config, settings, logger, fetchImpl = fetch }) {
  let cache = { raining: false, at: 0, source: 'none' };

  async function fetchCurrent() {
    const { apiKey, lat, lng } = config.weather;
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${encodeURIComponent(apiKey)}&units=metric`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`OpenWeather HTTP ${res.status}`);
    return res.json();
  }

  return {
    async status() {
      const { mode } = await settings.get('weather');
      if (mode === 'force_rain') return { raining: true, source: 'manual' };
      if (mode === 'force_dry') return { raining: false, source: 'manual' };
      if (!config.weather.apiKey) return { raining: false, source: 'sin-api' };
      if (Date.now() - cache.at < CACHE_MS) return { raining: cache.raining, source: cache.source };
      try {
        const raining = isModerateOrHeavyRain(await fetchCurrent());
        cache = { raining, at: Date.now(), source: 'openweather' };
      } catch (err) {
        // Si la API falla no se cobra recargo (a favor del cliente) y se reintenta en 1 min.
        logger.warn({ err: err.message }, 'No se pudo consultar el clima');
        cache = { raining: false, at: Date.now() - CACHE_MS + 60_000, source: 'error' };
      }
      return { raining: cache.raining, source: cache.source };
    },
  };
}
