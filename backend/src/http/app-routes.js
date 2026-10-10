import { Router } from 'express';
import { conflict } from '../lib/errors.js';
import { S, uuid } from './schemas.js';
import { limiter, requireApprovedDriver, requireProfile, requireUser, singleImage } from './middleware.js';

/** Rutas de las apps móviles (pasajero y conductor). */
export function appRoutes({ services, config }) {
  const r = Router();
  const scale = config.rateLimitScale;
  const auth = requireUser(services.auth);
  const byUser = (req) => req.user.id;
  const id = (req) => uuid.parse(req.params.id);

  // ---------- Autenticación por SMS (OTP) ----------
  r.post('/auth/otp/request', limiter({ windowMs: 15 * 60_000, limit: 10, scale }), async (req, res) => {
    const body = S.otpRequest.parse(req.body);
    res.json(await services.auth.requestOtp({ phone: body.phone, ip: req.ip }));
  });
  r.post('/auth/otp/verify', limiter({ windowMs: 15 * 60_000, limit: 20, scale }), async (req, res) => {
    const body = S.otpVerify.parse(req.body);
    res.json(await services.auth.verifyOtp({ ...body, ip: req.ip }));
  });
  r.post('/auth/refresh', limiter({ windowMs: 15 * 60_000, limit: 60, scale }), async (req, res) => {
    const body = S.refresh.parse(req.body);
    res.json(await services.auth.refresh({ ...body, ip: req.ip }));
  });
  r.post('/auth/logout', async (req, res) => {
    await services.auth.logout(S.logout.parse(req.body));
    res.status(204).end();
  });

  // ---------- Perfil ----------
  r.get('/me', auth, async (req, res) => res.json(await services.auth.getProfile(req.user.id)));
  r.put('/me/profile', auth, async (req, res) => {
    res.json(await services.auth.updateProfile(req.user.id, S.profile.parse(req.body), { ip: req.ip }));
  });
  r.get('/me/emergency-contacts', auth, async (req, res) => res.json(await services.auth.listEmergencyContacts(req.user.id)));
  r.post('/me/emergency-contacts', auth, async (req, res) => {
    res.status(201).json(await services.auth.addEmergencyContact(req.user.id, S.contact.parse(req.body)));
  });
  r.delete('/me/emergency-contacts/:id', auth, async (req, res) => {
    await services.auth.removeEmergencyContact(req.user.id, id(req));
    res.status(204).end();
  });

  // ---------- Registro de conductor (KYC) ----------
  r.get('/driver/application', auth, async (req, res) => {
    res.json((await services.drivers.application(req.user.id)) ?? { status: 'none' });
  });
  r.put('/driver/application', auth, requireProfile, async (req, res) => {
    res.json(await services.drivers.saveApplication(req.user.id, S.driverApplication.parse(req.body), { ip: req.ip }));
  });
  r.put('/driver/documents/:kind', auth, requireProfile, limiter({ windowMs: 60 * 60_000, limit: 40, scale, key: byUser }), singleImage('file'), async (req, res) => {
    res.json(await services.drivers.uploadDocument(req.user.id, String(req.params.kind), req.file, { ip: req.ip }));
  });
  r.post('/driver/application/submit', auth, requireProfile, async (req, res) => {
    res.json(await services.drivers.submit(req.user.id, { ip: req.ip }));
  });
  r.post('/driver/online', auth, requireApprovedDriver, async (req, res) => {
    res.json(await services.drivers.setOnline(req.user.id, S.online.parse(req.body).online, { ip: req.ip }));
  });

  // ---------- Billetera y recargas ----------
  r.get('/wallet', auth, requireApprovedDriver, async (req, res) => res.json(await services.wallet.summary(req.user.id)));
  r.get('/wallet/topups', auth, requireApprovedDriver, async (req, res) => res.json(await services.topups.listForDriver(req.user.id)));
  r.get('/wallet/topups/check-reference', auth, requireApprovedDriver, limiter({ windowMs: 10 * 60_000, limit: 30, scale, key: byUser }), async (req, res) => {
    res.json(await services.topups.checkReference(String(req.query.reference ?? '')));
  });
  r.post('/wallet/topups', auth, requireApprovedDriver, limiter({ windowMs: 60 * 60_000, limit: 15, scale, key: byUser }), singleImage('receipt'), async (req, res) => {
    const body = S.transferTopup.parse(req.body ?? {});
    res.status(201).json(await services.topups.createTransferTopup({ driverId: req.user.id, ...body, file: req.file, ip: req.ip }));
  });
  r.post('/wallet/topups/:id/resubmit', auth, requireApprovedDriver, limiter({ windowMs: 60 * 60_000, limit: 10, scale, key: byUser }), singleImage('receipt'), async (req, res) => {
    const body = S.resubmitTopup.parse(req.body ?? {});
    res.json(await services.topups.resubmit({ driverId: req.user.id, topupId: id(req), amountCents: body.amountCents, file: req.file, ip: req.ip }));
  });
  r.post('/wallet/topups/payphone', auth, requireApprovedDriver, limiter({ windowMs: 60 * 60_000, limit: 10, scale, key: byUser }), async (req, res) => {
    const body = S.gatewayTopup.parse(req.body);
    res.status(201).json(await services.topups.createGatewayTopup({ driverId: req.user.id, amountCents: body.amountCents, ip: req.ip }));
  });

  // ---------- Viajes ----------
  r.post('/trips/quote', auth, requireProfile, limiter({ windowMs: 10 * 60_000, limit: 40, scale, key: byUser }), async (req, res) => {
    res.json(await services.pricing.quote({ passengerId: req.user.id, ...S.quote.parse(req.body) }));
  });
  r.post('/trips', auth, requireProfile, limiter({ windowMs: 10 * 60_000, limit: 15, scale, key: byUser }), async (req, res) => {
    res.status(201).json(await services.trips.request({ passengerId: req.user.id, quoteId: S.tripRequest.parse(req.body).quoteId, ip: req.ip }));
  });
  r.get('/trips/current', auth, async (req, res) => res.json({ trip: await services.trips.current(req.user.id) }));
  r.get('/trips/history', auth, async (req, res) => res.json(await services.trips.history(req.user.id)));
  r.get('/trips/:id', auth, async (req, res) => res.json(await services.trips.get({ tripId: id(req), userId: req.user.id })));
  r.post('/trips/:id/accept', auth, requireApprovedDriver, async (req, res) => {
    res.json(await services.trips.accept({ tripId: id(req), driverId: req.user.id, ip: req.ip }));
  });
  r.post('/trips/:id/decline', auth, requireApprovedDriver, async (req, res) => {
    await services.trips.decline({ tripId: id(req), driverId: req.user.id });
    res.status(204).end();
  });
  r.post('/trips/:id/arrived', auth, requireApprovedDriver, async (req, res) => {
    res.json(await services.trips.arrived({ tripId: id(req), driverId: req.user.id }));
  });
  r.post('/trips/:id/start', auth, requireApprovedDriver, async (req, res) => {
    res.json(await services.trips.start({ tripId: id(req), driverId: req.user.id, pin: S.pin.parse(req.body).pin, ip: req.ip }));
  });
  r.post('/trips/:id/complete', auth, requireApprovedDriver, async (req, res) => {
    res.json(await services.trips.complete({ tripId: id(req), driverId: req.user.id, ip: req.ip }));
  });
  r.post('/trips/:id/cancel', auth, async (req, res) => {
    const tripId = id(req);
    const trip = await services.trips.get({ tripId, userId: req.user.id });
    res.json(await services.trips.cancel({ tripId, userId: req.user.id, role: trip.role, reason: S.cancel.parse(req.body ?? {}).reason, ip: req.ip }));
  });
  r.post('/trips/:id/rate', auth, async (req, res) => {
    const tripId = id(req);
    const trip = await services.trips.get({ tripId, userId: req.user.id });
    await services.trips.rate({ tripId, userId: req.user.id, role: trip.role, stars: S.rate.parse(req.body).stars });
    res.status(204).end();
  });
  r.post('/trips/:id/share', auth, async (req, res) => {
    res.json(await services.trips.createShareLink({ tripId: id(req), userId: req.user.id }));
  });

  // ---------- Seguridad ----------
  r.post('/safety/sos', auth, async (req, res) => {
    const body = S.sos.parse(req.body ?? {});
    if ((body.lat === undefined) !== (body.lng === undefined)) throw conflict('LOCATION_INVALID', 'Ubicación incompleta');
    res.status(201).json(await services.safety.sos({ userId: req.user.id, ...body, ip: req.ip }));
  });

  // ---------- Búsqueda de direcciones (proxy con caché) ----------
  r.get('/geo/search', auth, limiter({ windowMs: 60_000, limit: 30, scale, key: byUser }), async (req, res) => {
    res.json(await services.geo.search(S.geoSearch.parse(req.query).q));
  });
  r.get('/geo/reverse', auth, limiter({ windowMs: 60_000, limit: 30, scale, key: byUser }), async (req, res) => {
    res.json(await services.geo.reverse(S.geoReverse.parse(req.query)));
  });

  return r;
}
