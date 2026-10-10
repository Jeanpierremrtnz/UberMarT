import { maskPhone } from '../lib/ecuador.js';
import { conflict, notFound } from '../lib/errors.js';

export function createSafetyService({ db, sms, realtime, audit, trips, logger }) {
  return {
    /**
     * BOTÓN DE PÁNICO: alerta en tiempo real al panel, SMS a los contactos de
     * emergencia con la ubicación y el link de seguimiento del viaje.
     */
    async sos({ userId, tripId, lat, lng, message, ip }) {
      let role = 'passenger';
      let trip = null;
      if (tripId) {
        trip = await db.one(
          `SELECT id, passenger_id, driver_id, status FROM trips WHERE id = $1 AND (passenger_id = $2 OR driver_id = $2)`,
          [tripId, userId],
        );
        if (!trip) throw notFound('Viaje no encontrado');
        role = trip.driver_id === userId ? 'driver' : 'passenger';
      } else if (await db.one(`SELECT 1 FROM drivers WHERE user_id = $1 AND kyc_status = 'approved'`, [userId])) {
        role = 'driver';
      }
      const hasPoint = Number.isFinite(lat) && Number.isFinite(lng);
      const incident = await db.one(
        `INSERT INTO safety_incidents (trip_id, reporter_id, reporter_role, kind, location, message)
         VALUES ($1, $2, $3, 'sos', CASE WHEN $4::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography END, $6)
         RETURNING id, created_at`,
        [trip?.id ?? null, userId, role, hasPoint ? lat : null, hasPoint ? lng : null, message ?? null],
      );
      const user = await db.one('SELECT full_name, phone FROM users WHERE id = $1', [userId]);
      await audit.log({ actorType: 'user', actorId: userId, action: 'safety.sos', targetType: 'incident', targetId: incident.id, ip });
      realtime.toAdmins('sos', {
        incidentId: incident.id,
        at: incident.created_at,
        role,
        user: { id: userId, fullName: user.full_name, phone: user.phone },
        tripId: trip?.id ?? null,
        location: hasPoint ? { lat, lng } : null,
        message: message ?? null,
      });

      let shareUrl = null;
      if (trip && ['searching', 'accepted', 'arrived', 'in_progress'].includes(trip.status)) {
        shareUrl = (await trips.createShareLink({ tripId: trip.id, userId })).url;
      }
      const { rows: contacts } = await db.query('SELECT name, phone FROM emergency_contacts WHERE user_id = $1', [userId]);
      const where = hasPoint ? ` Ubicacion: https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}` : '';
      const follow = shareUrl ? ` Seguimiento en vivo: ${shareUrl}` : '';
      const body = `ALERTA UberMarT: ${user.full_name ?? 'Tu contacto'} activo el boton de panico.${where}${follow} Si no responde llama al ECU 911.`;
      let notified = 0;
      for (const c of contacts) {
        try {
          await sms.send(c.phone, body);
          notified += 1;
        } catch (err) {
          logger.error({ err: err.message, to: maskPhone(c.phone) }, 'No se pudo avisar a un contacto de emergencia');
        }
      }
      return { incidentId: incident.id, notifiedContacts: notified, emergencyNumber: '911' };
    },

    async listIncidents(status = 'open') {
      const { rows } = await db.query(
        `SELECT i.id, i.trip_id, i.reporter_role, i.kind, i.message, i.status, i.created_at, i.handled_at,
                ST_Y(i.location::geometry) AS lat, ST_X(i.location::geometry) AS lng, u.full_name, u.phone
           FROM safety_incidents i JOIN users u ON u.id = i.reporter_id
          WHERE ($1 = 'all' OR i.status = $1) ORDER BY i.created_at DESC LIMIT 100`,
        [status],
      );
      return rows.map((r) => ({
        id: r.id,
        tripId: r.trip_id,
        role: r.reporter_role,
        kind: r.kind,
        message: r.message,
        status: r.status,
        createdAt: r.created_at,
        handledAt: r.handled_at,
        location: r.lat == null ? null : { lat: r.lat, lng: r.lng },
        user: { fullName: r.full_name, phone: r.phone },
      }));
    },

    async updateIncident(id, status, { adminId, ip }) {
      const { rowCount } = await db.query(
        `UPDATE safety_incidents SET status = $2, handled_by = $3, handled_at = now() WHERE id = $1 AND status <> 'resolved'`,
        [id, status, adminId],
      );
      if (!rowCount) throw conflict('INVALID_STATE', 'El incidente ya fue resuelto o no existe');
      await audit.log({ actorType: 'admin', actorId: adminId, action: `incident.${status}`, targetType: 'incident', targetId: id, ip });
    },
  };
}
