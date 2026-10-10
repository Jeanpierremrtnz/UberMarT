import { randomDigits, randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { encodeE5 } from '../lib/geo.js';
import { maskPhone, normalizeEcMobile } from '../lib/ecuador.js';
import { sanitizeImage } from '../lib/images.js';
import { HttpError, badRequest, conflict, forbidden, isUniqueViolation, notFound, tooMany, unprocessable } from '../lib/errors.js';

// Un "viaje" es cualquier servicio en moto:
//   ride   -> pasajero (PIN del pasajero al subir)
//   parcel -> mensajería (PIN del remitente al recoger + foto; PIN del destinatario al entregar + foto)
//   food   -> delivery (el local marca "listo"; PIN del cliente al entregar)

const ACTIVE_FOR_DRIVER = ['accepted', 'arrived', 'in_progress'];
const ACTIVE = ['searching', ...ACTIVE_FOR_DRIVER];
const PIN_MAX_ATTEMPTS = 5;

const TRIP_COLUMNS = `t.*, ST_Y(t.origin::geometry) AS o_lat, ST_X(t.origin::geometry) AS o_lng,
  ST_Y(t.destination::geometry) AS d_lat, ST_X(t.destination::geometry) AS d_lng`;

const firstName = (full) => (full ? String(full).trim().split(/\s+/)[0] : null);
const rating = (sum, count) => (count ? Math.round((sum / count) * 10) / 10 : null);
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

export function createTripService({ db, settings, wallet, realtime, audit, activeTrips, config, logger, storage, sms }) {
  let hooks = { foodTripChanged: async () => {} };

  async function loadTrip(tripId, client = db) {
    const { rows } = await client.query(`SELECT ${TRIP_COLUMNS} FROM trips t WHERE t.id = $1`, [tripId]);
    return rows[0] ?? null;
  }

  async function serviceDetails(trip) {
    if (trip.service === 'parcel') {
      return db.one('SELECT * FROM trip_parcels WHERE trip_id = $1', [trip.id]);
    }
    if (trip.service === 'food') {
      return db.one(
        `SELECT o.id, o.code, o.status, o.items, o.subtotal_cents, o.total_cents, m.name AS merchant_name, m.phone AS merchant_phone
           FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.trip_id = $1`,
        [trip.id],
      );
    }
    return null;
  }

  async function view(trip, role) {
    const active = ACTIVE.includes(trip.status);
    const base = {
      id: trip.id,
      role,
      service: trip.service,
      status: trip.status,
      fareCents: trip.fare_cents,
      paymentMethod: trip.payment_method,
      collectCents: trip.collect_cents ?? trip.fare_cents,
      collectAt: trip.collect_at ?? 'dropoff',
      distanceM: trip.distance_m,
      durationS: trip.duration_s,
      origin: { lat: trip.o_lat, lng: trip.o_lng, label: trip.origin_label },
      destination: { lat: trip.d_lat, lng: trip.d_lng, label: trip.destination_label },
      photos: { pickup: Boolean(trip.pickup_photo_key), dropoff: Boolean(trip.dropoff_photo_key) },
      requestedAt: trip.requested_at,
      acceptedAt: trip.accepted_at,
      startedAt: trip.started_at,
      completedAt: trip.completed_at,
      cancelledBy: trip.cancelled_by,
    };
    const details = await serviceDetails(trip);
    if (role === 'passenger') {
      // Los PIN solo los ve el cliente: el de recogida lo dicta al conductor al
      // subir/entregar el paquete; el de entrega lo dicta quien recibe.
      base.pin = trip.service !== 'food' && ['accepted', 'arrived'].includes(trip.status) ? trip.pin : undefined;
      base.deliveryPin = trip.service !== 'ride' && active ? trip.delivery_pin : undefined;
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
      base.payMerchantCents = trip.pay_merchant_cents ?? undefined;
    }
    if (trip.service === 'parcel' && details) {
      base.parcel = {
        recipientName: details.recipient_name,
        // El conductor ve el teléfono del destinatario solo mientras lleva el paquete.
        recipientPhone: role === 'passenger' || trip.status === 'in_progress' ? details.recipient_phone : maskPhone(details.recipient_phone),
        description: details.description,
        size: details.size,
        weightKg: Number(details.weight_kg),
        declaredValueCents: details.declared_value_cents,
        payer: details.payer,
      };
    }
    if (trip.service === 'food' && details) {
      base.order = {
        id: details.id,
        code: details.code,
        status: details.status,
        merchantName: details.merchant_name,
        merchantPhone: role === 'driver' ? details.merchant_phone : undefined,
        items: details.items.map((i) => ({ name: i.name, qty: i.qty, note: i.note ?? null })),
        subtotalCents: details.subtotal_cents,
        totalCents: details.total_cents,
      };
    }
    return base;
  }

  async function notifyPassenger(trip) {
    realtime.toUser(trip.passenger_id, 'trip:update', await view(trip, 'passenger'));
    if (trip.service === 'food') await hooks.foodTripChanged(trip.id);
  }

  async function offerPayload(t, distanceM, dispatch) {
    const payload = {
      tripId: t.id,
      service: t.service,
      pickup: { lat: t.o_lat, lng: t.o_lng, label: t.origin_label },
      dropoff: { lat: t.d_lat, lng: t.d_lng, label: t.destination_label },
      fareCents: t.fare_cents,
      collectCents: t.collect_cents ?? t.fare_cents,
      collectAt: t.collect_at ?? 'dropoff',
      tripDistanceM: t.distance_m,
      pickupDistanceM: distanceM,
      expiresInSec: dispatch.offerTimeoutSec,
    };
    if (t.service === 'parcel') {
      const p = await db.one('SELECT description, size, weight_kg FROM trip_parcels WHERE trip_id = $1', [t.id]);
      payload.parcel = { description: p.description, size: p.size, weightKg: Number(p.weight_kg) };
    }
    if (t.service === 'food') {
      const o = await db.one(
        `SELECT m.name, jsonb_array_length(o.items) AS lines FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.trip_id = $1`,
        [t.id],
      );
      payload.food = { merchantName: o?.name, lines: o?.lines, payMerchantCents: t.pay_merchant_cents };
    }
    return payload;
  }

  async function dispatchRound(tripId) {
    const [dispatch, walletCfg] = await Promise.all([settings.get('dispatch'), settings.get('wallet')]);
    const { rows } = await db.query(
      `UPDATE trips SET dispatch_round = dispatch_round + 1, last_dispatch_at = now()
        WHERE id = $1 AND status = 'searching' AND dispatch_round < $2
        RETURNING id, service, passenger_id, dispatch_round, fare_cents, collect_cents, collect_at, pay_merchant_cents,
                  distance_m, origin_label, destination_label,
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
      realtime.toUser(c.user_id, 'trip:offer', await offerPayload(t, c.distance_m, dispatch));
    }
    realtime.toUser(t.passenger_id, 'trip:searching', { tripId: t.id, service: t.service, round: t.dispatch_round, driversNotified: candidates.length });
    return candidates.length;
  }

  async function sweep() {
    const [dispatch, services] = await Promise.all([settings.get('dispatch'), settings.get('services')]);
    const { rows } = await db.query(
      `SELECT id, service, dispatch_round, requested_at > now() - make_interval(mins => $2) AS within_food_window
         FROM trips
        WHERE status = 'searching' AND (last_dispatch_at IS NULL OR last_dispatch_at < now() - make_interval(secs => $1))
        LIMIT 100`,
      [dispatch.offerTimeoutSec, services.food.searchMaxMin],
    );
    for (const r of rows) {
      await db.query(
        `UPDATE trip_offers SET response = 'expired', responded_at = now() WHERE trip_id = $1 AND response IS NULL`,
        [r.id],
      );
      if (r.dispatch_round < dispatch.radiiMeters.length) {
        await dispatchRound(r.id);
      } else if (r.service === 'food' && r.within_food_window) {
        // La comida ya está preparada: se reintenta la búsqueda (también con
        // quienes no respondieron antes) hasta agotar la ventana configurada.
        await db.query(`DELETE FROM trip_offers WHERE trip_id = $1 AND response = 'expired'`, [r.id]);
        await db.query(`UPDATE trips SET dispatch_round = 0 WHERE id = $1 AND status = 'searching'`, [r.id]);
        await dispatchRound(r.id);
      } else {
        const expired = await db.tx(async (c) => {
          const { rowCount } = await c.query(
            `UPDATE trips SET status = 'expired', cancelled_at = now(), cancelled_by = 'system'
              WHERE id = $1 AND status = 'searching'`,
            [r.id],
          );
          if (rowCount && r.service === 'food') {
            await c.query(
              `UPDATE orders SET status = 'cancelled', status_reason = 'sin_motorizado', closed_at = now()
                WHERE trip_id = $1 AND status IN ('accepted', 'ready')`,
              [r.id],
            );
          }
          return rowCount > 0;
        });
        if (expired) {
          const trip = await loadTrip(r.id);
          await notifyPassenger(trip);
          if (r.service === 'food') realtime.toAdmins('order:no_driver', { tripId: r.id });
        }
      }
    }
  }

  function requireRole(trip, userId, role) {
    if (!trip) throw notFound('Viaje no encontrado');
    if (role === 'passenger' && trip.passenger_id !== userId) throw notFound('Viaje no encontrado');
    if (role === 'driver' && trip.driver_id !== userId) throw notFound('Viaje no encontrado');
  }

  async function issueShareToken(tripId, client = db) {
    const token = randomToken(18);
    await client.query('UPDATE trips SET share_token_hash = $2 WHERE id = $1', [tripId, sha256Hex(token)]);
    return `${config.publicBaseUrl}/s/${token}`;
  }

  /** Mensajería: al recoger el paquete se avisa al destinatario con el seguimiento y su PIN. */
  async function notifyRecipient(trip) {
    const p = await db.one('SELECT recipient_phone, recipient_notified_at FROM trip_parcels WHERE trip_id = $1', [trip.id]);
    if (!p || p.recipient_notified_at) return;
    const sender = await db.one('SELECT full_name FROM users WHERE id = $1', [trip.passenger_id]);
    const url = await issueShareToken(trip.id);
    const collect = trip.collect_at === 'dropoff' ? ` Debes pagar ${money(trip.collect_cents ?? trip.fare_cents)} en efectivo al recibir.` : '';
    try {
      await sms.send(p.recipient_phone,
        `UberMarT: ${firstName(sender.full_name) ?? 'Alguien'} te envia un paquete. Sigue la entrega: ${url} ` +
        `Entrega SOLO con el PIN ${trip.delivery_pin}; no lo compartas antes de recibir.${collect}`);
      await db.query('UPDATE trip_parcels SET recipient_notified_at = now() WHERE trip_id = $1', [trip.id]);
    } catch (err) {
      logger.error({ err: err.message, tripId: trip.id }, 'No se pudo avisar al destinatario');
    }
  }

  return {
    dispatchRound,
    sweep,
    view,
    loadTrip,

    setHooks(next) {
      hooks = { ...hooks, ...next };
    },

    /** Valida y normaliza los datos de un envío antes de cotizarlo. */
    async parcelPayload(input) {
      if (!input) throw badRequest('PARCEL_REQUIRED', 'Faltan los datos del envío');
      const cfg = (await settings.get('services')).parcel;
      const phone = normalizeEcMobile(input.recipientPhone);
      if (!phone) throw badRequest('PHONE_INVALID', 'Celular del destinatario inválido');
      if (input.weightKg > cfg.maxWeightKg) throw unprocessable('TOO_HEAVY', `En moto se envían máximo ${cfg.maxWeightKg} kg`);
      if (input.declaredValueCents > cfg.maxDeclaredValueCents) {
        throw unprocessable('VALUE_TOO_HIGH', `El valor declarado máximo es ${money(cfg.maxDeclaredValueCents)}`);
      }
      return {
        recipientName: input.recipientName,
        recipientPhone: phone,
        description: input.description,
        size: input.size,
        weightKg: Math.round(input.weightKg * 10) / 10,
        declaredValueCents: input.declaredValueCents,
        payer: input.payer,
      };
    },

    /** Viaje de pasajero o envío de mensajería a partir de una cotización. */
    async request({ passengerId, quoteId, ip }) {
      const services = await settings.get('services');
      let trip;
      try {
        trip = await db.tx(async (c) => {
          const { rows } = await c.query(
            `SELECT id, used_at, expires_at < now() AS expired, service, payload, total_cents
               FROM fare_quotes WHERE id = $1 AND passenger_id = $2 FOR UPDATE`,
            [quoteId, passengerId],
          );
          const q = rows[0];
          if (!q) throw notFound('Cotización no encontrada');
          if (q.service === 'food') throw conflict('QUOTE_SERVICE', 'Los pedidos de comida se confirman desde el local');
          if (q.used_at) throw conflict('QUOTE_USED', 'Esta cotización ya fue usada');
          if (q.expired) throw new HttpError(410, 'QUOTE_EXPIRED', 'La tarifa venció, vuelve a cotizar');
          if (q.service === 'parcel') {
            const { rows: act } = await c.query(
              `SELECT count(*)::int AS n FROM trips WHERE passenger_id = $1 AND service = 'parcel' AND status = ANY($2)`,
              [passengerId, ACTIVE],
            );
            if (act[0].n >= services.parcel.maxActivePerSender) {
              throw conflict('TOO_MANY_ACTIVE', 'Tienes demasiados envíos en curso');
            }
          }
          await c.query('UPDATE fare_quotes SET used_at = now() WHERE id = $1', [q.id]);
          const parcel = q.service === 'parcel' ? q.payload : null;
          const { rows: created } = await c.query(
            `INSERT INTO trips (quote_id, passenger_id, origin, destination, origin_label, destination_label, zone_id,
                                distance_m, duration_s, fare_cents, pin, service, delivery_pin, collect_cents, collect_at)
             SELECT id, passenger_id, origin, destination, origin_label, destination_label, zone_id,
                    distance_m, duration_s, total_cents, $2, service, $3, total_cents, $4
               FROM fare_quotes WHERE id = $1
             RETURNING id`,
            [q.id, randomDigits(4), parcel ? randomDigits(4) : null, parcel?.payer === 'sender' ? 'pickup' : 'dropoff'],
          );
          if (parcel) {
            await c.query(
              `INSERT INTO trip_parcels (trip_id, recipient_name, recipient_phone, description, size, weight_kg, declared_value_cents, payer)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [created[0].id, parcel.recipientName, parcel.recipientPhone, parcel.description, parcel.size,
                parcel.weightKg, parcel.declaredValueCents, parcel.payer],
            );
          }
          await audit.log({ actorType: 'user', actorId: passengerId, action: `trip.request_${q.service}`, targetType: 'trip', targetId: created[0].id, ip }, c);
          return created[0];
        });
      } catch (err) {
        if (isUniqueViolation(err, 'trips_active_passenger_uq')) throw conflict('TRIP_ALREADY_ACTIVE', 'Ya tienes un viaje en curso');
        throw err;
      }
      await dispatchRound(trip.id);
      return view(await loadTrip(trip.id), 'passenger');
    },

    /** Crea el viaje de entrega de un pedido de comida (lo llama el servicio de pedidos). */
    async createFoodTrip(orderId) {
      const tripId = await db.tx(async (c) => {
        const { rows } = await c.query(
          `SELECT o.id, o.quote_id, o.customer_id, o.subtotal_cents, o.total_cents
             FROM orders o WHERE o.id = $1 AND o.trip_id IS NULL AND o.status IN ('accepted', 'ready') FOR UPDATE`,
          [orderId],
        );
        const o = rows[0];
        if (!o) return null;
        const { rows: created } = await c.query(
          `INSERT INTO trips (quote_id, passenger_id, origin, destination, origin_label, destination_label, zone_id,
                              distance_m, duration_s, fare_cents, pin, service, delivery_pin, collect_cents, collect_at, pay_merchant_cents)
           SELECT id, passenger_id, origin, destination, origin_label, destination_label, zone_id,
                  distance_m, duration_s, total_cents, $2, 'food', $3, $4, 'dropoff', $5
             FROM fare_quotes WHERE id = $1
           RETURNING id`,
          [o.quote_id, randomDigits(4), randomDigits(4), o.total_cents, o.subtotal_cents],
        );
        await c.query('UPDATE orders SET trip_id = $2 WHERE id = $1', [o.id, created[0].id]);
        return created[0].id;
      });
      if (tripId) {
        await dispatchRound(tripId);
        await hooks.foodTripChanged(tripId);
      }
      return tripId;
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

    /** Foto de evidencia al recoger o al entregar (obligatoria en mensajería). */
    async uploadPhoto({ tripId, driverId, stage, file }) {
      if (!['pickup', 'dropoff'].includes(stage)) throw badRequest('STAGE_INVALID', 'Etapa inválida');
      const t = await loadTrip(tripId);
      requireRole(t, driverId, 'driver');
      if (t.service === 'ride') throw badRequest('NOT_APPLICABLE', 'Los viajes de pasajeros no llevan fotos');
      const allowed = stage === 'pickup' ? 'arrived' : 'in_progress';
      if (t.status !== allowed) throw conflict('INVALID_STATE', stage === 'pickup' ? 'Primero marca que llegaste' : 'El envío no está en camino');
      const img = await sanitizeImage(file?.buffer);
      const key = await storage.put('trip_photos', img.buffer);
      const column = stage === 'pickup' ? 'pickup_photo_key' : 'dropoff_photo_key';
      const { rows } = await db.query(
        `UPDATE trips SET ${column} = $3 WHERE id = $1 AND driver_id = $2 AND status = $4
          RETURNING (SELECT ${column} FROM trips WHERE id = $1) AS previous`,
        [tripId, driverId, key, allowed],
      );
      if (!rows[0]) {
        await storage.remove(key);
        throw conflict('INVALID_STATE', 'El estado del viaje cambió');
      }
      if (rows[0].previous && rows[0].previous !== key) await storage.remove(rows[0].previous);
      return { stage, uploaded: true };
    },

    async photo({ tripId, userId, stage }) {
      const t = await loadTrip(tripId);
      if (!t || (t.passenger_id !== userId && t.driver_id !== userId)) throw notFound('Foto no encontrada');
      const key = stage === 'pickup' ? t.pickup_photo_key : stage === 'dropoff' ? t.dropoff_photo_key : null;
      if (!key) throw notFound('Foto no encontrada');
      return storage.get(key);
    },

    /** Recoger: PIN del pasajero/remitente; en comida, el local debe haber marcado el pedido como listo. */
    async start({ tripId, driverId, pin, ip }) {
      const outcome = await db.tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM trips WHERE id = $1 AND driver_id = $2 FOR UPDATE`, [tripId, driverId]);
        const t = rows[0];
        if (!t) throw notFound('Viaje no encontrado');
        if (t.status !== 'arrived') throw conflict('INVALID_STATE', 'Primero marca que llegaste al punto de recogida');
        if (t.service === 'parcel' && !t.pickup_photo_key) throw conflict('PHOTO_REQUIRED', 'Toma una foto del paquete antes de recogerlo');
        if (t.service === 'food') {
          const { rows: o } = await c.query(`SELECT status FROM orders WHERE trip_id = $1 FOR UPDATE`, [tripId]);
          if (o[0]?.status !== 'ready') throw conflict('ORDER_NOT_READY', 'El local aún no marca el pedido como listo');
          await c.query(`UPDATE orders SET status = 'picked_up', picked_up_at = now() WHERE trip_id = $1`, [tripId]);
        } else {
          if (t.pin_attempts >= PIN_MAX_ATTEMPTS) return { error: 'locked' };
          if (!safeEqual(String(pin ?? ''), t.pin)) {
            await c.query('UPDATE trips SET pin_attempts = pin_attempts + 1 WHERE id = $1', [tripId]);
            if (t.pin_attempts + 1 >= PIN_MAX_ATTEMPTS) {
              await audit.log({ actorType: 'user', actorId: driverId, action: 'trip.pin_locked', targetType: 'trip', targetId: tripId, ip }, c);
            }
            return { error: 'invalid' };
          }
        }
        await c.query(`UPDATE trips SET status = 'in_progress', started_at = now() WHERE id = $1`, [tripId]);
        return { ok: true };
      });
      if (outcome.error === 'locked') throw tooMany('Demasiados intentos de PIN. El cliente debe cancelar y pedir de nuevo.');
      if (outcome.error === 'invalid') throw new HttpError(400, 'PIN_INVALID', 'PIN incorrecto. Pídele al cliente el código de su app.');
      const trip = await loadTrip(tripId);
      if (trip.service === 'parcel') await notifyRecipient(trip);
      await notifyPassenger(trip);
      return view(trip, 'driver');
    },

    /** Entregar: en mensajería y comida exige el PIN de quien recibe (prueba de entrega). */
    async complete({ tripId, driverId, pin, ip }) {
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
        if (t.service === 'parcel' && !t.dropoff_photo_key) throw conflict('PHOTO_REQUIRED', 'Toma una foto de la entrega');
        if (t.service !== 'ride') {
          if (t.delivery_pin_attempts >= PIN_MAX_ATTEMPTS) return { error: 'locked' };
          if (!safeEqual(String(pin ?? ''), t.delivery_pin)) {
            await c.query('UPDATE trips SET delivery_pin_attempts = delivery_pin_attempts + 1 WHERE id = $1', [tripId]);
            if (t.delivery_pin_attempts + 1 >= PIN_MAX_ATTEMPTS) {
              await audit.log({ actorType: 'user', actorId: driverId, action: 'trip.delivery_pin_locked', targetType: 'trip', targetId: tripId, ip }, c);
            }
            return { error: 'invalid' };
          }
        }
        const commission = Math.round((t.fare_cents * walletCfg.commissionBps) / 10_000);
        await c.query(
          `UPDATE trips SET status = 'completed', completed_at = now(), commission_cents = $2 WHERE id = $1`,
          [tripId, commission],
        );
        let balance = null;
        if (commission > 0) {
          balance = await wallet.post(c, { driverId, amountCents: -commission, kind: 'commission', refType: 'trip', refId: tripId });
        }
        if (t.service === 'food') {
          const { rows: o } = await c.query(
            `SELECT o.id, o.merchant_id, o.subtotal_cents, m.commission_bps
               FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.trip_id = $1 FOR UPDATE OF o`,
            [tripId],
          );
          const order = o[0];
          const merchantCommission = Math.round((order.subtotal_cents * order.commission_bps) / 10_000);
          await c.query(
            `UPDATE orders SET status = 'delivered', delivered_at = now(), closed_at = now(), commission_cents = $2 WHERE id = $1`,
            [order.id, merchantCommission],
          );
          if (merchantCommission > 0) {
            await c.query(
              `INSERT INTO merchant_ledger (merchant_id, amount_cents, kind, ref_type, ref_id) VALUES ($1, $2, 'commission', 'order', $3)`,
              [order.merchant_id, merchantCommission, order.id],
            );
          }
        }
        await audit.log({
          actorType: 'user', actorId: driverId, action: 'trip.complete', targetType: 'trip', targetId: tripId, ip,
          details: { service: t.service, fareCents: t.fare_cents, commission, toDestinationM: t.to_destination_m },
        }, c);
        return { commission, balance, farFromDestination: (t.to_destination_m ?? 0) > 1000 };
      });
      if (result.error === 'locked') throw tooMany('Demasiados intentos de PIN de entrega. Contacta a soporte.');
      if (result.error === 'invalid') throw new HttpError(400, 'PIN_INVALID', 'PIN de entrega incorrecto. Pídelo a quien recibe.');
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
        if (trip.service === 'food') {
          throw conflict('FOOD_CANCEL', 'El pedido ya está en preparación; para cancelarlo comunícate con soporte');
        }
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
      // Si el conductor cancela antes de recoger, el servicio vuelve a buscarse con otro conductor.
      const { rows } = await db.query(
        `UPDATE trips SET status = 'searching', driver_id = NULL, accepted_at = NULL, arrived_at = NULL,
                dispatch_round = 0, last_dispatch_at = NULL, pin_attempts = 0, pickup_photo_key = NULL
          WHERE id = $1 AND driver_id = $2 AND status IN ('accepted', 'arrived') RETURNING id`,
        [tripId, userId],
      );
      if (!rows[0]) throw conflict('INVALID_STATE', 'Este viaje ya no puede cancelarse');
      if (trip.pickup_photo_key) await storage.remove(trip.pickup_photo_key);
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

    /** Servicio activo del usuario: el del conductor, o el más reciente del cliente. */
    async current(userId) {
      const t = await db.one(
        `SELECT ${TRIP_COLUMNS} FROM trips t
          WHERE (t.passenger_id = $1 AND t.status IN ('searching', 'accepted', 'arrived', 'in_progress'))
             OR (t.driver_id = $1 AND t.status IN ('accepted', 'arrived', 'in_progress'))
          ORDER BY (t.driver_id = $1) DESC, t.requested_at DESC LIMIT 1`,
        [userId],
      );
      if (!t) return null;
      return view(t, t.passenger_id === userId ? 'passenger' : 'driver');
    },

    /** Todos los servicios activos del cliente (puede tener varios envíos o pedidos). */
    async active(userId) {
      const { rows } = await db.query(
        `SELECT ${TRIP_COLUMNS} FROM trips t
          WHERE t.passenger_id = $1 AND t.status IN ('searching', 'accepted', 'arrived', 'in_progress')
          ORDER BY t.requested_at DESC LIMIT 10`,
        [userId],
      );
      return Promise.all(rows.map((t) => view(t, 'passenger')));
    },

    async history(userId) {
      const { rows } = await db.query(
        `SELECT ${TRIP_COLUMNS} FROM trips t WHERE t.passenger_id = $1 OR t.driver_id = $1
          ORDER BY t.requested_at DESC LIMIT 30`,
        [userId],
      );
      return Promise.all(rows.map((t) => view(t, t.passenger_id === userId ? 'passenger' : 'driver')));
    },

    /** Link temporal para que familiares (o el destinatario) sigan el servicio en vivo. */
    async createShareLink({ tripId, userId }) {
      const t = await db.one(
        `SELECT id FROM trips WHERE id = $1 AND (passenger_id = $2 OR driver_id = $2) AND status = ANY($3)`,
        [tripId, userId, ACTIVE],
      );
      if (!t) throw conflict('INVALID_STATE', 'Solo puedes compartir viajes activos');
      return { url: await issueShareToken(tripId) };
    },

    async sharedView(token) {
      if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(token))) return null;
      const t = await db.one(
        `SELECT t.status, t.service, t.destination_label, u.full_name, d.plate, d.moto_brand, d.moto_model, d.moto_color,
                ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng, d.location_at
           FROM trips t LEFT JOIN drivers d ON d.user_id = t.driver_id LEFT JOIN users u ON u.id = t.driver_id
          WHERE t.share_token_hash = $1`,
        [sha256Hex(token)],
      );
      if (!t) return null;
      const active = ACTIVE.includes(t.status);
      return {
        status: t.status,
        service: t.service,
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
