import { sanitizeImage } from '../lib/images.js';
import { BANKS, normalizeReference } from '../lib/ecuador.js';
import { parseAmountToCents, parseCsv } from '../lib/csv.js';
import { HttpError, badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../lib/errors.js';

const RESUBMITTABLE = new Set(['ilegible', 'monto_incorrecto']);
const REJECT_REASONS = new Set(['duplicado', 'ilegible', 'monto_incorrecto', 'referencia_incorrecta', 'no_acreditado', 'fraude']);

// Condición SQL equivalente al predicado de los índices únicos antiduplicados.
const RESERVED = `channel = 'transfer' AND NOT (status = 'rejected' AND reject_reason = 'referencia_incorrecta')`;

function toDto(t) {
  return {
    id: t.id,
    channel: t.channel,
    bank: t.bank,
    reference: t.reference,
    amountCents: t.amount_cents,
    status: t.status,
    rejectReason: t.reject_reason,
    rejectNote: t.reject_note,
    canResubmit: t.status === 'rejected' && RESUBMITTABLE.has(t.reject_reason),
    createdAt: t.created_at,
    reviewedAt: t.reviewed_at,
  };
}

export function createTopupService({ db, storage, wallet, settings, audit, realtime, payphone, config, logger }) {
  async function requireApprovedDriver(driverId) {
    const d = await db.one('SELECT kyc_status FROM drivers WHERE user_id = $1', [driverId]);
    if (!d || d.kyc_status !== 'approved') throw forbidden('Tu cuenta de conductor aún no está aprobada');
  }

  async function validateAmount(amountCents) {
    const cfg = await settings.get('wallet');
    if (!Number.isInteger(amountCents) || amountCents < cfg.topupMinCents || amountCents > cfg.topupMaxCents) {
      throw badRequest('AMOUNT_INVALID', `El monto debe estar entre $${(cfg.topupMinCents / 100).toFixed(2)} y $${(cfg.topupMaxCents / 100).toFixed(2)}`);
    }
    return cfg;
  }

  async function referenceInUse(referenceNorm) {
    return Boolean(await db.one(`SELECT 1 FROM topups WHERE reference_norm = $1 AND ${RESERVED}`, [referenceNorm]));
  }

  async function storeReceipt(file) {
    const img = await sanitizeImage(file?.buffer);
    if (await db.one(`SELECT 1 FROM topups WHERE receipt_sha256 = $1 AND ${RESERVED}`, [img.sourceSha256])) {
      throw conflict('RECEIPT_ALREADY_USED', 'Esta imagen de comprobante ya fue registrada');
    }
    return { ...img, key: await storage.put('receipts', img.buffer) };
  }

  function mapUniqueError(err) {
    if (isUniqueViolation(err, 'topups_reference_uq')) {
      return conflict('REFERENCE_ALREADY_USED', 'Este número de comprobante ya fue registrado');
    }
    if (isUniqueViolation(err, 'topups_receipt_uq')) {
      return conflict('RECEIPT_ALREADY_USED', 'Esta imagen de comprobante ya fue registrada');
    }
    return err;
  }

  async function markBankConfirmed(client, topupId) {
    await client.query(
      `UPDATE topups t SET bank_confirmed_at = now()
         FROM bank_statement_lines b
        WHERE t.id = $1 AND b.reference_norm = t.reference_norm AND b.amount_cents = t.amount_cents
          AND t.bank_confirmed_at IS NULL`,
      [topupId],
    );
  }

  async function credit(topup, { adminId = null, ip = null, actorType = 'admin', gatewayTxId = null, gatewayPayload = null }) {
    const balance = await db.tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM topups WHERE id = $1 FOR UPDATE', [topup.id]);
      const t = rows[0];
      if (!t || t.status !== 'pending') return null;
      await c.query(
        `UPDATE topups SET status = 'approved', reviewed_by = $2, reviewed_at = now(),
                gateway_tx_id = COALESCE($3, gateway_tx_id), gateway_payload = COALESCE($4, gateway_payload)
          WHERE id = $1`,
        [t.id, adminId, gatewayTxId, gatewayPayload ? JSON.stringify(gatewayPayload) : null],
      );
      const newBalance = await wallet.post(c, {
        driverId: t.driver_id,
        amountCents: t.amount_cents,
        kind: 'topup',
        refType: 'topup',
        refId: t.id,
        adminId,
      });
      await audit.log({ actorType, actorId: adminId, action: 'topup.approve', targetType: 'topup', targetId: t.id, ip, details: { amountCents: t.amount_cents, channel: t.channel } }, c);
      return newBalance;
    });
    if (balance === null) throw conflict('TOPUP_NOT_PENDING', 'Esta recarga ya fue procesada');
    realtime.toUser(topup.driver_id, 'wallet:update', { balanceCents: balance, topupId: topup.id, status: 'approved' });
    return balance;
  }

  return {
    async checkReference(reference) {
      const norm = normalizeReference(reference);
      if (!norm) throw badRequest('REFERENCE_INVALID', 'Número de referencia inválido');
      return { available: !(await referenceInUse(norm)) };
    },

    /** PASO 1: recarga por transferencia con campos clave obligatorios y filtro antiduplicados. */
    async createTransferTopup({ driverId, bank, reference, amountCents, file, ip }) {
      await requireApprovedDriver(driverId);
      if (!Object.hasOwn(BANKS, bank)) throw badRequest('BANK_INVALID', 'Selecciona el banco o billetera de origen');
      const referenceNorm = normalizeReference(reference);
      if (!referenceNorm) {
        throw badRequest('REFERENCE_INVALID', 'Escribe el número de referencia/secuencial del comprobante (4 a 40 letras o números)');
      }
      const cfg = await validateAmount(amountCents);
      if (!file) throw badRequest('IMAGE_REQUIRED', 'Adjunta la foto o captura del comprobante');

      const pending = await db.one(
        `SELECT count(*)::int AS n FROM topups WHERE driver_id = $1 AND status = 'pending' AND channel = 'transfer'`,
        [driverId],
      );
      if (pending.n >= cfg.maxPendingTopups) {
        throw conflict('TOO_MANY_PENDING', 'Tienes recargas pendientes de revisión. Espera a que sean procesadas.');
      }
      if (await referenceInUse(referenceNorm)) {
        await audit.log({ actorType: 'user', actorId: driverId, action: 'topup.duplicate_reference_attempt', targetType: 'reference', targetId: referenceNorm, ip });
        throw conflict('REFERENCE_ALREADY_USED', 'Este número de comprobante ya fue registrado');
      }

      const receipt = await storeReceipt(file);
      let topup;
      try {
        topup = await db.tx(async (c) => {
          const { rows } = await c.query(
            `INSERT INTO topups (driver_id, channel, bank, reference, reference_norm, amount_cents, receipt_key, receipt_sha256)
             VALUES ($1, 'transfer', $2, $3, $4, $5, $6, $7) RETURNING *`,
            [driverId, bank, String(reference).trim().slice(0, 60), referenceNorm, amountCents, receipt.key, receipt.sourceSha256],
          );
          await markBankConfirmed(c, rows[0].id);
          await audit.log({ actorType: 'user', actorId: driverId, action: 'topup.create', targetType: 'topup', targetId: rows[0].id, ip, details: { bank, amountCents } }, c);
          return rows[0];
        });
      } catch (err) {
        await storage.remove(receipt.key);
        throw mapUniqueError(err);
      }
      realtime.toAdmins('topup:new', { id: topup.id });
      return toDto(topup);
    },

    /** Reenvío de una recarga rechazada por foto ilegible o monto mal digitado. */
    async resubmit({ driverId, topupId, amountCents, file, ip }) {
      const cfg = await settings.get('wallet');
      const current = await db.one('SELECT * FROM topups WHERE id = $1 AND driver_id = $2', [topupId, driverId]);
      if (!current) throw notFound('Recarga no encontrada');
      if (current.status !== 'rejected' || !RESUBMITTABLE.has(current.reject_reason)) {
        throw conflict('NOT_RESUBMITTABLE', 'Esta recarga no puede reenviarse');
      }
      if (current.resubmissions >= cfg.maxResubmissions) throw conflict('RESUBMIT_LIMIT', 'Alcanzaste el límite de reenvíos');
      if (current.reject_reason === 'ilegible' && !file) throw badRequest('IMAGE_REQUIRED', 'Adjunta una foto legible del comprobante');
      const newAmount = amountCents ?? current.amount_cents;
      await validateAmount(newAmount);
      const receipt = file ? await storeReceipt(file) : null;
      try {
        const updated = await db.tx(async (c) => {
          const { rows } = await c.query(
            `UPDATE topups SET status = 'pending', reject_reason = NULL, reject_note = NULL, reviewed_by = NULL,
                    reviewed_at = NULL, resubmissions = resubmissions + 1, amount_cents = $3, bank_confirmed_at = NULL,
                    receipt_key = COALESCE($4, receipt_key), receipt_sha256 = COALESCE($5, receipt_sha256)
              WHERE id = $1 AND driver_id = $2 AND status = 'rejected' RETURNING *`,
            [topupId, driverId, newAmount, receipt?.key ?? null, receipt?.sourceSha256 ?? null],
          );
          if (!rows[0]) throw conflict('NOT_RESUBMITTABLE', 'Esta recarga no puede reenviarse');
          await markBankConfirmed(c, topupId);
          await audit.log({ actorType: 'user', actorId: driverId, action: 'topup.resubmit', targetType: 'topup', targetId: topupId, ip }, c);
          return rows[0];
        });
        if (receipt) await storage.remove(current.receipt_key);
        realtime.toAdmins('topup:new', { id: topupId });
        return toDto(updated);
      } catch (err) {
        if (receipt) await storage.remove(receipt.key);
        throw mapUniqueError(err);
      }
    },

    async listForDriver(driverId) {
      const { rows } = await db.query(
        'SELECT * FROM topups WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 50',
        [driverId],
      );
      return rows.map(toDto);
    },

    /** PASO 2: cola del panel de aprobación rápida (los más antiguos primero). */
    async adminQueue({ limit = 50 } = {}) {
      const { rows } = await db.query(
        `SELECT t.id, t.driver_id, t.bank, t.reference, t.reference_norm, t.amount_cents, t.resubmissions,
                t.bank_confirmed_at, t.created_at, u.full_name, u.phone, d.plate,
                (SELECT count(*)::int FROM topups x WHERE x.driver_id = t.driver_id AND x.status = 'approved') AS approved_count,
                (SELECT count(*)::int FROM topups x WHERE x.driver_id = t.driver_id AND x.status = 'rejected') AS rejected_count,
                EXISTS (SELECT 1 FROM bank_statement_lines b
                         WHERE b.reference_norm = t.reference_norm AND b.amount_cents <> t.amount_cents) AS bank_amount_mismatch
           FROM topups t JOIN drivers d ON d.user_id = t.driver_id JOIN users u ON u.id = t.driver_id
          WHERE t.status = 'pending' AND t.channel = 'transfer'
          ORDER BY t.created_at ASC LIMIT $1`,
        [limit],
      );
      const total = await db.one(`SELECT count(*)::int AS n FROM topups WHERE status = 'pending' AND channel = 'transfer'`);
      return {
        total: total.n,
        items: rows.map((r) => ({
          id: r.id,
          driver: { id: r.driver_id, fullName: r.full_name, phone: r.phone, plate: r.plate },
          bank: r.bank,
          bankName: BANKS[r.bank],
          reference: r.reference,
          referenceNorm: r.reference_norm,
          amountCents: r.amount_cents,
          resubmissions: r.resubmissions,
          bankConfirmed: Boolean(r.bank_confirmed_at),
          bankAmountMismatch: r.bank_amount_mismatch,
          history: { approved: r.approved_count, rejected: r.rejected_count },
          createdAt: r.created_at,
          receiptUrl: `/api/admin/topups/${r.id}/receipt`,
        })),
      };
    },

    async receiptImage(topupId) {
      const t = await db.one('SELECT receipt_key FROM topups WHERE id = $1', [topupId]);
      if (!t?.receipt_key) throw notFound('Comprobante no encontrado');
      return storage.get(t.receipt_key);
    },

    async approve({ topupId, adminId, ip }) {
      const t = await db.one(`SELECT * FROM topups WHERE id = $1 AND channel = 'transfer'`, [topupId]);
      if (!t) throw notFound('Recarga no encontrada');
      const balanceCents = await credit(t, { adminId, ip });
      return { id: t.id, status: 'approved', balanceCents };
    },

    async reject({ topupId, adminId, reason, note, ip }) {
      if (!REJECT_REASONS.has(reason)) throw badRequest('REASON_INVALID', 'Motivo de rechazo inválido');
      const t = await db.tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE topups SET status = 'rejected', reject_reason = $2, reject_note = $3, reviewed_by = $4, reviewed_at = now()
            WHERE id = $1 AND status = 'pending' AND channel = 'transfer' RETURNING *`,
          [topupId, reason, note ?? null, adminId],
        );
        if (!rows[0]) return null;
        await audit.log({ actorType: 'admin', actorId: adminId, action: 'topup.reject', targetType: 'topup', targetId: topupId, ip, details: { reason } }, c);
        if (reason === 'fraude') {
          // Intento de fraude confirmado: se suspende al conductor de inmediato.
          await c.query(`UPDATE drivers SET kyc_status = 'suspended', is_online = false, kyc_note = 'Fraude en recarga' WHERE user_id = $1`, [rows[0].driver_id]);
          await audit.log({ actorType: 'admin', actorId: adminId, action: 'driver.suspend', targetType: 'driver', targetId: rows[0].driver_id, ip, details: { cause: 'topup_fraud', topupId } }, c);
        }
        return rows[0];
      });
      if (!t) throw conflict('TOPUP_NOT_PENDING', 'Esta recarga ya fue procesada');
      if (reason === 'fraude') realtime.disconnectUser(t.driver_id);
      realtime.toUser(t.driver_id, 'topup:update', toDto(t));
      return toDto(t);
    },

    /** Conciliación: importa el estado de cuenta (CSV) y marca las recargas que coinciden. */
    async importBankStatement({ csv, referenceColumn, amountColumn, dateColumn, adminId, ip }) {
      let rows;
      try {
        rows = parseCsv(csv);
      } catch (err) {
        throw badRequest('CSV_INVALID', err.message);
      }
      if (rows.length < 2) throw badRequest('CSV_EMPTY', 'El archivo no tiene movimientos');
      const header = rows[0].map((h) => h.toLowerCase());
      const find = (explicit, pattern) => {
        if (explicit) return header.indexOf(String(explicit).toLowerCase());
        return header.findIndex((h) => pattern.test(h));
      };
      const refIdx = find(referenceColumn, /referencia|documento|comprobante|secuencial|transacci|n[uú]mero/);
      const amtIdx = find(amountColumn, /cr[eé]dito|monto|valor|importe/);
      const dateIdx = find(dateColumn, /fecha/);
      if (refIdx < 0 || amtIdx < 0) {
        throw new HttpError(400, 'CSV_COLUMNS', 'No se detectaron las columnas de referencia y monto', { headers: rows[0] });
      }
      const lines = [];
      for (const r of rows.slice(1)) {
        const ref = normalizeReference(r[refIdx]);
        const cents = parseAmountToCents(r[amtIdx]);
        if (!ref || !cents) continue;
        const dateText = dateIdx >= 0 ? r[dateIdx] : null;
        const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateText ?? '') ?? /^(\d{2})\/(\d{2})\/(\d{4})/.exec(dateText ?? '');
        const postedOn = iso ? (iso[1].length === 4 ? `${iso[1]}-${iso[2]}-${iso[3]}` : `${iso[3]}-${iso[2]}-${iso[1]}`) : null;
        lines.push({ ref, cents, postedOn, description: r.join(' | ').slice(0, 300) });
      }
      if (!lines.length) throw badRequest('CSV_NO_CREDITS', 'No se encontraron créditos válidos');

      return db.tx(async (c) => {
        let imported = 0;
        for (const l of lines) {
          const { rowCount } = await c.query(
            `INSERT INTO bank_statement_lines (reference_norm, amount_cents, posted_on, description, imported_by)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (reference_norm, amount_cents) DO NOTHING`,
            [l.ref, l.cents, l.postedOn, l.description, adminId],
          );
          imported += rowCount;
        }
        const { rowCount: matched } = await c.query(
          `UPDATE topups t SET bank_confirmed_at = now()
             FROM bank_statement_lines b
            WHERE b.reference_norm = t.reference_norm AND b.amount_cents = t.amount_cents
              AND t.channel = 'transfer' AND t.bank_confirmed_at IS NULL AND t.status IN ('pending', 'approved')`,
        );
        await audit.log({ actorType: 'admin', actorId: adminId, action: 'bank_statement.import', ip, details: { lines: lines.length, imported, matched } }, c);
        return { lines: lines.length, imported, duplicates: lines.length - imported, matchedTopups: matched };
      });
    },

    /** PASO 3: recarga automática con link de pago Payphone. */
    async createGatewayTopup({ driverId, amountCents, ip }) {
      if (!payphone.enabled) throw new HttpError(503, 'PAYMENTS_DISABLED', 'El pago con tarjeta no está disponible por ahora');
      await requireApprovedDriver(driverId);
      await validateAmount(amountCents);
      const t = await db.one(
        `INSERT INTO topups (driver_id, channel, amount_cents) VALUES ($1, 'payphone', $2) RETURNING id`,
        [driverId, amountCents],
      );
      try {
        const link = await payphone.prepare({
          amountCents,
          clientTransactionId: t.id,
          reference: `Recarga UberMarT ${t.id.slice(0, 8)}`,
          responseUrl: `${config.publicBaseUrl}/api/payments/payphone/return`,
          cancellationUrl: `${config.publicBaseUrl}/api/payments/payphone/return?cancelled=1&clientTransactionId=${t.id}`,
        });
        await db.query('UPDATE topups SET gateway_payload = $2 WHERE id = $1', [t.id, JSON.stringify({ paymentId: link.paymentId })]);
        await audit.log({ actorType: 'user', actorId: driverId, action: 'topup.gateway_create', targetType: 'topup', targetId: t.id, ip, details: { amountCents } });
        return { topupId: t.id, payWithCardUrl: link.payWithCard, payWithPayphoneUrl: link.payWithPayPhone };
      } catch (err) {
        await db.query(`UPDATE topups SET status = 'cancelled' WHERE id = $1`, [t.id]);
        throw err;
      }
    },

    /**
     * Confirma un pago de Payphone. NUNCA se confía en los datos que llegan por
     * la redirección o el webhook: se consulta a Payphone servidor-a-servidor y
     * se verifica estado, id de transacción del cliente y monto exacto.
     */
    async confirmGatewayPayment({ transactionId, clientTransactionId, source }) {
      if (!/^[0-9]{1,20}$/.test(String(transactionId)) || !/^[0-9a-f-]{36}$/.test(String(clientTransactionId))) {
        throw badRequest('PAYMENT_PARAMS', 'Parámetros de pago inválidos');
      }
      const topup = await db.one(`SELECT * FROM topups WHERE id = $1 AND channel = 'payphone'`, [clientTransactionId]);
      if (!topup) throw notFound('Pago no encontrado');
      if (topup.status === 'approved') return { status: 'approved', amountCents: topup.amount_cents };
      if (topup.status !== 'pending') return { status: topup.status, amountCents: topup.amount_cents };

      const result = await payphone.confirm({ id: transactionId, clientTxId: clientTransactionId });
      await db.query(
        `INSERT INTO gateway_events (provider, event_key, payload, result) VALUES ('payphone', $1, $2, $3)
         ON CONFLICT (provider, event_key) DO NOTHING`,
        [`${source}:${transactionId}`, JSON.stringify(result), String(result.transactionStatus ?? result.statusCode)],
      );
      const approved =
        Number(result.statusCode) === 3 &&
        result.transactionStatus === 'Approved' &&
        String(result.clientTransactionId) === topup.id &&
        Number(result.amount) === topup.amount_cents;

      if (approved) {
        try {
          await credit(topup, {
            actorType: 'gateway',
            gatewayTxId: `payphone:${result.transactionId}`,
            gatewayPayload: {
              transactionId: result.transactionId,
              authorizationCode: result.authorizationCode,
              cardBrand: result.cardBrand,
              lastDigits: result.lastDigits,
              date: result.date,
            },
          });
        } catch (err) {
          if (err.code !== 'TOPUP_NOT_PENDING') throw err;
        }
        return { status: 'approved', amountCents: topup.amount_cents };
      }
      if (Number(result.statusCode) === 3) {
        // Aprobado por Payphone pero no coincide con nuestra orden: alerta de seguridad.
        logger.error({ topupId: topup.id }, 'Pago Payphone aprobado con datos que no coinciden');
        await audit.log({ actorType: 'gateway', action: 'payment.mismatch', targetType: 'topup', targetId: topup.id, details: { amount: result.amount, clientTransactionId: result.clientTransactionId } });
        realtime.toAdmins('payment:mismatch', { topupId: topup.id });
        return { status: 'review' };
      }
      await db.query(`UPDATE topups SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`, [topup.id]);
      return { status: 'cancelled' };
    },

    async cancelGatewayTopup(clientTransactionId) {
      if (!/^[0-9a-f-]{36}$/.test(String(clientTransactionId))) return;
      await db.query(
        `UPDATE topups SET status = 'cancelled' WHERE id = $1 AND channel = 'payphone' AND status = 'pending'`,
        [clientTransactionId],
      );
    },
  };
}
