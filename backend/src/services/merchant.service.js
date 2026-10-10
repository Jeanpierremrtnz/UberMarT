import { randomUUID } from 'node:crypto';
import { decryptString, encrypt } from '../lib/crypto.js';
import { sanitizeImage } from '../lib/images.js';
import { isValidCedula, isValidRuc } from '../lib/ecuador.js';
import { HttpError, badRequest, conflict, forbidden, isUniqueViolation, notFound, unprocessable } from '../lib/errors.js';
import { validateAdminPassword } from './admin-auth.service.js';

// Registro autogestionado de restaurantes y locales:
//   1. el dueño verifica su celular por SMS y crea su cuenta (contraseña + autenticador),
//   2. completa datos, documentos y productos desde el panel /comercio,
//   3. envía a revisión; el panel interno aprueba y recién ahí aparece en la app.

export const MERCHANT_DOCUMENTS = Object.freeze(['ruc', 'permiso_funcionamiento', 'cedula_owner', 'storefront']);
const EDITABLE = new Set(['draft', 'rejected']);
const MAX_MENU_ITEMS = 300;
const POINT = (latParam, lngParam) => `ST_SetSRID(ST_MakePoint(${lngParam}, ${latParam}), 4326)::geography`;

function itemDto(i, merchantId, { publicUrl = false } = {}) {
  const version = new Date(i.updated_at).getTime();
  return {
    id: i.id,
    category: i.category,
    name: i.name,
    description: i.description,
    priceCents: i.price_cents,
    isAvailable: i.is_available,
    sortOrder: i.sort_order,
    photoUrl: i.photo_key
      ? publicUrl
        ? `/api/merchants/${merchantId}/items/${i.id}/photo?v=${version}`
        : `/api/merchant/menu/${i.id}/photo?v=${version}`
      : null,
  };
}

export function createMerchantService({ db, keys, storage, audit, realtime, auth, adminAuth, pricing, settings }) {
  const cedulaAad = (merchantId) => `merchants.owner_cedula:${merchantId}`;

  async function loadMerchant(merchantId) {
    const m = await db.one(
      `SELECT m.*, ST_Y(m.location::geometry) AS lat, ST_X(m.location::geometry) AS lng FROM merchants m WHERE m.id = $1`,
      [merchantId],
    );
    if (!m) throw notFound('Local no encontrado');
    return m;
  }

  async function assertInServiceArea(lat, lng) {
    if (!(await pricing.zoneAt({ lat, lng }))) {
      throw unprocessable('OUT_OF_SERVICE_AREA', 'La ubicación del local está fuera del área de servicio');
    }
  }

  return {
    // ---------------- Registro ----------------
    async register({ challengeId, code, business, owner, ip }) {
      if (!isValidRuc(business.ruc)) throw badRequest('RUC_INVALID', 'El RUC no es válido');
      if (!isValidCedula(owner.cedula)) throw badRequest('CEDULA_INVALID', 'La cédula del dueño no es válida');
      validateAdminPassword(owner.password);
      await assertInServiceArea(business.lat, business.lng);
      if (await db.one('SELECT 1 FROM merchants WHERE ruc = $1', [business.ruc])) {
        throw conflict('RUC_IN_USE', 'Ya existe un local registrado con este RUC');
      }
      if (await db.one('SELECT 1 FROM admins WHERE email = $1', [owner.email])) {
        throw conflict('EMAIL_IN_USE', 'Este correo ya tiene una cuenta');
      }
      const phone = await auth.checkOtp({ challengeId, code, purpose: 'merchant_signup' });
      const merchantId = randomUUID();
      let creds;
      try {
        creds = await db.tx(async (c) => {
          const { rowCount } = await c.query(
            `UPDATE otp_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()`,
            [challengeId],
          );
          if (!rowCount) throw new HttpError(401, 'OTP_INVALID', 'Código incorrecto o vencido');
          await c.query(
            `INSERT INTO merchants (id, name, category, phone, address_label, location, ruc, owner_name, owner_cedula_enc, schedule_text)
             VALUES ($1, $2, $3, $4, $5, ${POINT('$6', '$7')}, $8, $9, $10, $11)`,
            [merchantId, business.name, business.category, phone, business.addressLabel, business.lat, business.lng, business.ruc,
              owner.fullName, encrypt(keys.data, owner.cedula, cedulaAad(merchantId)), business.scheduleText ?? null],
          );
          const out = await adminAuth.createAdmin(
            { email: owner.email, fullName: owner.fullName, password: owner.password, role: 'merchant', merchantId },
            c,
          );
          await audit.log({ actorType: 'user', action: 'merchant.register', targetType: 'merchant', targetId: merchantId, ip, details: { ruc: business.ruc } }, c);
          return out;
        });
      } catch (err) {
        if (isUniqueViolation(err, 'merchants_ruc_key')) throw conflict('RUC_IN_USE', 'Ya existe un local registrado con este RUC');
        if (isUniqueViolation(err, 'admins_email_key')) throw conflict('EMAIL_IN_USE', 'Este correo ya tiene una cuenta');
        throw err;
      }
      realtime.toAdmins('merchant:registered', { merchantId });
      return { merchantId, totpSecret: creds.totpSecret, totpUri: creds.totpUri };
    },

    // ---------------- Panel del local ----------------
    async profile(merchantId) {
      const m = await loadMerchant(merchantId);
      const { rows: docs } = await db.query('SELECT kind FROM merchant_documents WHERE merchant_id = $1', [merchantId]);
      const uploaded = new Set(docs.map((d) => d.kind));
      const counts = await db.one(
        `SELECT count(*)::int AS items, count(*) FILTER (WHERE is_available)::int AS available FROM menu_items WHERE merchant_id = $1`,
        [merchantId],
      );
      return {
        id: m.id,
        name: m.name,
        category: m.category,
        phone: m.phone,
        addressLabel: m.address_label,
        location: { lat: m.lat, lng: m.lng },
        ruc: m.ruc,
        ownerName: m.owner_name,
        scheduleText: m.schedule_text,
        prepMinutes: m.prep_minutes,
        status: m.status,
        reviewNote: m.review_note,
        isOpen: m.is_open,
        commissionPercent: m.commission_bps / 100,
        editable: EDITABLE.has(m.status),
        documents: MERCHANT_DOCUMENTS.map((kind) => ({ kind, uploaded: uploaded.has(kind) })),
        products: counts,
      };
    },

    async updateProfile(merchantId, input, { ip, actorId }) {
      const m = await loadMerchant(merchantId);
      const locked = ['name', 'category', 'addressLabel', 'lat', 'lng'].filter((k) => input[k] !== undefined);
      if (locked.length && !EDITABLE.has(m.status)) {
        throw conflict('PROFILE_LOCKED', 'Tu local ya fue verificado: para cambiar nombre, categoría o ubicación contacta a soporte');
      }
      if ((input.lat === undefined) !== (input.lng === undefined)) throw badRequest('LOCATION_INVALID', 'Ubicación incompleta');
      if (input.lat !== undefined) await assertInServiceArea(input.lat, input.lng);
      await db.query(
        `UPDATE merchants SET
           name = COALESCE($2, name), category = COALESCE($3, category), address_label = COALESCE($4, address_label),
           location = CASE WHEN $5::float8 IS NULL THEN location ELSE ${POINT('$5', '$6')} END,
           schedule_text = COALESCE($7, schedule_text), prep_minutes = COALESCE($8, prep_minutes)
         WHERE id = $1`,
        [merchantId, input.name ?? null, input.category ?? null, input.addressLabel ?? null, input.lat ?? null, input.lng ?? null,
          input.scheduleText ?? null, input.prepMinutes ?? null],
      );
      await audit.log({ actorType: 'admin', actorId, action: 'merchant.profile_update', targetType: 'merchant', targetId: merchantId, ip, details: { fields: Object.keys(input) } });
      return this.profile(merchantId);
    },

    async uploadDocument(merchantId, kind, file, { ip }) {
      if (!MERCHANT_DOCUMENTS.includes(kind)) throw badRequest('DOCUMENT_KIND', 'Tipo de documento inválido');
      const m = await loadMerchant(merchantId);
      if (!EDITABLE.has(m.status)) throw conflict('APPLICATION_LOCKED', 'Tu solicitud ya está en revisión o aprobada');
      const img = await sanitizeImage(file?.buffer, { maxSide: 2000, quality: 85 });
      const key = await storage.put('merchant_kyc', img.buffer);
      const previous = await db.one('SELECT storage_key FROM merchant_documents WHERE merchant_id = $1 AND kind = $2', [merchantId, kind]);
      try {
        await db.query(
          `INSERT INTO merchant_documents (merchant_id, kind, storage_key, source_sha256) VALUES ($1, $2, $3, $4)
           ON CONFLICT (merchant_id, kind) DO UPDATE SET storage_key = EXCLUDED.storage_key,
             source_sha256 = EXCLUDED.source_sha256, created_at = now()`,
          [merchantId, kind, key, img.sourceSha256],
        );
      } catch (err) {
        await storage.remove(key);
        if (isUniqueViolation(err, 'merchant_documents_source_uq')) {
          await audit.log({ actorType: 'user', action: 'merchant.duplicate_document_attempt', targetType: 'merchant', targetId: merchantId, ip, details: { kind } });
          throw conflict('DOCUMENT_REUSED', 'Esta imagen ya fue usada en otro documento o registro');
        }
        throw err;
      }
      if (previous) await storage.remove(previous.storage_key);
      return { kind, uploaded: true };
    },

    async submit(merchantId, { ip }) {
      const p = await this.profile(merchantId);
      if (!p.editable) throw conflict('APPLICATION_LOCKED', 'Tu solicitud ya está en revisión o aprobada');
      const missing = p.documents.filter((d) => !d.uploaded).map((d) => d.kind);
      if (missing.length) throw badRequest('DOCUMENTS_MISSING', 'Faltan documentos', { missing });
      if (p.products.available < 1) throw badRequest('MENU_EMPTY', 'Agrega al menos un producto disponible');
      await db.query(`UPDATE merchants SET status = 'submitted', submitted_at = now(), review_note = NULL WHERE id = $1`, [merchantId]);
      await audit.log({ actorType: 'user', action: 'merchant.submit', targetType: 'merchant', targetId: merchantId, ip });
      realtime.toAdmins('merchant:submitted', { merchantId });
      return this.profile(merchantId);
    },

    async setOpen(merchantId, isOpen) {
      const { rowCount } = await db.query(
        `UPDATE merchants SET is_open = $2 WHERE id = $1 AND (status = 'approved' OR $2 = false)`,
        [merchantId, isOpen],
      );
      if (!rowCount) throw forbidden('Tu local aún no está aprobado');
      return { isOpen };
    },

    async listMenu(merchantId) {
      const { rows } = await db.query(
        'SELECT * FROM menu_items WHERE merchant_id = $1 ORDER BY category, sort_order, name',
        [merchantId],
      );
      return rows.map((i) => itemDto(i, merchantId));
    },

    async createItem(merchantId, input) {
      const count = await db.one('SELECT count(*)::int AS n FROM menu_items WHERE merchant_id = $1', [merchantId]);
      if (count.n >= MAX_MENU_ITEMS) throw conflict('MENU_LIMIT', `Máximo ${MAX_MENU_ITEMS} productos`);
      const i = await db.one(
        `INSERT INTO menu_items (merchant_id, category, name, description, price_cents, is_available, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [merchantId, input.category ?? 'General', input.name, input.description ?? null, input.priceCents, input.isAvailable ?? true, input.sortOrder ?? 0],
      );
      return itemDto(i, merchantId);
    },

    async updateItem(merchantId, itemId, input) {
      const i = await db.one(
        `UPDATE menu_items SET category = COALESCE($3, category), name = COALESCE($4, name), description = COALESCE($5, description),
                price_cents = COALESCE($6, price_cents), is_available = COALESCE($7, is_available), sort_order = COALESCE($8, sort_order)
          WHERE id = $2 AND merchant_id = $1 RETURNING *`,
        [merchantId, itemId, input.category ?? null, input.name ?? null, input.description ?? null, input.priceCents ?? null,
          input.isAvailable ?? null, input.sortOrder ?? null],
      );
      if (!i) throw notFound('Producto no encontrado');
      return itemDto(i, merchantId);
    },

    async deleteItem(merchantId, itemId) {
      const i = await db.one('DELETE FROM menu_items WHERE id = $2 AND merchant_id = $1 RETURNING photo_key', [merchantId, itemId]);
      if (!i) throw notFound('Producto no encontrado');
      if (i.photo_key) await storage.remove(i.photo_key);
    },

    async uploadItemPhoto(merchantId, itemId, file) {
      const current = await db.one('SELECT photo_key FROM menu_items WHERE id = $2 AND merchant_id = $1', [merchantId, itemId]);
      if (!current) throw notFound('Producto no encontrado');
      const img = await sanitizeImage(file?.buffer, { maxSide: 1000, quality: 80 });
      const key = await storage.put('menu_photos', img.buffer);
      const i = await db.one('UPDATE menu_items SET photo_key = $3 WHERE id = $2 AND merchant_id = $1 RETURNING *', [merchantId, itemId, key]);
      if (current.photo_key) await storage.remove(current.photo_key);
      return itemDto(i, merchantId);
    },

    async itemPhoto(merchantId, itemId, { publicOnly }) {
      const i = await db.one(
        `SELECT i.photo_key FROM menu_items i JOIN merchants m ON m.id = i.merchant_id
          WHERE i.id = $2 AND i.merchant_id = $1 AND ($3 = false OR m.status = 'approved')`,
        [merchantId, itemId, publicOnly],
      );
      if (!i?.photo_key) throw notFound('Foto no encontrada');
      return storage.get(i.photo_key);
    },

    async ledger(merchantId) {
      const total = await db.one('SELECT COALESCE(SUM(amount_cents), 0)::bigint AS owed FROM merchant_ledger WHERE merchant_id = $1', [merchantId]);
      const { rows } = await db.query(
        `SELECT id, amount_cents, kind, ref_type, ref_id, note, created_at FROM merchant_ledger
          WHERE merchant_id = $1 ORDER BY id DESC LIMIT 100`,
        [merchantId],
      );
      return {
        owedCents: total.owed,
        entries: rows.map((r) => ({ id: r.id, amountCents: r.amount_cents, kind: r.kind, refType: r.ref_type, refId: r.ref_id, note: r.note, createdAt: r.created_at })),
      };
    },

    // ---------------- Catálogo público (app del cliente) ----------------
    async nearby({ lat, lng }) {
      const food = (await settings.get('services')).food;
      const { rows } = await db.query(
        `SELECT id, name, category, schedule_text, prep_minutes, is_open, address_label,
                ST_Distance(location, ${POINT('$1', '$2')})::int AS distance_m
           FROM merchants
          WHERE status = 'approved' AND ST_DWithin(location, ${POINT('$1', '$2')}, $3)
          ORDER BY is_open DESC, distance_m ASC LIMIT 60`,
        [lat, lng, food.maxDistanceMeters],
      );
      return rows.map((m) => ({
        id: m.id, name: m.name, category: m.category, scheduleText: m.schedule_text, prepMinutes: m.prep_minutes,
        isOpen: m.is_open, addressLabel: m.address_label, distanceM: m.distance_m,
      }));
    },

    async publicMenu(merchantId) {
      const m = await db.one(
        `SELECT id, name, category, schedule_text, prep_minutes, is_open, address_label FROM merchants WHERE id = $1 AND status = 'approved'`,
        [merchantId],
      );
      if (!m) throw notFound('Local no encontrado');
      const { rows } = await db.query(
        `SELECT * FROM menu_items WHERE merchant_id = $1 AND is_available ORDER BY category, sort_order, name`,
        [merchantId],
      );
      return {
        id: m.id, name: m.name, category: m.category, scheduleText: m.schedule_text, prepMinutes: m.prep_minutes,
        isOpen: m.is_open, addressLabel: m.address_label, items: rows.map((i) => itemDto(i, merchantId, { publicUrl: true })),
      };
    },

    // ---------------- Panel interno ----------------
    async adminList(status) {
      const { rows } = await db.query(
        `SELECT m.id, m.name, m.category, m.ruc, m.status, m.is_open, m.submitted_at, m.created_at, m.commission_bps,
                COALESCE((SELECT SUM(amount_cents) FROM merchant_ledger l WHERE l.merchant_id = m.id), 0)::bigint AS owed
           FROM merchants m WHERE ($1 = 'all' OR m.status = $1)
          ORDER BY m.submitted_at ASC NULLS LAST, m.created_at DESC LIMIT 200`,
        [status],
      );
      return rows.map((m) => ({
        id: m.id, name: m.name, category: m.category, ruc: m.ruc, status: m.status, isOpen: m.is_open,
        submittedAt: m.submitted_at, commissionPercent: m.commission_bps / 100, owedCents: m.owed,
      }));
    },

    async adminDetail(merchantId, { adminId, ip }) {
      const m = await loadMerchant(merchantId);
      await audit.log({ actorType: 'admin', actorId: adminId, action: 'merchant.pii_view', targetType: 'merchant', targetId: merchantId, ip });
      const owner = await db.one(`SELECT email FROM admins WHERE merchant_id = $1 ORDER BY created_at LIMIT 1`, [merchantId]);
      const { rows: docs } = await db.query('SELECT kind FROM merchant_documents WHERE merchant_id = $1', [merchantId]);
      return {
        ...(await this.profile(merchantId)),
        ownerCedula: decryptString(keys.data, m.owner_cedula_enc, cedulaAad(merchantId)),
        ownerEmail: owner?.email ?? null,
        documents: docs.map((d) => ({ kind: d.kind, url: `/api/admin/merchants/${merchantId}/documents/${d.kind}` })),
        menu: await this.listMenu(merchantId),
        ledger: await this.ledger(merchantId),
      };
    },

    async adminDocument(merchantId, kind) {
      if (!MERCHANT_DOCUMENTS.includes(kind)) throw notFound();
      const d = await db.one('SELECT storage_key FROM merchant_documents WHERE merchant_id = $1 AND kind = $2', [merchantId, kind]);
      if (!d) throw notFound('Documento no encontrado');
      return storage.get(d.storage_key);
    },

    async review(merchantId, decision, { adminId, note, commissionBps, ip }) {
      const transitions = {
        approve: { from: ['submitted', 'suspended'], to: 'approved' },
        reject: { from: ['submitted'], to: 'rejected' },
        suspend: { from: ['approved', 'submitted'], to: 'suspended' },
      };
      const t = transitions[decision];
      if (!t) throw badRequest('DECISION_INVALID', 'Decisión inválida');
      if (decision !== 'approve' && !note) throw badRequest('NOTE_REQUIRED', 'Indica el motivo');
      const { rowCount } = await db.query(
        `UPDATE merchants SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(),
                commission_bps = COALESCE($6, commission_bps),
                is_open = CASE WHEN $2 = 'approved' THEN is_open ELSE false END
          WHERE id = $1 AND status = ANY($5::text[])`,
        [merchantId, t.to, note ?? null, adminId, t.from, commissionBps ?? null],
      );
      if (!rowCount) throw conflict('INVALID_STATE', 'El local no está en un estado válido para esta acción');
      await audit.log({ actorType: 'admin', actorId: adminId, action: `merchant.${decision}`, targetType: 'merchant', targetId: merchantId, ip, details: { note, commissionBps } });
      realtime.toMerchant(merchantId, 'merchant:status', { status: t.to, note: note ?? null });
      return { merchantId, status: t.to };
    },

    /** Pago recibido del local (reduce lo que debe por comisiones). */
    async recordPayment(merchantId, { amountCents, note, adminId, ip }) {
      await loadMerchant(merchantId);
      const ref = randomUUID();
      await db.query(
        `INSERT INTO merchant_ledger (merchant_id, amount_cents, kind, ref_type, ref_id, note, admin_id)
         VALUES ($1, $2, 'payment', 'payment', $3, $4, $5)`,
        [merchantId, -amountCents, ref, note ?? null, adminId],
      );
      await audit.log({ actorType: 'admin', actorId: adminId, action: 'merchant.payment', targetType: 'merchant', targetId: merchantId, ip, details: { amountCents } });
      return this.ledger(merchantId);
    },
  };
}
