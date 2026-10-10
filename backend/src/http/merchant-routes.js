import { Router } from 'express';
import { S, uuid } from './schemas.js';
import { MERCHANT_COOKIE_DEV, MERCHANT_COOKIE_SECURE, limiter, requireMerchant, singleImage } from './middleware.js';

/** API del panel de locales (/comercio): registro, menú, pedidos y cuenta. */
export function merchantRoutes({ services, config, realtime }) {
  const r = Router();
  const scale = config.rateLimitScale;
  const cookieName = config.cookieSecure ? MERCHANT_COOKIE_SECURE : MERCHANT_COOKIE_DEV;
  const auth = requireMerchant(services.adminAuth, cookieName);
  const id = (req) => uuid.parse(req.params.id);
  const byMerchant = (req) => req.merchantId;
  const sendImage = (res, buffer) => res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).send(buffer);

  // ---------- Registro autogestionado ----------
  r.post('/register/otp', limiter({ windowMs: 15 * 60_000, limit: 5, scale }), async (req, res) => {
    const { phone } = S.merchantOtp.parse(req.body);
    res.json(await services.auth.requestOtp({ phone, ip: req.ip, purpose: 'merchant_signup' }));
  });
  r.post('/register', limiter({ windowMs: 60 * 60_000, limit: 10, scale }), async (req, res) => {
    const body = S.merchantRegister.parse(req.body);
    res.status(201).json(await services.merchants.register({ ...body, ip: req.ip }));
  });

  // ---------- Sesión ----------
  r.post('/auth/login', limiter({ windowMs: 15 * 60_000, limit: 10, scale }), async (req, res) => {
    const body = S.adminLogin.parse(req.body);
    const out = await services.adminAuth.login({ ...body, ip: req.ip, userAgent: req.get('user-agent'), scope: 'merchant' });
    res.cookie(cookieName, out.token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/', maxAge: out.maxAgeSec * 1000 });
    res.json({ csrfToken: out.csrfToken, user: out.admin });
  });
  r.post('/auth/logout', auth, async (req, res) => {
    await services.adminAuth.logout(req.merchantToken);
    res.clearCookie(cookieName, { path: '/', secure: config.cookieSecure, httpOnly: true, sameSite: 'strict' });
    res.status(204).end();
  });
  r.get('/auth/me', auth, (req, res) => {
    const { id: userId, email, fullName, merchantId, csrfToken } = req.merchantUser;
    res.json({ user: { id: userId, email, fullName, merchantId }, csrfToken });
  });

  // Pedidos nuevos y cambios en vivo (Server-Sent Events), solo del propio local.
  r.get('/events', auth, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const off = realtime.onMerchantEvent(req.merchantId, ({ event, data }) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      off();
    });
  });

  // ---------- Datos del local ----------
  r.get('/profile', auth, async (req, res) => res.json(await services.merchants.profile(req.merchantId)));
  r.put('/profile', auth, async (req, res) => {
    const body = S.merchantProfile.parse(req.body);
    res.json(await services.merchants.updateProfile(req.merchantId, body, { ip: req.ip, actorId: req.merchantUser.id }));
  });
  r.put('/documents/:kind', auth, limiter({ windowMs: 60 * 60_000, limit: 30, scale, key: byMerchant }), singleImage('file'), async (req, res) => {
    res.json(await services.merchants.uploadDocument(req.merchantId, String(req.params.kind), req.file, { ip: req.ip }));
  });
  r.post('/submit', auth, async (req, res) => res.json(await services.merchants.submit(req.merchantId, { ip: req.ip })));
  r.put('/store', auth, async (req, res) => {
    res.json(await services.merchants.setOpen(req.merchantId, S.merchantStore.parse(req.body).isOpen));
  });

  // ---------- Productos ----------
  r.get('/menu', auth, async (req, res) => res.json(await services.merchants.listMenu(req.merchantId)));
  r.post('/menu', auth, async (req, res) => {
    res.status(201).json(await services.merchants.createItem(req.merchantId, S.menuItem.parse(req.body)));
  });
  r.put('/menu/:id', auth, async (req, res) => {
    res.json(await services.merchants.updateItem(req.merchantId, id(req), S.menuItemPatch.parse(req.body)));
  });
  r.delete('/menu/:id', auth, async (req, res) => {
    await services.merchants.deleteItem(req.merchantId, id(req));
    res.status(204).end();
  });
  r.put('/menu/:id/photo', auth, limiter({ windowMs: 60 * 60_000, limit: 120, scale, key: byMerchant }), singleImage('file'), async (req, res) => {
    res.json(await services.merchants.uploadItemPhoto(req.merchantId, id(req), req.file));
  });
  r.get('/menu/:id/photo', auth, async (req, res) => {
    sendImage(res, await services.merchants.itemPhoto(req.merchantId, id(req), { publicOnly: false }));
  });

  // ---------- Pedidos ----------
  r.get('/orders', auth, async (req, res) => {
    const scope = req.query.scope === 'history' ? 'history' : 'active';
    res.json(await services.orders.listForMerchant(req.merchantId, scope));
  });
  r.post('/orders/:id/accept', auth, async (req, res) => {
    const { prepMinutes } = S.orderAccept.parse(req.body);
    res.json(await services.orders.accept({ merchantId: req.merchantId, orderId: id(req), prepMinutes, actorId: req.merchantUser.id, ip: req.ip }));
  });
  r.post('/orders/:id/reject', auth, async (req, res) => {
    const { reason } = S.orderReject.parse(req.body);
    res.json(await services.orders.reject({ merchantId: req.merchantId, orderId: id(req), reason, actorId: req.merchantUser.id, ip: req.ip }));
  });
  r.post('/orders/:id/ready', auth, async (req, res) => {
    res.json(await services.orders.ready({ merchantId: req.merchantId, orderId: id(req), actorId: req.merchantUser.id, ip: req.ip }));
  });

  r.get('/ledger', auth, async (req, res) => res.json(await services.merchants.ledger(req.merchantId)));

  return r;
}
