import { decryptString, encrypt } from '../lib/crypto.js';
import { sanitizeImage } from '../lib/images.js';
import { maskPhone, normalizePlate } from '../lib/ecuador.js';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../lib/errors.js';

export const REQUIRED_DOCUMENTS = Object.freeze([
  'cedula_front',
  'cedula_back',
  'license_front',
  'license_back',
  'vehicle_registration',
  'criminal_record',
  'selfie',
  'moto_photo',
]);

const EDITABLE = new Set(['draft', 'rejected']);

export function createDriverService({ db, keys, storage, settings, audit, realtime }) {
  const licenseAad = (driverId) => `drivers.license:${driverId}`;

  async function application(driverId) {
    const d = await db.one(
      `SELECT d.*, u.full_name, (u.cedula_bidx IS NOT NULL) AS has_cedula FROM drivers d JOIN users u ON u.id = d.user_id
        WHERE d.user_id = $1`,
      [driverId],
    );
    if (!d) return null;
    const { rows: docs } = await db.query('SELECT kind, created_at FROM driver_documents WHERE driver_id = $1', [driverId]);
    const uploaded = new Set(docs.map((x) => x.kind));
    return {
      status: d.kyc_status,
      note: d.kyc_note,
      plate: d.plate,
      licenseExpiresOn: d.license_expires_on,
      moto: { brand: d.moto_brand, model: d.moto_model, year: d.moto_year, color: d.moto_color },
      documents: REQUIRED_DOCUMENTS.map((kind) => ({ kind, uploaded: uploaded.has(kind) })),
      isOnline: d.is_online,
      submittedAt: d.submitted_at,
    };
  }

  return {
    application,

    async saveApplication(userId, input, { ip }) {
      const user = await db.one('SELECT full_name, cedula_bidx FROM users WHERE id = $1', [userId]);
      if (!user.full_name || !user.cedula_bidx) throw forbidden('Completa tu nombre y cédula antes de registrarte como conductor');
      const plate = normalizePlate(input.plate);
      if (!plate) throw badRequest('PLATE_INVALID', 'Placa inválida (ej. AB123C)');
      const expires = new Date(`${input.licenseExpiresOn}T00:00:00-05:00`);
      if (Number.isNaN(expires.getTime()) || expires <= new Date()) {
        throw badRequest('LICENSE_EXPIRED', 'Tu licencia debe estar vigente');
      }
      const existing = await db.one('SELECT kyc_status FROM drivers WHERE user_id = $1', [userId]);
      if (existing && !EDITABLE.has(existing.kyc_status)) throw conflict('APPLICATION_LOCKED', 'Tu solicitud ya está en revisión o aprobada');
      try {
        await db.query(
          `INSERT INTO drivers (user_id, license_number_enc, license_expires_on, plate, moto_brand, moto_model, moto_year, moto_color)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (user_id) DO UPDATE SET license_number_enc = EXCLUDED.license_number_enc,
             license_expires_on = EXCLUDED.license_expires_on, plate = EXCLUDED.plate, moto_brand = EXCLUDED.moto_brand,
             moto_model = EXCLUDED.moto_model, moto_year = EXCLUDED.moto_year, moto_color = EXCLUDED.moto_color`,
          [userId, encrypt(keys.data, input.licenseNumber, licenseAad(userId)), input.licenseExpiresOn, plate,
            input.motoBrand, input.motoModel, input.motoYear, input.motoColor],
        );
      } catch (err) {
        if (isUniqueViolation(err, 'drivers_plate_key')) throw conflict('PLATE_IN_USE', 'Esta placa ya está registrada por otro conductor');
        throw err;
      }
      await audit.log({ actorType: 'user', actorId: userId, action: 'driver.application_save', ip });
      return application(userId);
    },

    async uploadDocument(userId, kind, file, { ip }) {
      if (!REQUIRED_DOCUMENTS.includes(kind)) throw badRequest('DOCUMENT_KIND', 'Tipo de documento inválido');
      const d = await db.one('SELECT kyc_status FROM drivers WHERE user_id = $1', [userId]);
      if (!d) throw conflict('NO_APPLICATION', 'Primero registra los datos de tu moto y licencia');
      if (!EDITABLE.has(d.kyc_status)) throw conflict('APPLICATION_LOCKED', 'Tu solicitud ya está en revisión o aprobada');
      const img = await sanitizeImage(file?.buffer, { maxSide: 2000, quality: 85 });
      const key = await storage.put('kyc', img.buffer);
      let previous;
      try {
        previous = await db.one('SELECT storage_key FROM driver_documents WHERE driver_id = $1 AND kind = $2', [userId, kind]);
        await db.query(
          `INSERT INTO driver_documents (driver_id, kind, storage_key, source_sha256, bytes, width, height)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (driver_id, kind) DO UPDATE SET storage_key = EXCLUDED.storage_key, source_sha256 = EXCLUDED.source_sha256,
             bytes = EXCLUDED.bytes, width = EXCLUDED.width, height = EXCLUDED.height, created_at = now()`,
          [userId, kind, key, img.sourceSha256, img.bytes, img.width, img.height],
        );
      } catch (err) {
        await storage.remove(key);
        if (isUniqueViolation(err, 'driver_documents_source_uq')) {
          await audit.log({ actorType: 'user', actorId: userId, action: 'driver.duplicate_document_attempt', ip, details: { kind } });
          throw conflict('DOCUMENT_REUSED', 'Esta imagen ya fue usada en otro documento o cuenta');
        }
        throw err;
      }
      if (previous && previous.storage_key !== key) await storage.remove(previous.storage_key);
      return { kind, uploaded: true };
    },

    async submit(userId, { ip }) {
      const app = await application(userId);
      if (!app) throw conflict('NO_APPLICATION', 'Primero registra los datos de tu moto y licencia');
      if (!EDITABLE.has(app.status)) throw conflict('APPLICATION_LOCKED', 'Tu solicitud ya está en revisión o aprobada');
      const missing = app.documents.filter((d) => !d.uploaded).map((d) => d.kind);
      if (missing.length) throw badRequest('DOCUMENTS_MISSING', 'Faltan documentos', { missing });
      await db.query(
        `UPDATE drivers SET kyc_status = 'submitted', submitted_at = now(), kyc_note = NULL WHERE user_id = $1`,
        [userId],
      );
      await audit.log({ actorType: 'user', actorId: userId, action: 'driver.application_submit', ip });
      realtime.toAdmins('driver:submitted', { driverId: userId });
      return application(userId);
    },

    async setOnline(userId, online, { ip }) {
      if (!online) {
        await db.query('UPDATE drivers SET is_online = false WHERE user_id = $1', [userId]);
        return { online: false };
      }
      const walletCfg = await settings.get('wallet');
      const d = await db.one(
        `SELECT d.kyc_status, d.license_expires_on < (now() AT TIME ZONE 'America/Guayaquil')::date AS license_expired,
                w.balance_cents, u.status
           FROM drivers d JOIN users u ON u.id = d.user_id LEFT JOIN wallets w ON w.driver_id = d.user_id
          WHERE d.user_id = $1`,
        [userId],
      );
      if (!d || d.kyc_status !== 'approved' || d.status !== 'active') throw forbidden('Tu cuenta de conductor no está habilitada');
      if (d.license_expired) throw forbidden('Tu licencia está vencida. Actualízala con soporte.');
      if ((d.balance_cents ?? 0) < walletCfg.minBalanceCents) {
        throw forbidden(`Necesitas un saldo mínimo de $${(walletCfg.minBalanceCents / 100).toFixed(2)} para conectarte. Recarga tu billetera.`);
      }
      await db.query('UPDATE drivers SET is_online = true WHERE user_id = $1', [userId]);
      await audit.log({ actorType: 'user', actorId: userId, action: 'driver.online', ip });
      return { online: true };
    },

    // ---------- Panel ----------

    async listApplications(status = 'submitted') {
      const { rows } = await db.query(
        `SELECT d.user_id, d.kyc_status, d.plate, d.submitted_at, d.moto_brand, d.moto_model, u.full_name, u.phone
           FROM drivers d JOIN users u ON u.id = d.user_id
          WHERE d.kyc_status = $1 ORDER BY d.submitted_at ASC NULLS LAST LIMIT 100`,
        [status],
      );
      return rows.map((r) => ({
        driverId: r.user_id,
        status: r.kyc_status,
        fullName: r.full_name,
        phone: maskPhone(r.phone),
        plate: r.plate,
        moto: [r.moto_brand, r.moto_model].filter(Boolean).join(' '),
        submittedAt: r.submitted_at,
      }));
    },

    async applicationDetail(driverId, { adminId, ip }) {
      const d = await db.one(
        `SELECT d.*, u.full_name, u.phone, u.cedula_enc, u.created_at AS user_created_at
           FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = $1`,
        [driverId],
      );
      if (!d) throw notFound('Conductor no encontrado');
      // Ver datos personales completos queda registrado en la auditoría.
      await audit.log({ actorType: 'admin', actorId: adminId, action: 'driver.pii_view', targetType: 'driver', targetId: driverId, ip });
      const { rows: docs } = await db.query('SELECT kind FROM driver_documents WHERE driver_id = $1', [driverId]);
      return {
        driverId,
        status: d.kyc_status,
        note: d.kyc_note,
        fullName: d.full_name,
        phone: d.phone,
        cedula: d.cedula_enc ? decryptString(keys.data, d.cedula_enc, `users.cedula:${driverId}`) : null,
        licenseNumber: d.license_number_enc ? decryptString(keys.data, d.license_number_enc, licenseAad(driverId)) : null,
        licenseExpiresOn: d.license_expires_on,
        plate: d.plate,
        moto: { brand: d.moto_brand, model: d.moto_model, year: d.moto_year, color: d.moto_color },
        gpsAnomalies: d.gps_anomalies,
        submittedAt: d.submitted_at,
        documents: docs.map((x) => ({ kind: x.kind, url: `/api/admin/drivers/${driverId}/documents/${x.kind}` })),
      };
    },

    async documentImage(driverId, kind) {
      if (!REQUIRED_DOCUMENTS.includes(kind)) throw notFound();
      const doc = await db.one('SELECT storage_key FROM driver_documents WHERE driver_id = $1 AND kind = $2', [driverId, kind]);
      if (!doc) throw notFound('Documento no encontrado');
      return storage.get(doc.storage_key);
    },

    async review(driverId, decision, { adminId, note, ip }) {
      const transitions = {
        approve: { from: ['submitted', 'suspended'], to: 'approved' },
        reject: { from: ['submitted'], to: 'rejected' },
        suspend: { from: ['approved', 'submitted'], to: 'suspended' },
      };
      const t = transitions[decision];
      if (!t) throw badRequest('DECISION_INVALID', 'Decisión inválida');
      if (decision !== 'approve' && !note) throw badRequest('NOTE_REQUIRED', 'Indica el motivo');
      const updated = await db.tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE drivers SET kyc_status = $2, kyc_note = $3, reviewed_by = $4, reviewed_at = now(),
                  is_online = CASE WHEN $2 = 'approved' THEN is_online ELSE false END
            WHERE user_id = $1 AND kyc_status = ANY($5::text[]) RETURNING user_id`,
          [driverId, t.to, note ?? null, adminId, t.from],
        );
        if (!rows[0]) return false;
        if (t.to === 'approved') {
          await c.query('INSERT INTO wallets (driver_id) VALUES ($1) ON CONFLICT DO NOTHING', [driverId]);
        }
        await audit.log({ actorType: 'admin', actorId: adminId, action: `driver.${decision}`, targetType: 'driver', targetId: driverId, ip, details: { note } }, c);
        return true;
      });
      if (!updated) throw conflict('INVALID_STATE', 'La solicitud no está en un estado válido para esta acción');
      if (decision === 'suspend') realtime.disconnectUser(driverId);
      realtime.toUser(driverId, 'driver:status', { status: t.to, note: note ?? null });
      return { driverId, status: t.to };
    },
  };
}
