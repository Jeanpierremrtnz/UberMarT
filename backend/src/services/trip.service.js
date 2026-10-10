import { randomDigits, randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { encodeE5 } from '../lib/geo.js';
import { HttpError, conflict, forbidden, isUniqueViolation, notFound, tooMany } from '../lib/errors.js';

const ACTIVE_FOR_DRIVER = ['accepted', 'arrived', 'in_progress'];
const PIN_MAX_ATTEMPTS = 5;

const TRIP_COLUMNS = `t.*, ST_Y(t.origin::geometry) AS o_lat, ST_X(t.origin::geometry) AS o_lng,
  ST_Y(t.destination::geometry) AS d_lat, ST_X(t.destination::geometry) AS d_lng`;

const firstName = (full) => (full ? String(full).trim().split(/\s+/)[0] : null);
const rating = (sum, count) => (count ? Math.round((sum / count) * 10) / 10 : null);

export function createTripService({ db, settings, wallet, realtime, audit, activeTrips, config, logger }) {
  async function loadTrip(tripId, client = db) {
    const { rows } = await client.query(`SELECT ${TRIP_COLUMNS} FROM trips t WHERE t.id = $1`, [tripId]);
    return rows[0] ?? null;
  }

  async function view(trip, role) {
    const base = {
      id: trip.id,
      role,
      status: trip.status,
      fareCents: trip.fare_cents,
      paymentMethod: trip.payment_method,
      distanceM: trip.distance_m,
      durationS: trip.duration_s,
      origin: { lat: trip.o_lat, lng: trip.o_lng, label: trip.origin_label },
      destination: { lat: trip.d_lat, lng: trip.d_lng, label: trip.destination_label },
      requestedAt: trip.requested_at,
      acceptedAt: trip.accepted_at,
      startedAt: trip.started_at,
      completedAt: trip.completed_at,
      cancelledBy: trip.cancelled_by,
    };
    if (role === 'passenger') {
      // El PIN solo lo ve el pasajero: se lo dicta al conductor para iniciar el viaje.
      base.pin = ['accepted', 'arrived'].includes(trip.status) ? trip.pin : undefined;
      if (trip.driver_id) {
        const d = await db.one(
          `SELECT u.full_name, u.rating_sum, u.rating_count, d.plate, d.moto_brand, d.moto_model, d.moto_color,
                  ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng, d.heading, d.location_at
             FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = $1`,
          [trip.driver_id],
        );
        base.driver = {
          firstName: firstName(d.full_name),
          rating: rating(d.rating_sum, d.rating_count),
          plate: d.plate,
          moto: [d.moto_brand, d.moto_model, d.moto_color].filter(Boolean).join(' '),
          location: ACTIVE_FOR_DRIVER.includes(trip.status) && d.lat != null ? { lat: d.lat, lng: d.lng, heading: d.heading, at: d.location_at } : null,
        };
      }
    } else {
      const p = await db.one('SELECT full_name, rating_sum, rating_count FROM users WHERE id = $1', [trip.passenger_id]);
      base.passenger = { firstName: firstName(p.full_name), rating: rating(p.rating_sum, p.rating_count) };
      base.commissionCents = trip.commission_cents;
    }
    return base;
  }

  async function notifyPassenger(trip) {
    realtime.toUser(trip.passenger_id, 'trip:update', await view(trip, 'passenger'));
  }

  async function dispatchRound(tripId) {
    const [dispatch, walletCfg] = await Promise.all([settings.get('dispatch'), settings.get('wallet')]);
    const { rows } = await db.query(
      `UPDATE trips SET dispatch_round = dispatch_round + 1, last_dispatch_at = now()
        WHERE id = $1 AND status = 'searching' AND dispatch_round < $2
        RETURNING id, passenger_id, dispatch_round, fare_cents, distance_m, origin_label, destination_label,
                  ST_Y(origin::geometry) AS o_lat, ST_X(origin::geometry) AS o_lng,
                  ST_Y(destination::geometry) AS d_lat, ST_X(destination::geometry) AS d_lng`,
      [tripId, dispatch.radiiMeters.length],
    );
    const t = rows[0];
    if (!t) return 0;
    const radius = dispatch.radiiMeters[t.dispatch_round - 1];
    const { rows: candidates } = await db.query(
      `SELECT d.user_id, ST_Distance(d.location, p.pt)::int AS distance_m
         FROM drivers d
         JOIN users u ON u.id = d.user_id
         JOIN wallets w ON w.driver_id = d.user_id
         CROSS JOIN (SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography AS pt) p
        WHERE d.is_online AND d.kyc_status = 'approved' AND u.status = 'active'
          AND d.location_at > now() - make_interval(secs => $3)
          AND w.balance_cents >= $4
          AND ST_DWithin(d.location, p.pt, $5)
          AND d.user_id <> $6
          AND NOT EXISTS (SELECT 1 FROM trips x WHERE x.driver_id = d.user_id AND x.status IN ('accepted', 'arrived', 'in_progress'))
          AND NOT EXISTS (SELECT 1 FROM trip_offers o WHERE o.trip_id = $7 AND o.driver_id = d.user_id)
        ORDER BY d.location <-> p.pt
        LIMIT $8`,
      [t.o_lat, t.o_lng, dispatch.locationMaxAgeSec, walletCfg.minBalanceCents, radius, t.passenger_id, t.id, dispatch.maxDriversPerRound],
    );
    for (const c of candidates) {
      await db.query(
        `INSERT INTO trip_offers (trip_id, driver_id, round, distance_m) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [t.id, c.user_id, t.dispatch_round, c.distance_m],
      );
      realtime.toUser(c.user_id, 'trip:offer', {
        tripId: t.id,
        pickup: { lat: t.o_lat, lng: t.o_lng, label: t.origin_label },
        dropoff: { lat: t.d_lat, lng: t.d_lng, label: t.destination_label },
        fareCents: t.fare_cents,
        tripDistanceM: t.distance_m,
        pickupDistanceM: c.distance_m,
        expiresInSec: dispatch.offerTimeoutSec,
      });
    }
    realtime.toUser(t.passenger_id, 'trip:searching', { tripId: t.id, round: t.dispatch_round, driversNotified: candidates.length });
    return candidates.length;
  }

  async function sweep() {
    const dispatch = await settings.get('dispatch');
    const { rows } = await db.query(
      `SELECT id, dispatch_round FROM trips
        WHERE status = 'searching' AND (last_dispatch_at IS NULL OR last_dispatch_at < now() - make_interval(secs => $1))
        LIMIT 100`,
      [dispatch.offerTimeoutSec],
    );
    for (const r of rows) {
      await db.query(
        `UPDATE trip_offers SET response = 'expired', responded_at = now() WHERE trip_id = $1 AND response IS NULL`,
        [r.id],
      );
      if (r.dispatch_round < dispatch.radiiMeters.length) {
        await dispatchRound(r.id);
      } else {
        const { rowCount } = await db.query(
          `UPDATE trips SET status = 'expired', cancelled_at = now(), cancelled_by = 'system'
            WHERE id = $1 AND status = 'searching'`,
          [r.id],
        );
        if (rowCount) await notifyPassenger(await loadTrip(r.id));
      }
    }
  }

  function requireRole(trip, userId, role) {
    if (!trip) throw notFound('Viaje no encontrado');
    if (role === 'passenger' && trip.passenger_id !== userId) throw notFound('Viaje no encontrado');
    if (role === 'driver' && trip.driver_id !== userId) throw notFound('Viaje no encontrado');
  }

  return {
    dispatchRound,
    sweep,

    async request({ passengerId, quoteId, ip }) {
      let trip;
      try {
        trip = await db.tx(async (c) => {
          const { rows } = await c.query(
            `SELECT id, used_at, expires_at < now() AS expired FROM fare_quotes WHERE id = $1 AND passenger_id = $2 FOR UPDATE`,
            [quoteId, passengerId],
          );
          const q = rows[0];
          if (!q) throw notFound('Cotización no encontrada');
          if (q.used_at) throw conflict('QUOTE_USED', 'Esta cotización ya fue usada');
          if (q.expired) throw new HttpError(410, 'QUOTE_EXPIRED', 'La tarifa venció, vuelve a cotizar');
          await c.query('UPDATE fare_quotes SET used_at = now() WHERE id = $1', [q.id]);
          const { rows: created } = await c.query(
            `INSERT INTO trips (quote_id, passenger_id, origin, destination, origin_label, destination_label, zone_id,
                                distance_m, duration_s, fare_cents, pin)
             SELECT id, passenger_id, origin, destination, origin_label, destination_label, zone_id,
                    distance_m, duration_s, total_cents, $2
               FROM fare_quotes WHERE id = $1
             RETURNING id`,
            [q.id, randomDigits(4)],
          );
          await audit.log({ actorType: 'user', actorId: passengerId, action: 'trip.request', targetType: 'trip', targetId: created[0].id, ip }, c);
          return created[0];
        });
      } catch (err) {
        if (isUniqueViolation(err, 'trips_active_passenger_uq')) throw conflict('TRIP_ALREADY_ACTIVE', 'Ya tienes un viaje en curso');
        throw err;
      }
      await dispatchRound(trip.id);
      return view(await loadTrip(trip.id), 'passenger');
    },

    async accept({ tripId, driverId, ip }) {
      const [dispatch, walletCfg] = await Promise.all([settings.get('dispatch'), settings.get('wallet')]);
      let trip;
      try {
        trip = await db.tx(async (c) => {
          const { rows: offers } = await c.query(
            `SELECT o.response, o.offered_at < now() - make_interval(secs => $3) AS expired, t.status AS trip_status
               FROM trip_offers o JOIN trips t ON t.id = o.trip_id
              WHERE o.trip_id = $1 AND o.driver_id = $2 FOR UPDATE OF o`,
            [tripId, driverId, dispatch.offerTimeoutSec + 5],
          );
          const offer = offers[0];
          if (!offer) throw notFound('Oferta no encontrada');
          if (offer.trip_status !== 'searching') throw conflict('TRIP_TAKEN', 'Otro conductor ya tomó este viaje');
          if (offer.response || offer.expired) throw new HttpError(410, 'OFFER_EXPIRED', 'La oferta ya venció');
          const { rows: ok } = await c.query(
            `SELECT 1 FROM drivers d JOIN wallets w ON w.driver_id = d.user_id JOIN users u ON u.id = d.user_id
              WHERE d.user_id = $1 AND d.is_online AND d.kyc_status = 'approved' AND u.status = 'active' AND w.balance_cents >= $2`,
            [driverId, walletCfg.minBalanceCents],
          );
          if (!ok[0]) throw forbidden('No cumples las condiciones para aceptar viajes (en línea, aprobado y con saldo)');
          const { rows } = await c.query(
            `UPDATE trips SET status = 'accepted', driver_id = $2, accepted_at = now()
              WHERE id = $1 AND status = 'searching' RETURNING id`,
            [tripId, driverId],
          );
          if (!rows[0]) throw conflict('TRIP_TAKEN', 'Otro conductor ya tomó este viaje');
          await c.query(
            `UPDATE trip_offers SET response = 'accepted', responded_at = now() WHERE trip_id = $1 AND driver_id = $2`,
            [tripId, driverId],
          );
          await audit.log({ actorType: 'user', actorId: driverId, action: 'trip.accept', targetType: 'trip', targetId: tripId, ip }, c);
          return loadTrip(tripId, c);
        });
      } catch (err) {
        if (isUniqueViolation(err, 'trips_active_driver_uq')) throw conflict('DRIVER_BUSY', 'Ya tienes un viaje activo');
        throw err;
      }
      activeTrips.set(driverId, { tripId, passengerId: trip.passenger_id });
      const { rows: others } = await db.query(
        `UPDATE trip_offers SET response = 'expired', responded_at = now()
          WHERE trip_id = $1 AND driver_id <> $2 AND response IS NULL RETURNING driver_id`,
        [tripId, driverId],
      );
      for (const o of others) realtime.toUser(o.driver_id, 'trip:offer_closed', { tripId });
      await notifyPassenger(trip);
      return view(trip, 'driver');
    },

    async decline({ tripId, driverId }) {
      const { rowCount } = await db.query(
        `UPDATE trip_offers SET response = 'declined', responded_at = now()
          WHERE trip_id = $1 AND driver_id = $2 AND response IS NULL`,
        [tripId, driverId],
      );
      if (!rowCount) return;
      const pending = await db.one(
        `SELECT count(*)::int AS n FROM trip_offers WHERE trip_id = $1 AND response IS NULL`,
        [tripId],
      );
      if (pending.n === 0) await dispatchRound(tripId);
    },

    async arrived({ tripId, driverId }) {
      const dispatch = await settings.get('dispatch');
      const { rows } = await db.query(
        `UPDATE trips t SET status = 'arrived', arrived_at = now()
           FROM drivers d
          WHERE t.id = $1 AND t.driver_id = $2 AND t.status = 'accepted' AND d.user_id = t.driver_id
            AND ST_DWithin(d.location, t.origin, $3)
          RETURNING t.id`,
        [tripId, driverId, dispatch.arrivalRadiusMeters],
      );
      if (!rows[0]) {
        const t = await loadTrip(tripId);
        requireRole(t, driverId, 'driver');
        if (t.status !== 'accepted') throw conflict('INVALID_STATE', 'El viaje no está en estado para marcar llegada');
        throw conflict('NOT_AT_PICKUP', 'Aún no estás en el punto de recogida');
      }
      const trip = await loadTrip(tripId);
      activeTrips.set(driverId, { tripId, passengerId: trip.passenger_id });
      await notifyPassenger(trip);
      return view(trip, 'driver');
    },

    /** Inicia el viaje solo si el conductor ingresa el PIN que le dicta el pasajero. */
    async start({ tripId, driverId, pin, ip }) {
      const outcome = await db.tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM trips WHERE id = $1 AND driver_id = $2 FOR UPDATE`, [tripId, driverId]);
        const t = rows[0];
        if (!t) throw notFound('Viaje no encontrado');
        if (t.status !== 'arrived') throw conflict('INVALID_STATE', 'Primero marca que llegaste al punto de recogida');
        if (t.pin_attempts >= PIN_MAX_ATTEMPTS) return { error: 'locked' };
        if (!safeEqual(String(pin), t.pin)) {
          await c.query('UPDATE trips SET pin_attempts = pin_attempts + 1 WHERE id = $1', [tripId]);
          if (t.pin_attempts + 1 >= PIN_MAX_ATTEMPTS) {
            await audit.log({ actorType: 'user', actorId: driverId, action: 'trip.pin_locked', targetType: 'trip', targetId: tripId, ip }, c);
          }
          return { error: 'invalid' };
        }
        await c.query(`UPDATE trips SET status = 'in_progress', started_at = now() WHERE id = $1`, [tripId]);
        return { ok: true };
      });
      if (outcome.error === 'locked') throw tooMany('Demasiados intentos de PIN. El pasajero debe cancelar y pedir de nuevo.');
      if (outcome.error === 'invalid') throw new HttpError(400, 'PIN_INVALID', 'PIN incorrecto. Pídele al pasajero el código de su app.');
      const trip = await loadTrip(tripId);
      await notifyPassenger(trip);
      return view(trip, 'driver');
    },

    async complete({ tripId, driverId, ip }) {
      const walletCfg = await settings.get('wallet');
      const result = await db.tx(async (c) => {
        const { rows } = await c.query(
          `SELECT t.*, ST_Distance(d.location, t.destination)::int AS to_destination_m
             FROM trips t JOIN drivers d ON d.user_id = t.driver_id
            WHERE t.id = $1 AND t.driver_id = $2 FOR UPDATE OF t`,
          [tripId, driverId],
        );
        const t = rows[0];
        if (!t) throw notFound('Viaje no encontrado');
        if (t.status !== 'in_progress') throw conflict('INVALID_STATE', 'El viaje no está en curso');
        const commission = Math.round((t.fare_cents * walletCfg.commissionBps) / 10_000);
        await c.query(
          `UPDATE trips SET status = 'completed', completed_at = now(), commission_cents = $2 WHERE id = $1`,
          [tripId, commission],
        );
        let balance = null;
        if (commission > 0) {
          balance = await wallet.post(c, { driverId, amountCents: -commission, kind: 'commission', refType: 'trip', refId: tripId });
        }
        await audit.log({
          actorType: 'user', actorId: driverId, action: 'trip.complete', targetType: 'trip', targetId: tripId, ip,
          details: { fareCents: t.fare_cents, commission, toDestinationM: t.to_destination_m },
        }, c);
        return { commission, balance, farFromDestination: (t.to_destination_m ?? 0) > 1000 };
      });
      if (result.farFromDestination) logger.warn({ tripId }, 'Viaje completado lejos del destino');
      activeTrips.delete(driverId);
      const trip = await loadTrip(tripId);
      await notifyPassenger(trip);
      if (result.balance !== null) realtime.toUser(driverId, 'wallet:update', { balanceCents: result.balance });
      return { ...(await view(trip, 'driver')), commissionCents: result.commission, balanceCents: result.balance };
    },

    async cancel({ tripId, userId, role, reason, ip }) {
      const trip = await loadTrip(tripId);
      requireRole(trip, userId, role);
      if (role === 'passenger') {
        const { rows } = await db.query(
          `UPDATE trips SET status = 'cancelled', cancelled_by = 'passenger', cancel_reason = $2, cancelled_at = now()
            WHERE id = $1 AND status IN ('searching', 'accepted', 'arrived') RETURNING driver_id`,
          [tripId, reason ?? null],
        );
        if (!rows[0]) throw conflict('INVALID_STATE', 'Este viaje ya no puede cancelarse');
        await db.query(`UPDATE trip_offers SET response = 'expired', responded_at = now() WHERE trip_id = $1 AND response IS NULL`, [tripId]);
        if (rows[0].driver_id) {
          activeTrips.delete(rows[0].driver_id);
          realtime.toUser(rows[0].driver_id, 'trip:update', await view(await loadTrip(tripId), 'driver'));
        }
        await audit.log({ actorType: 'user', actorId: userId, action: 'trip.cancel_passenger', targetType: 'trip', targetId: tripId, ip });
        return view(await loadTrip(tripId), 'passenger');
      }
      // Si el conductor cancela antes de recoger, el viaje vuelve a buscarse con otro conductor.
      const { rows } = await db.query(
        `UPDATE trips SET status = 'searching', driver_id = NULL, accepted_at = NULL, arrived_at = NULL,
                dispatch_round = 0, last_dispatch_at = NULL, pin_attempts = 0
          WHERE id = $1 AND driver_id = $2 AND status IN ('accepted', 'arrived') RETURNING id`,
        [tripId, userId],
      );
      if (!rows[0]) throw conflict('INVALID_STATE', 'Este viaje ya no puede cancelarse');
      activeTrips.delete(userId);
      await audit.log({ actorType: 'user', actorId: userId, action: 'trip.cancel_driver', targetType: 'trip', targetId: tripId, ip, details: { reason } });
      await notifyPassenger(await loadTrip(tripId));
      await dispatchRound(tripId);
      return { id: tripId, status: 'reassigned' };
    },

    async rate({ tripId, userId, role, stars }) {
      const column = role === 'passenger' ? 'rating_by_passenger' : 'rating_by_driver';
      const ownerColumn = role === 'passenger' ? 'passenger_id' : 'driver_id';
      const ratedColumn = role === 'passenger' ? 'driver_id' : 'passenger_id';
      await db.tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE trips SET ${column} = $3 WHERE id = $1 AND ${ownerColumn} = $2 AND status = 'completed' AND ${column} IS NULL
           RETURNING ${ratedColumn} AS rated_id`,
          [tripId, userId, stars],
        );
        if (!rows[0]) throw conflict('CANNOT_RATE', 'Este viaje no puede calificarse');
        await c.query('UPDATE users SET rating_sum = rating_sum + $2, rating_count = rating_count + 1 WHERE id = $1', [rows[0].rated_id, stars]);
      });
    },

    async get({ tripId, userId }) {
      const trip = await loadTrip(tripId);
      if (!trip) throw notFound('Viaje no encontrado');
      if (trip.passenger_id === userId) return view(trip, 'passenger');
      if (trip.driver_id === userId) return view(trip, 'driver');
      throw notFound('Viaje no encontrado');
    },

    async current(userId) {
      const t = await db.one(
        `SELECT ${TRIP_COLUMNS} FROM trips t
          WHERE (t.passenger_id = $1 AND t.status IN ('searching', 'accepted', 'arrived', 'in_progress'))
             OR (t.driver_id = $1 AND t.status IN ('accepted', 'arrived', 'in_progress'))
          ORDER BY t.requested_at DESC LIMIT 1`,
        [userId],
      );
      if (!t) return null;
      return view(t, t.passenger_id === userId ? 'passenger' : 'driver');
    },

    async history(userId) {
      const { rows } = await db.query(
        `SELECT ${TRIP_COLUMNS} FROM trips t WHERE t.passenger_id = $1 OR t.driver_id = $1
          ORDER BY t.requested_at DESC LIMIT 30`,
        [userId],
      );
      return Promise.all(rows.map((t) => view(t, t.passenger_id === userId ? 'passenger' : 'driver')));
    },

    /** Link temporal para que familiares sigan el viaje en vivo. */
    async createShareLink({ tripId, userId }) {
      const token = randomToken(18);
      const { rowCount } = await db.query(
        `UPDATE trips SET share_token_hash = $3
          WHERE id = $1 AND (passenger_id = $2 OR driver_id = $2) AND status IN ('searching', 'accepted', 'arrived', 'in_progress')`,
        [tripId, userId, sha256Hex(token)],
      );
      if (!rowCount) throw conflict('INVALID_STATE', 'Solo puedes compartir viajes activos');
      return { url: `${config.publicBaseUrl}/s/${token}` };
    },

    async sharedView(token) {
      if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(token))) return null;
      const t = await db.one(
        `SELECT t.status, t.destination_label, u.full_name, d.plate, d.moto_brand, d.moto_model, d.moto_color,
                ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng, d.location_at
           FROM trips t LEFT JOIN drivers d ON d.user_id = t.driver_id LEFT JOIN users u ON u.id = t.driver_id
          WHERE t.share_token_hash = $1`,
        [sha256Hex(token)],
      );
      if (!t) return null;
      const active = ['searching', 'accepted', 'arrived', 'in_progress'].includes(t.status);
      return {
        status: t.status,
        active,
        destination: t.destination_label,
        driver: active && t.plate ? { firstName: firstName(t.full_name), plate: t.plate, moto: [t.moto_brand, t.moto_model, t.moto_color].filter(Boolean).join(' ') } : null,
        location: active && t.lat != null ? { lat: t.lat, lng: t.lng, at: t.location_at } : null,
      };
    },

    /** Recibe la ubicación (ya validada) del conductor desde el socket. */
    async ingestLocation(driverId, { lat, lng, heading, speedKmh }) {
      await db.query(
        `UPDATE drivers SET location = ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, location_at = now(), heading = $4
          WHERE user_id = $1`,
        [driverId, lat, lng, heading],
      );
      const active = activeTrips.get(driverId);
      if (active) {
        realtime.toTrip(active.tripId, 'dloc', [encodeE5(lat), encodeE5(lng), heading]);
        await db.query(
          `INSERT INTO trip_points (trip_id, point, speed_kmh) VALUES ($1, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4)`,
          [active.tripId, lat, lng, speedKmh],
        );
      }
    },

    async loadActiveTrips() {
      const { rows } = await db.query(
        `SELECT id, driver_id, passenger_id FROM trips WHERE status IN ('accepted', 'arrived', 'in_progress')`,
      );
      for (const r of rows) activeTrips.set(r.driver_id, { tripId: r.id, passengerId: r.passenger_id });
      return rows.length;
    },

    async canWatch({ tripId, userId }) {
      return Boolean(await db.one(
        `SELECT 1 FROM trips WHERE id = $1 AND (passenger_id = $2 OR driver_id = $2)
            AND status IN ('searching', 'accepted', 'arrived', 'in_progress')`,
        [tripId, userId],
      ));
    },
  };
}
