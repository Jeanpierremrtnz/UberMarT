import { inBbox } from '../lib/geo.js';
import { ecuadorLocalTime } from '../lib/time.js';
import { unprocessable } from '../lib/errors.js';
import { computeFare, surgeFromDemand, timeRuleMultiplier } from './pricing-engine.js';

const SURGE_CACHE_MS = 30_000;
const RULES_CACHE_MS = 60_000;

export function createPricingService({ db, settings, weather, routing }) {
  const surgeCache = new Map();
  let rulesCache = { at: 0, rules: [] };

  const pointSql = (latParam, lngParam) => `ST_SetSRID(ST_MakePoint(${lngParam}, ${latParam}), 4326)`;

  async function zoneAt({ lat, lng }) {
    return db.one(
      `SELECT id, slug, name, surge_enabled, max_multiplier::float AS max_multiplier
         FROM zones WHERE is_active AND ST_Contains(area, ${pointSql('$1', '$2')}) LIMIT 1`,
      [lat, lng],
    );
  }

  async function zoneSurge(zone) {
    if (!zone.surge_enabled) return { multiplier: 1, demand: null, supply: null };
    const hit = surgeCache.get(zone.id);
    if (hit && Date.now() - hit.at < SURGE_CACHE_MS) return hit.value;
    const [cfg, dispatch] = await Promise.all([settings.get('surge'), settings.get('dispatch')]);
    const counts = await db.one(
      `SELECT
         (SELECT count(DISTINCT passenger_id)::int FROM fare_quotes
           WHERE zone_id = $1 AND created_at > now() - make_interval(mins => $2)) AS demand,
         (SELECT count(*)::int FROM drivers d, zones z
           WHERE z.id = $1 AND d.is_online AND d.kyc_status = 'approved'
             AND d.location_at > now() - make_interval(secs => $3)
             AND ST_Contains(z.area, d.location::geometry)
             AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.driver_id = d.user_id
                              AND t.status IN ('accepted', 'arrived', 'in_progress'))) AS supply`,
      [zone.id, cfg.windowMin, dispatch.locationMaxAgeSec],
    );
    const value = { multiplier: surgeFromDemand(counts, cfg, zone.max_multiplier), demand: counts.demand, supply: counts.supply };
    surgeCache.set(zone.id, { at: Date.now(), value });
    return value;
  }

  async function activeRules() {
    if (Date.now() - rulesCache.at < RULES_CACHE_MS) return rulesCache.rules;
    const { rows } = await db.query(
      `SELECT name, iso_days, to_char(start_local, 'HH24:MI') AS start_local, to_char(end_local, 'HH24:MI') AS end_local,
              multiplier::float AS multiplier, is_active FROM pricing_time_rules WHERE is_active`,
    );
    rulesCache = {
      at: Date.now(),
      rules: rows.map((r) => ({ name: r.name, isoDays: r.iso_days, startLocal: r.start_local, endLocal: r.end_local, multiplier: r.multiplier, isActive: r.is_active })),
    };
    return rulesCache.rules;
  }

  async function nearbySupply({ lat, lng }) {
    const dispatch = await settings.get('dispatch');
    const wallet = await settings.get('wallet');
    return db.one(
      `SELECT count(*)::int AS drivers, min(ST_Distance(d.location, ${pointSql('$1', '$2')}::geography))::int AS nearest_m
         FROM drivers d JOIN wallets w ON w.driver_id = d.user_id
        WHERE d.is_online AND d.kyc_status = 'approved' AND w.balance_cents >= $5
          AND d.location_at > now() - make_interval(secs => $3)
          AND ST_DWithin(d.location, ${pointSql('$1', '$2')}::geography, $4)
          AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.driver_id = d.user_id
                           AND t.status IN ('accepted', 'arrived', 'in_progress'))`,
      [lat, lng, dispatch.locationMaxAgeSec, dispatch.radiiMeters.at(-1), wallet.minBalanceCents],
    );
  }

  return {
    zoneAt,

    invalidateCaches() {
      surgeCache.clear();
      rulesCache = { at: 0, rules: [] };
    },

    /**
     * Cotiza un servicio: 'ride' (pasajero), 'parcel' (mensajería) o 'food'
     * (delivery). `payload` guarda los datos ya validados del paquete o del
     * carrito junto a la cotización, para que no puedan alterarse después.
     */
    async quote({ passengerId, origin, destination, originLabel, destinationLabel, service = 'ride', payload = null, now = new Date() }) {
      if (!inBbox(origin) || !inBbox(destination)) throw unprocessable('OUT_OF_SERVICE_AREA', 'Ubicación fuera del área de servicio');
      const zone = await zoneAt(origin);
      if (!zone) throw unprocessable('OUT_OF_SERVICE_AREA', 'Aún no tenemos servicio en ese punto de recogida');
      const base = await settings.get('pricing');
      let pricing = base;
      let serviceCfg = null;
      if (service !== 'ride') {
        serviceCfg = (await settings.get('services'))[service];
        if (!serviceCfg?.enabled) throw unprocessable('SERVICE_DISABLED', 'Este servicio no está disponible por ahora');
        pricing = {
          ...base,
          baseCents: serviceCfg.baseCents,
          perKmCents: serviceCfg.perKmCents,
          perMinCents: serviceCfg.perMinCents,
          minFareCents: serviceCfg.minFareCents,
        };
      }
      const route = await routing.route(origin, destination);
      if (route.distanceM < pricing.minTripMeters) throw unprocessable('TRIP_TOO_SHORT', 'El destino está demasiado cerca');
      if (route.distanceM > pricing.maxTripMeters) throw unprocessable('TRIP_TOO_LONG', 'El destino supera la distancia máxima permitida');
      if (service === 'food' && route.distanceM > serviceCfg.maxDistanceMeters) {
        throw unprocessable('TOO_FAR', 'Tu dirección está fuera del radio de entrega de este local');
      }
      const durationS = Math.max(60, Math.round(route.durationS * pricing.durationFactor));

      const [surge, rules, weatherNow, supply] = await Promise.all([
        zoneSurge(zone),
        activeRules(),
        weather.status(),
        nearbySupply(origin),
      ]);
      const timeRule = timeRuleMultiplier(rules, ecuadorLocalTime(now));
      const fare = computeFare({
        distanceM: route.distanceM,
        durationS,
        pricing,
        zoneMultiplier: surge.multiplier,
        timeMultiplier: timeRule.multiplier,
        raining: weatherNow.raining,
      });
      const breakdown = { ...fare.breakdown, timeRule: timeRule.rule, routeSource: route.source };
      const q = await db.one(
        `INSERT INTO fare_quotes (passenger_id, origin, destination, origin_label, destination_label, zone_id,
                                  distance_m, duration_s, breakdown, total_cents, expires_at, service, payload)
         VALUES ($1, ${pointSql('$2', '$3')}::geography, ${pointSql('$4', '$5')}::geography, $6, $7, $8, $9, $10, $11, $12,
                 now() + make_interval(secs => $13), $14, $15)
         RETURNING id, expires_at`,
        [passengerId, origin.lat, origin.lng, destination.lat, destination.lng, originLabel ?? null, destinationLabel ?? null,
          zone.id, route.distanceM, durationS, JSON.stringify(breakdown), fare.totalCents, pricing.quoteTtlSec,
          service, payload ? JSON.stringify(payload) : null],
      );
      return {
        quoteId: q.id,
        service,
        totalCents: fare.totalCents,
        currency: 'USD',
        breakdown,
        distanceM: route.distanceM,
        durationS,
        polyline: route.polyline,
        zone: { slug: zone.slug, name: zone.name },
        raining: weatherNow.raining,
        driversNearby: supply.drivers,
        pickupEtaMin: supply.nearest_m == null ? null : Math.max(1, Math.round((supply.nearest_m * 1.3) / 1000 / 25 * 60)),
        expiresAt: q.expires_at,
      };
    },

    /** Estado actual de precios dinámicos para el panel. */
    async snapshot(now = new Date()) {
      const { rows: zones } = await db.query(
        `SELECT id, slug, name, surge_enabled, max_multiplier::float AS max_multiplier, is_active,
                ST_AsGeoJSON(area)::json AS area FROM zones ORDER BY name`,
      );
      const rules = await activeRules();
      const out = [];
      for (const z of zones) {
        const s = z.is_active ? await zoneSurge(z) : { multiplier: 1, demand: null, supply: null };
        out.push({ id: z.id, slug: z.slug, name: z.name, surgeEnabled: z.surge_enabled, maxMultiplier: z.max_multiplier, isActive: z.is_active, area: z.area, ...s });
      }
      return { zones: out, timeRule: timeRuleMultiplier(rules, ecuadorLocalTime(now)), weather: await weather.status() };
    },
  };
}
