import { Router } from 'express';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { SETTINGS_SCHEMAS } from '../services/settings.service.js';
import { S, uuid } from './schemas.js';
import { ADMIN_COOKIE_DEV, ADMIN_COOKIE_SECURE, limiter, requireAdmin } from './middleware.js';

/** API del panel administrativo interno. */
export function adminRoutes({ services, config, db, realtime }) {
  const r = Router();
  const cookieName = config.cookieSecure ? ADMIN_COOKIE_SECURE : ADMIN_COOKIE_DEV;
  const can = (permission) => requireAdmin(services.adminAuth, cookieName, permission);
  const id = (req) => uuid.parse(req.params.id);
  const sendImage = (res, buffer) => {
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' });
    res.send(buffer);
  };

  // ---------- Sesión ----------
  r.post('/auth/login', limiter({ windowMs: 15 * 60_000, limit: 10, scale: config.rateLimitScale }), async (req, res) => {
    const body = S.adminLogin.parse(req.body);
    const out = await services.adminAuth.login({ ...body, ip: req.ip, userAgent: req.get('user-agent') });
    res.cookie(cookieName, out.token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      maxAge: out.maxAgeSec * 1000,
    });
    res.json({ csrfToken: out.csrfToken, admin: out.admin });
  });
  r.post('/auth/logout', can(), async (req, res) => {
    await services.adminAuth.logout(req.adminToken);
    res.clearCookie(cookieName, { path: '/', secure: config.cookieSecure, httpOnly: true, sameSite: 'strict' });
    res.status(204).end();
  });
  r.get('/auth/me', can(), (req, res) => {
    const { id: adminId, email, fullName, role, csrfToken } = req.admin;
    res.json({ admin: { id: adminId, email, fullName, role }, csrfToken });
  });

  // ---------- Eventos en vivo (SOS, nuevas recargas) vía Server-Sent Events ----------
  r.get('/events', can(), (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const off = realtime.onAdminEvent(({ event, data }) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      off();
    });
  });

  // ---------- Recargas (aprobación rápida) ----------
  r.get('/topups/queue', can('topups.review'), async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    res.json(await services.topups.adminQueue({ limit }));
  });
  r.get('/topups/:id/receipt', can('topups.review'), async (req, res) => sendImage(res, await services.topups.receiptImage(id(req))));
  r.post('/topups/:id/approve', can('topups.review'), async (req, res) => {
    res.json(await services.topups.approve({ topupId: id(req), adminId: req.admin.id, ip: req.ip }));
  });
  r.post('/topups/:id/reject', can('topups.review'), async (req, res) => {
    const body = S.topupReject.parse(req.body);
    res.json(await services.topups.reject({ topupId: id(req), adminId: req.admin.id, ...body, ip: req.ip }));
  });
  r.post('/bank-statements', can('bank.import'), async (req, res) => {
    const body = S.bankStatement.parse(req.body);
    res.json(await services.topups.importBankStatement({ ...body, adminId: req.admin.id, ip: req.ip }));
  });
  r.get('/wallets/integrity', can('wallet.read'), async (_req, res) => res.json(await services.wallet.integrityReport()));

  // ---------- Conductores (KYC) ----------
  r.get('/drivers', can('drivers.review'), async (req, res) => {
    const status = String(req.query.status ?? 'submitted');
    if (!['draft', 'submitted', 'approved', 'rejected', 'suspended'].includes(status)) throw badRequest('STATUS_INVALID', 'Estado inválido');
    res.json(await services.drivers.listApplications(status));
  });
  r.get('/drivers/:id', can('drivers.review'), async (req, res) => {
    res.json(await services.drivers.applicationDetail(id(req), { adminId: req.admin.id, ip: req.ip }));
  });
  r.get('/drivers/:id/documents/:kind', can('drivers.review'), async (req, res) => {
    sendImage(res, await services.drivers.documentImage(id(req), String(req.params.kind)));
  });
  for (const decision of ['approve', 'reject', 'suspend']) {
    r.post(`/drivers/:id/${decision}`, can('drivers.review'), async (req, res) => {
      const { note } = S.reviewNote.parse(req.body ?? {});
      res.json(await services.drivers.review(id(req), decision, { adminId: req.admin.id, note, ip: req.ip }));
    });
  }

  // ---------- Locales (restaurantes y comercios) ----------
  r.get('/merchants', can('merchants.read'), async (req, res) => {
    const status = String(req.query.status ?? 'submitted');
    if (!['all', 'draft', 'submitted', 'approved', 'rejected', 'suspended'].includes(status)) throw badRequest('STATUS_INVALID', 'Estado inválido');
    res.json(await services.merchants.adminList(status));
  });
  r.get('/merchants/:id', can('merchants.review'), async (req, res) => {
    res.json(await services.merchants.adminDetail(id(req), { adminId: req.admin.id, ip: req.ip }));
  });
  r.get('/merchants/:id/documents/:kind', can('merchants.review'), async (req, res) => {
    sendImage(res, await services.merchants.adminDocument(id(req), String(req.params.kind)));
  });
  r.get('/merchants/:id/menu/:itemId/photo', can('merchants.review'), async (req, res) => {
    sendImage(res, await services.merchants.itemPhoto(id(req), uuid.parse(req.params.itemId), { publicOnly: false }));
  });
  for (const decision of ['approve', 'reject', 'suspend']) {
    r.post(`/merchants/:id/${decision}`, can('merchants.review'), async (req, res) => {
      const body = S.merchantReview.parse(req.body ?? {});
      res.json(await services.merchants.review(id(req), decision, { adminId: req.admin.id, ...body, ip: req.ip }));
    });
  }
  r.post('/merchants/:id/payments', can('merchants.finance'), async (req, res) => {
    const body = S.merchantPayment.parse(req.body);
    res.json(await services.merchants.recordPayment(id(req), { ...body, adminId: req.admin.id, ip: req.ip }));
  });

  // ---------- Usuarios ----------
  r.post('/users/:id/suspend', can('users.manage'), async (req, res) => {
    const userId = id(req);
    const { reason } = S.suspendUser.parse(req.body);
    const { rowCount } = await db.query(`UPDATE users SET status = 'suspended', status_reason = $2 WHERE id = $1`, [userId, reason]);
    if (!rowCount) throw notFound('Usuario no encontrado');
    await db.query('UPDATE drivers SET is_online = false WHERE user_id = $1', [userId]);
    await services.auth.revokeAllSessions(userId);
    realtime.disconnectUser(userId);
    await services.audit.log({ actorType: 'admin', actorId: req.admin.id, action: 'user.suspend', targetType: 'user', targetId: userId, ip: req.ip, details: { reason } });
    res.status(204).end();
  });
  r.post('/users/:id/reactivate', can('users.manage'), async (req, res) => {
    const userId = id(req);
    const { rowCount } = await db.query(`UPDATE users SET status = 'active', status_reason = NULL WHERE id = $1 AND status = 'suspended'`, [userId]);
    if (!rowCount) throw conflict('INVALID_STATE', 'El usuario no está suspendido');
    await services.audit.log({ actorType: 'admin', actorId: req.admin.id, action: 'user.reactivate', targetType: 'user', targetId: userId, ip: req.ip });
    res.status(204).end();
  });

  // ---------- Seguridad (SOS) ----------
  r.get('/incidents', can('incidents.manage'), async (req, res) => {
    const status = String(req.query.status ?? 'open');
    if (!['open', 'acknowledged', 'resolved', 'all'].includes(status)) throw badRequest('STATUS_INVALID', 'Estado inválido');
    res.json(await services.safety.listIncidents(status));
  });
  r.post('/incidents/:id/acknowledge', can('incidents.manage'), async (req, res) => {
    await services.safety.updateIncident(id(req), 'acknowledged', { adminId: req.admin.id, ip: req.ip });
    res.status(204).end();
  });
  r.post('/incidents/:id/resolve', can('incidents.manage'), async (req, res) => {
    await services.safety.updateIncident(id(req), 'resolved', { adminId: req.admin.id, ip: req.ip });
    res.status(204).end();
  });

  // ---------- Tarifas, zonas y reglas ----------
  r.get('/settings/:key', can('settings.read'), async (req, res) => {
    if (!SETTINGS_SCHEMAS[req.params.key]) throw notFound('Configuración no encontrada');
    res.json(await services.settings.get(req.params.key));
  });
  r.put('/settings/:key', can('settings.write'), async (req, res) => {
    if (!SETTINGS_SCHEMAS[req.params.key]) throw notFound('Configuración no encontrada');
    const value = await services.settings.set(req.params.key, req.body, { adminId: req.admin.id, ip: req.ip });
    services.pricing.invalidateCaches();
    res.json(value);
  });
  r.get('/pricing/snapshot', can('settings.read'), async (_req, res) => res.json(await services.pricing.snapshot()));

  const saveZone = async (req, res, zoneId) => {
    const z = S.zone.parse(req.body);
    const params = [z.slug, z.name, JSON.stringify(z.area), z.surgeEnabled, z.maxMultiplier, z.isActive];
    const sql = zoneId
      ? `UPDATE zones SET slug = $1, name = $2, area = ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), surge_enabled = $4,
                max_multiplier = $5, is_active = $6 WHERE id = $7 RETURNING id`
      : `INSERT INTO zones (slug, name, area, surge_enabled, max_multiplier, is_active)
         VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), $4, $5, $6) RETURNING id`;
    let row;
    try {
      row = await db.one(sql, zoneId ? [...params, zoneId] : params);
    } catch (err) {
      if (err.code === '23514' || err.code === 'XX000') throw badRequest('POLYGON_INVALID', 'El polígono no es válido');
      if (err.code === '23505') throw conflict('SLUG_IN_USE', 'Ya existe una zona con ese identificador');
      throw err;
    }
    if (!row) throw notFound('Zona no encontrada');
    services.pricing.invalidateCaches();
    await services.audit.log({ actorType: 'admin', actorId: req.admin.id, action: zoneId ? 'zone.update' : 'zone.create', targetType: 'zone', targetId: row.id, ip: req.ip });
    res.status(zoneId ? 200 : 201).json({ id: row.id });
  };
  r.post('/zones', can('settings.write'), (req, res) => saveZone(req, res, null));
  r.put('/zones/:id', can('settings.write'), (req, res) => saveZone(req, res, id(req)));

  r.get('/time-rules', can('settings.read'), async (_req, res) => {
    const { rows } = await db.query(
      `SELECT id, name, iso_days AS "isoDays", to_char(start_local, 'HH24:MI') AS "startLocal",
              to_char(end_local, 'HH24:MI') AS "endLocal", multiplier::float AS multiplier, is_active AS "isActive"
         FROM pricing_time_rules ORDER BY start_local`,
    );
    res.json(rows);
  });
  const saveRule = async (req, res, ruleId) => {
    const t = S.timeRule.parse(req.body);
    if (t.endLocal <= t.startLocal) throw badRequest('RULE_INVALID', 'La hora final debe ser mayor a la inicial');
    const params = [t.name, t.isoDays, t.startLocal, t.endLocal, t.multiplier, t.isActive];
    const row = await db.one(
      ruleId
        ? `UPDATE pricing_time_rules SET name = $1, iso_days = $2, start_local = $3, end_local = $4, multiplier = $5, is_active = $6
            WHERE id = $7 RETURNING id`
        : `INSERT INTO pricing_time_rules (name, iso_days, start_local, end_local, multiplier, is_active)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      ruleId ? [...params, ruleId] : params,
    );
    if (!row) throw notFound('Regla no encontrada');
    services.pricing.invalidateCaches();
    await services.audit.log({ actorType: 'admin', actorId: req.admin.id, action: ruleId ? 'time_rule.update' : 'time_rule.create', targetType: 'time_rule', targetId: row.id, ip: req.ip, details: t });
    res.status(ruleId ? 200 : 201).json({ id: row.id });
  };
  r.post('/time-rules', can('settings.write'), (req, res) => saveRule(req, res, null));
  r.put('/time-rules/:id', can('settings.write'), (req, res) => saveRule(req, res, id(req)));

  return r;
}
