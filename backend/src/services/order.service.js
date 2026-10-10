import { randomInt } from 'node:crypto';
import { HttpError, conflict, isUniqueViolation, notFound, unprocessable } from '../lib/errors.js';

// Delivery de comida en moto:
//   cliente cotiza (precios SIEMPRE desde la base de datos) -> confirma pedido
//   -> el local acepta (o se rechaza solo si no responde) -> se despacha la moto
//   cuando falta poco para que esté listo -> el local marca "listo" -> el
//   motorizado paga la comida al local, la lleva y cobra el total al cliente,
//   quien dicta su PIN de entrega.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ACTIVE = ['placed', 'accepted', 'ready', 'picked_up'];
const firstName = (full) => (full ? String(full).trim().split(/\s+/)[0] : null);

function orderCode() {
  let code = '';
  for (let i = 0; i < 6; i += 1) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return code;
}

export function createOrderService({ db, settings, pricing, trips, realtime, audit }) {
  async function loadOrder(orderId, client = db) {
    const { rows } = await client.query(
      `SELECT o.*, m.name AS merchant_name, m.phone AS merchant_phone, m.address_label AS merchant_address,
              t.status AS trip_status, t.delivery_pin, t.driver_id,
              u.full_name AS customer_name
         FROM orders o JOIN merchants m ON m.id = o.merchant_id JOIN users u ON u.id = o.customer_id
         LEFT JOIN trips t ON t.id = o.trip_id
        WHERE o.id = $1`,
      [orderId],
    );
    return rows[0] ?? null;
  }

  async function driverInfo(driverId) {
    if (!driverId) return null;
    const d = await db.one(
      `SELECT u.full_name, d.plate, d.moto_brand, d.moto_model, d.moto_color FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = $1`,
      [driverId],
    );
    return { firstName: firstName(d.full_name), plate: d.plate, moto: [d.moto_brand, d.moto_model, d.moto_color].filter(Boolean).join(' ') };
  }

  async function view(o, audience) {
    const base = {
      id: o.id,
      code: o.code,
      status: o.status,
      statusReason: o.status_reason,
      merchant: { id: o.merchant_id, name: o.merchant_name, addressLabel: o.merchant_address },
      items: o.items,
      subtotalCents: o.subtotal_cents,
      deliveryFeeCents: o.delivery_fee_cents,
      totalCents: o.total_cents,
      note: o.customer_note,
      prepMinutes: o.prep_minutes,
      tripId: o.trip_id,
      tripStatus: o.trip_status ?? null,
      driver: ['accepted', 'arrived', 'in_progress', 'completed'].includes(o.trip_status) ? await driverInfo(o.driver_id) : null,
      placedAt: o.placed_at,
      acceptedAt: o.accepted_at,
      readyAt: o.ready_at,
      pickedUpAt: o.picked_up_at,
      deliveredAt: o.delivered_at,
    };
    if (audience === 'customer') {
      base.merchant.phone = o.merchant_phone;
      base.deliveryPin = ['accepted', 'ready', 'picked_up'].includes(o.status) && o.delivery_pin ? o.delivery_pin : undefined;
    } else {
      // El local ve lo justo: primer nombre del cliente, sin teléfono ni dirección exacta.
      base.customer = { firstName: firstName(o.customer_name) };
      base.commissionCents = o.commission_cents;
    }
    return base;
  }

  async function notify(orderId) {
    const o = await loadOrder(orderId);
    if (!o) return;
    realtime.toUser(o.customer_id, 'order:update', await view(o, 'customer'));
    realtime.toMerchant(o.merchant_id, 'order:update', await view(o, 'merchant'));
  }

  // Cambios del viaje de entrega (asignación, retiro, entrega, sin motorizado).
  trips.setHooks({
    foodTripChanged: async (tripId) => {
      const o = await db.one('SELECT id FROM orders WHERE trip_id = $1', [tripId]);
      if (o) await notify(o.id);
    },
  });

  async function requireMerchantOrder(merchantId, orderId) {
    const o = await loadOrder(orderId);
    if (!o || o.merchant_id !== merchantId) throw notFound('Pedido no encontrado');
    return o;
  }

  return {
    view,

    async quote({ customerId, merchantId, items, destination, destinationLabel }) {
      const food = (await settings.get('services')).food;
      const m = await db.one(
        `SELECT id, name, is_open, status, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
           FROM merchants WHERE id = $1`,
        [merchantId],
      );
      if (!m || m.status !== 'approved') throw notFound('Local no encontrado');
      if (!m.is_open) throw conflict('MERCHANT_CLOSED', 'El local está cerrado en este momento');
      const qty = new Map();
      for (const it of items) qty.set(it.itemId, { qty: (qty.get(it.itemId)?.qty ?? 0) + it.qty, note: it.note ?? qty.get(it.itemId)?.note });
      const { rows } = await db.query(
        `SELECT id, name, price_cents FROM menu_items WHERE merchant_id = $1 AND is_available AND id = ANY($2::uuid[])`,
        [merchantId, [...qty.keys()]],
      );
      const found = new Map(rows.map((r) => [r.id, r]));
      const unavailable = [...qty.keys()].filter((id) => !found.has(id));
      if (unavailable.length) throw new HttpError(409, 'ITEM_UNAVAILABLE', 'Algunos productos ya no están disponibles', { unavailable });
      const lines = [...qty.entries()].map(([id, { qty: n, note }]) => {
        if (n > 20) throw unprocessable('QTY_LIMIT', 'Máximo 20 unidades por producto');
        const r = found.get(id);
        return { itemId: id, name: r.name, priceCents: r.price_cents, qty: n, note: note ?? null };
      });
      const subtotal = lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
      // El motorizado adelanta la comida en efectivo: se limita el monto de cada pedido
      // (y más aún para clientes nuevos) para reducir el riesgo de pedidos falsos.
      const delivered = await db.one(
        `SELECT count(*)::int AS n FROM orders WHERE customer_id = $1 AND status = 'delivered'`,
        [customerId],
      );
      const limit = delivered.n === 0 ? Math.min(food.newCustomerMaxCents, food.maxCashOrderCents) : food.maxCashOrderCents;
      if (subtotal > limit) {
        throw unprocessable('ORDER_LIMIT', `Por seguridad, el pedido no puede superar $${(limit / 100).toFixed(2)}${delivered.n === 0 ? ' en tu primer pedido' : ''}`);
      }
      const q = await pricing.quote({
        passengerId: customerId,
        origin: { lat: m.lat, lng: m.lng },
        destination,
        originLabel: m.name,
        destinationLabel,
        service: 'food',
        payload: { merchantId, items: lines, subtotalCents: subtotal },
      });
      return {
        quoteId: q.quoteId,
        merchant: { id: m.id, name: m.name },
        items: lines,
        subtotalCents: subtotal,
        deliveryFeeCents: q.totalCents,
        totalCents: subtotal + q.totalCents,
        breakdown: q.breakdown,
        distanceM: q.distanceM,
        durationS: q.durationS,
        raining: q.raining,
        expiresAt: q.expiresAt,
      };
    },

    async place({ customerId, quoteId, note, ip }) {
      let orderId;
      for (let attempt = 0; attempt < 3 && !orderId; attempt += 1) {
        try {
          orderId = await db.tx(async (c) => {
            const { rows } = await c.query(
              `SELECT id, used_at, expires_at < now() AS expired, service, payload, total_cents
                 FROM fare_quotes WHERE id = $1 AND passenger_id = $2 FOR UPDATE`,
              [quoteId, customerId],
            );
            const q = rows[0];
            if (!q || q.service !== 'food') throw notFound('Cotización no encontrada');
            if (q.used_at) throw conflict('QUOTE_USED', 'Esta cotización ya fue usada');
            if (q.expired) throw new HttpError(410, 'QUOTE_EXPIRED', 'La cotización venció, vuelve a revisar tu pedido');
            const { rows: m } = await c.query(`SELECT is_open, status FROM merchants WHERE id = $1`, [q.payload.merchantId]);
            if (m[0]?.status !== 'approved' || !m[0].is_open) throw conflict('MERCHANT_CLOSED', 'El local cerró');
            await c.query('UPDATE fare_quotes SET used_at = now() WHERE id = $1', [q.id]);
            const { rows: created } = await c.query(
              `INSERT INTO orders (code, merchant_id, customer_id, quote_id, items, subtotal_cents, delivery_fee_cents, total_cents, customer_note)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
              [orderCode(), q.payload.merchantId, customerId, q.id, JSON.stringify(q.payload.items), q.payload.subtotalCents,
                q.total_cents, q.payload.subtotalCents + q.total_cents, note ?? null],
            );
            await audit.log({ actorType: 'user', actorId: customerId, action: 'order.place', targetType: 'order', targetId: created[0].id, ip }, c);
            return created[0].id;
          });
        } catch (err) {
          if (!isUniqueViolation(err, 'orders_code_key')) throw err;
        }
      }
      const o = await loadOrder(orderId);
      realtime.toMerchant(o.merchant_id, 'order:new', await view(o, 'merchant'));
      return view(o, 'customer');
    },

    async listForCustomer(customerId) {
      const { rows } = await db.query('SELECT id FROM orders WHERE customer_id = $1 ORDER BY placed_at DESC LIMIT 30', [customerId]);
      return Promise.all(rows.map(async (r) => view(await loadOrder(r.id), 'customer')));
    },

    async getForCustomer(customerId, orderId) {
      const o = await loadOrder(orderId);
      if (!o || o.customer_id !== customerId) throw notFound('Pedido no encontrado');
      return view(o, 'customer');
    },

    /** El cliente solo puede cancelar mientras el local no haya aceptado. */
    async cancelByCustomer({ customerId, orderId, ip }) {
      const { rowCount } = await db.query(
        `UPDATE orders SET status = 'cancelled', status_reason = 'cancelado_por_cliente', closed_at = now()
          WHERE id = $1 AND customer_id = $2 AND status = 'placed'`,
        [orderId, customerId],
      );
      if (!rowCount) throw conflict('INVALID_STATE', 'El local ya está preparando tu pedido; para cancelarlo contacta a soporte');
      await audit.log({ actorType: 'user', actorId: customerId, action: 'order.cancel', targetType: 'order', targetId: orderId, ip });
      await notify(orderId);
      return this.getForCustomer(customerId, orderId);
    },

    // ---------------- Panel del local ----------------
    async listForMerchant(merchantId, scope = 'active') {
      const { rows } = await db.query(
        `SELECT id FROM orders WHERE merchant_id = $1 AND (($2 = 'active' AND status = ANY($3)) OR ($2 = 'history' AND NOT (status = ANY($3))))
          ORDER BY placed_at DESC LIMIT 100`,
        [merchantId, scope, ACTIVE],
      );
      return Promise.all(rows.map(async (r) => view(await loadOrder(r.id), 'merchant')));
    },

    async accept({ merchantId, orderId, prepMinutes, actorId, ip }) {
      const food = (await settings.get('services')).food;
      await requireMerchantOrder(merchantId, orderId);
      const { rowCount } = await db.query(
        `UPDATE orders SET status = 'accepted', accepted_at = now(), prep_minutes = $3::int,
                dispatch_at = now() + make_interval(mins => GREATEST($3::int - $4::int, 0))
          WHERE id = $1 AND merchant_id = $2 AND status = 'placed'`,
        [orderId, merchantId, prepMinutes, food.dispatchLeadMin],
      );
      if (!rowCount) throw conflict('INVALID_STATE', 'Este pedido ya no está pendiente');
      await audit.log({ actorType: 'admin', actorId, action: 'order.accept', targetType: 'order', targetId: orderId, ip, details: { prepMinutes } });
      await this.dispatchDue();
      await notify(orderId);
      return view(await loadOrder(orderId), 'merchant');
    },

    async reject({ merchantId, orderId, reason, actorId, ip }) {
      await requireMerchantOrder(merchantId, orderId);
      const { rowCount } = await db.query(
        `UPDATE orders SET status = 'rejected', status_reason = $3, closed_at = now()
          WHERE id = $1 AND merchant_id = $2 AND status = 'placed'`,
        [orderId, merchantId, reason],
      );
      if (!rowCount) throw conflict('INVALID_STATE', 'Este pedido ya no está pendiente');
      await audit.log({ actorType: 'admin', actorId, action: 'order.reject', targetType: 'order', targetId: orderId, ip, details: { reason } });
      await notify(orderId);
      return view(await loadOrder(orderId), 'merchant');
    },

    /** El local marca el pedido listo; si aún no había moto buscándolo, se despacha ya. */
    async ready({ merchantId, orderId, actorId, ip }) {
      await requireMerchantOrder(merchantId, orderId);
      const { rowCount } = await db.query(
        `UPDATE orders SET status = 'ready', ready_at = now(), dispatch_at = LEAST(dispatch_at, now())
          WHERE id = $1 AND merchant_id = $2 AND status = 'accepted'`,
        [orderId, merchantId],
      );
      if (!rowCount) throw conflict('INVALID_STATE', 'El pedido debe estar aceptado para marcarlo listo');
      await audit.log({ actorType: 'admin', actorId, action: 'order.ready', targetType: 'order', targetId: orderId, ip });
      await this.dispatchDue();
      await notify(orderId);
      return view(await loadOrder(orderId), 'merchant');
    },

    async dispatchDue() {
      const { rows } = await db.query(
        `SELECT id FROM orders WHERE trip_id IS NULL AND status IN ('accepted', 'ready') AND dispatch_at <= now() LIMIT 50`,
      );
      for (const r of rows) await trips.createFoodTrip(r.id);
    },

    /** Tareas periódicas: pedidos sin respuesta del local y motos por despachar. */
    async sweep() {
      const food = (await settings.get('services')).food;
      const { rows } = await db.query(
        `UPDATE orders SET status = 'rejected', status_reason = 'sin_respuesta_del_local', closed_at = now()
          WHERE status = 'placed' AND placed_at < now() - make_interval(mins => $1) RETURNING id`,
        [food.merchantResponseMin],
      );
      for (const r of rows) await notify(r.id);
      await this.dispatchDue();
    },

  };
}
