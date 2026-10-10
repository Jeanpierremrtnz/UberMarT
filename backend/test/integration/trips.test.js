import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { adminSession, approvedDriver, bootServer, client, fakeImage, imageForm, nextPhone, signup } from '../helpers.js';

let srv;
let api;
const sockets = [];
before(async () => {
  srv = await bootServer({ guardOptions: { minIntervalMs: 0 } });
  api = client(srv.url);
});
after(async () => {
  for (const s of sockets) s.disconnect();
  await srv?.close();
});

// Centro de Manta (dentro de la geocerca "centro") y destino en Tarqui.
const PICKUP = { lat: -0.9505, lng: -80.7285 };
const DROPOFF = { lat: -0.9580, lng: -80.7050 };
const e5 = (v) => Math.round(v * 1e5);

function socketFor(user) {
  return new Promise((resolve, reject) => {
    const s = connect(srv.url, { path: '/ws', transports: ['websocket'], auth: { token: user.token }, reconnection: false });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

const waitFor = (socket, event, predicate = () => true, ms = 4000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando ${event}`)), ms);
    const handler = (data) => {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    };
    socket.on(event, handler);
  });

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condición no cumplida a tiempo');
}

test('socket: sin token válido no hay conexión', async () => {
  await assert.rejects(socketFor({ token: 'basura' }), /unauthorized/);
});

test('viaje completo: cotización, despacho por GPS en vivo, PIN, comisión y calificación', async () => {
  const passenger = await signup(api, srv);
  await api.post('/api/me/emergency-contacts', { name: 'Mamá', phone: nextPhone() }, { token: passenger.token });
  const driver = await approvedDriver(api, srv, { balanceCents: 500 });

  const lowBalance = await approvedDriver(api, srv, { balanceCents: 50 });
  const denied = await api.post('/api/driver/online', { online: true }, { token: lowBalance.token });
  assert.equal(denied.status, 403, 'sin saldo mínimo no puede conectarse');

  const ds = await socketFor(driver);
  assert.equal((await api.post('/api/driver/online', { online: true }, { token: driver.token })).status, 200);
  ds.emit('loc', [e5(-0.9500), e5(-80.7280), 90, 0, 0]);
  await until(async () => (await srv.ctx.db.one('SELECT location_at FROM drivers WHERE user_id = $1', [driver.id])).location_at);

  // GPS simulado (app de "fake GPS") se descarta y se registra como anomalía.
  ds.emit('loc', [e5(-0.9400), e5(-80.7000), 0, 0, 1]);
  await until(async () => (await srv.ctx.db.one('SELECT gps_anomalies FROM drivers WHERE user_id = $1', [driver.id])).gps_anomalies === 1);

  const quote = await api.post('/api/trips/quote', { origin: PICKUP, destination: DROPOFF, originLabel: 'Malecón', destinationLabel: 'Tarqui' }, { token: passenger.token });
  assert.equal(quote.status, 200);
  assert.equal(quote.body.zone.slug, 'centro');
  assert.ok(quote.body.totalCents >= 100);
  assert.equal(quote.body.driversNearby, 1);
  assert.equal(quote.body.breakdown.routeSource, 'estimate', 'sin OSRM usa estimación');

  const ps = await socketFor(passenger);
  const offerP = waitFor(ds, 'trip:offer');
  const trip = await api.post('/api/trips', { quoteId: quote.body.quoteId }, { token: passenger.token });
  assert.equal(trip.status, 201);
  assert.equal(trip.body.fareCents, quote.body.totalCents, 'precio fijo: el que se cotizó');
  const offer = await offerP;
  assert.equal(offer.tripId, trip.body.id);
  assert.ok(offer.pickupDistanceM < 200);

  const reused = await api.post('/api/trips', { quoteId: quote.body.quoteId }, { token: passenger.token });
  assert.equal(reused.status, 409, 'una cotización no se usa dos veces');

  const acceptedP = waitFor(ps, 'trip:update', (t) => t.status === 'accepted');
  const acc = await api.post(`/api/trips/${trip.body.id}/accept`, {}, { token: driver.token });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.pin, undefined, 'el conductor nunca ve el PIN');
  const accepted = await acceptedP;
  assert.match(accepted.pin, /^\d{4}$/);
  assert.equal(accepted.driver.plate, driver.plate);

  const watched = await ps.emitWithAck('trip:watch', { tripId: trip.body.id });
  assert.equal(watched.ok, true);
  const intruder = await signup(api, srv);
  const is = await socketFor(intruder);
  assert.equal((await is.emitWithAck('trip:watch', { tripId: trip.body.id })).ok, false, 'un extraño no puede rastrear el viaje');
  assert.equal((await api.get(`/api/trips/${trip.body.id}`, { token: intruder.token })).status, 404);

  const dlocP = waitFor(ps, 'dloc');
  ds.emit('loc', [e5(-0.9503), e5(-80.7283), 180, 12, 0]);
  const dloc = await dlocP;
  assert.deepEqual(dloc, [e5(-0.9503), e5(-80.7283), 180]);

  await until(async () => (await srv.ctx.db.one('SELECT ST_Distance(location, ST_SetSRID(ST_MakePoint(-80.7283, -0.9503), 4326)::geography) AS d FROM drivers WHERE user_id = $1', [driver.id])).d < 2);
  assert.equal((await api.post(`/api/trips/${trip.body.id}/arrived`, {}, { token: driver.token })).status, 200);

  const wrongPin = accepted.pin === '0000' ? '1111' : '0000';
  const bad = await api.post(`/api/trips/${trip.body.id}/start`, { pin: wrongPin }, { token: driver.token });
  assert.equal(bad.body.error.code, 'PIN_INVALID');
  const started = await api.post(`/api/trips/${trip.body.id}/start`, { pin: accepted.pin }, { token: driver.token });
  assert.equal(started.body.status, 'in_progress');

  // Botón de pánico durante el viaje.
  const admin = await adminSession(api, srv, 'operations');
  const events = await fetch(`${srv.url}/api/admin/events`, { headers: admin.headers });
  const reader = events.body.getReader();
  const sos = await api.post('/api/safety/sos', { tripId: trip.body.id, lat: -0.951, lng: -80.72 }, { token: passenger.token });
  assert.equal(sos.status, 201);
  assert.equal(sos.body.notifiedContacts, 1);
  const sms = srv.ctx.services.sms.outbox.at(-1).body;
  assert.match(sms, /boton de panico/);
  assert.match(sms, /\/s\/[A-Za-z0-9_-]+/, 'el SMS incluye link de seguimiento en vivo');
  let stream = '';
  while (!stream.includes('event: sos')) stream += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const shareUrl = /(\/s\/[A-Za-z0-9_-]+)/.exec(sms)[1];
  const live = await fetch(`${srv.url}${shareUrl}`);
  assert.match(await live.text(), new RegExp(driver.plate));

  const done = await api.post(`/api/trips/${trip.body.id}/complete`, {}, { token: driver.token });
  assert.equal(done.status, 200);
  const commission = Math.round(trip.body.fareCents * 0.10);
  assert.equal(done.body.commissionCents, commission);
  assert.equal(done.body.balanceCents, 500 - commission);
  const again = await api.post(`/api/trips/${trip.body.id}/complete`, {}, { token: driver.token });
  assert.equal(again.status, 409, 'no se cobra comisión dos veces');

  assert.match(await (await fetch(`${srv.url}${shareUrl}`)).text(), /Viaje finalizado/, 'el link expira al terminar');
  assert.equal((await api.post(`/api/trips/${trip.body.id}/rate`, { stars: 5 }, { token: passenger.token })).status, 204);
  assert.equal((await api.post(`/api/trips/${trip.body.id}/rate`, { stars: 1 }, { token: passenger.token })).status, 409);
  const points = await srv.ctx.db.one('SELECT count(*)::int AS n FROM trip_points WHERE trip_id = $1', [trip.body.id]);
  assert.ok(points.n >= 1, 'el recorrido queda guardado para investigar incidentes');
  assert.equal((await srv.ctx.services.wallet.integrityReport()).ok, true);
});

test('el conductor cancela antes de recoger: el viaje se reasigna a otro conductor', async () => {
  const passenger = await signup(api, srv);
  const d1 = await approvedDriver(api, srv, { balanceCents: 500, location: { lat: -0.9502, lng: -80.7282 } });
  const d2 = await approvedDriver(api, srv, { balanceCents: 500, location: { lat: -0.9510, lng: -80.7290 } });
  for (const d of [d1, d2]) await api.post('/api/driver/online', { online: true }, { token: d.token });
  const s2 = await socketFor(d2);
  const quote = await api.post('/api/trips/quote', { origin: PICKUP, destination: DROPOFF }, { token: passenger.token });
  const trip = await api.post('/api/trips', { quoteId: quote.body.quoteId }, { token: passenger.token });
  const accept = await api.post(`/api/trips/${trip.body.id}/accept`, {}, { token: d1.token });
  assert.equal(accept.status, 200);
  const taken = await api.post(`/api/trips/${trip.body.id}/accept`, {}, { token: d2.token });
  assert.equal(taken.body.error.code, 'TRIP_TAKEN', 'solo un conductor gana el viaje');
  await srv.ctx.db.query('DELETE FROM trip_offers WHERE trip_id = $1 AND driver_id = $2', [trip.body.id, d2.id]);
  const reoffer = waitFor(s2, 'trip:offer', (o) => o.tripId === trip.body.id);
  const cancel = await api.post(`/api/trips/${trip.body.id}/cancel`, { reason: 'Llanta baja' }, { token: d1.token });
  assert.equal(cancel.body.status, 'reassigned');
  await reoffer;
  for (const d of [d1, d2]) await api.post('/api/driver/online', { online: false }, { token: d.token });
  await api.post(`/api/trips/${trip.body.id}/cancel`, {}, { token: passenger.token });
});

test('sin conductores el viaje expira tras las rondas de búsqueda', async () => {
  const passenger = await signup(api, srv);
  const quote = await api.post('/api/trips/quote', { origin: { lat: -0.99, lng: -80.70 }, destination: DROPOFF }, { token: passenger.token });
  const trip = await api.post('/api/trips', { quoteId: quote.body.quoteId }, { token: passenger.token });
  await srv.ctx.db.query(`UPDATE trips SET dispatch_round = 3, last_dispatch_at = now() - interval '1 minute' WHERE id = $1`, [trip.body.id]);
  await srv.ctx.services.trips.sweep();
  const t = await api.get(`/api/trips/${trip.body.id}`, { token: passenger.token });
  assert.equal(t.body.status, 'expired');
});

test('fuera del área de servicio no se cotiza', async () => {
  const passenger = await signup(api, srv);
  const r = await api.post('/api/trips/quote', { origin: { lat: -0.18, lng: -78.48 }, destination: DROPOFF }, { token: passenger.token });
  assert.equal(r.body.error.code, 'OUT_OF_SERVICE_AREA');
});

test('tarifa dinámica: zona caliente en Barbasquillo, hora pico y lluvia forzada desde el panel', async () => {
  const { db, services } = srv.ctx;
  const barbasquillo = { lat: -0.9500, lng: -80.7550 };
  const zone = await services.pricing.zoneAt(barbasquillo);
  assert.equal(zone.slug, 'barbasquillo');
  for (let i = 0; i < 20; i += 1) {
    const u = await db.one(`INSERT INTO users (phone) VALUES ($1) RETURNING id`, [`+5939${String(70000000 + i)}`]);
    await db.query(
      `INSERT INTO fare_quotes (passenger_id, origin, destination, zone_id, distance_m, duration_s, breakdown, total_cents, expires_at)
       VALUES ($1, ST_SetSRID(ST_MakePoint(-80.755, -0.95), 4326)::geography, ST_SetSRID(ST_MakePoint(-80.70, -0.96), 4326)::geography,
               $2, 3000, 600, '{}', 200, now() + interval '5 minutes')`,
      [u.id, zone.id],
    );
  }
  for (let i = 0; i < 3; i += 1) {
    const d = await approvedDriver(api, srv, { balanceCents: 500, location: { lat: -0.951 - i * 0.001, lng: -80.756 } });
    await db.query('UPDATE drivers SET is_online = true WHERE user_id = $1', [d.id]);
  }
  services.pricing.invalidateCaches();
  const passenger = await signup(api, srv);
  const monday0730 = new Date('2026-10-12T12:30:00Z');
  const q = await services.pricing.quote({ passengerId: passenger.id, origin: barbasquillo, destination: DROPOFF, now: monday0730 });
  assert.equal(q.breakdown.multiplier, 1.5, '20 solicitudes / 3 motos');
  assert.equal(q.breakdown.multiplierSource, 'zona', 'gana el mayor: zona (1.5) sobre horario (1.2)');
  assert.equal(q.breakdown.timeRule, 'Entrada a trabajos y colegios');

  const owner = await adminSession(api, srv, 'owner');
  const ops = await adminSession(api, srv, 'operations');
  assert.equal((await api.put('/api/admin/settings/weather', { mode: 'force_rain' }, { headers: ops.headers })).status, 403, 'solo el dueño cambia tarifas');
  assert.equal((await api.put('/api/admin/settings/weather', { mode: 'force_rain' }, { headers: owner.headers })).status, 200);
  const centro = await services.pricing.quote({ passengerId: passenger.id, origin: PICKUP, destination: DROPOFF, now: new Date('2026-10-12T17:00:00Z') });
  assert.equal(centro.raining, true);
  assert.equal(centro.breakdown.rainSurchargeCents, 50);
  assert.equal(centro.breakdown.multiplier, 1);
  const invalid = await api.put('/api/admin/settings/pricing', { baseCents: -5 }, { headers: owner.headers });
  assert.equal(invalid.status, 400);
  await api.put('/api/admin/settings/weather', { mode: 'auto' }, { headers: owner.headers });
});

test('registro de conductor (KYC): documentos completos, imágenes únicas y aprobación del panel', async () => {
  const u = await signup(api, srv);
  const app = {
    licenseNumber: '1312345678', licenseExpiresOn: '2029-01-31', plate: 'mb-482c',
    motoBrand: 'Suzuki', motoModel: 'GN125', motoYear: 2022, motoColor: 'Negro',
  };
  assert.equal((await api.put('/api/driver/application', { ...app, licenseExpiresOn: '2020-01-01' }, { token: u.token })).body.error.code, 'LICENSE_EXPIRED');
  const saved = await api.put('/api/driver/application', app, { token: u.token });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.plate, 'MB482C');

  const early = await api.post('/api/driver/application/submit', {}, { token: u.token });
  assert.equal(early.body.error.code, 'DOCUMENTS_MISSING');
  const kinds = ['cedula_front', 'cedula_back', 'license_front', 'license_back', 'vehicle_registration', 'criminal_record', 'selfie', 'moto_photo'];
  for (const kind of kinds) {
    const r = await api.putForm(`/api/driver/documents/${kind}`, imageForm({}, await fakeImage(), 'file'), { token: u.token });
    assert.equal(r.status, 200, kind);
  }
  const stored = await srv.ctx.db.one(`SELECT storage_key FROM driver_documents WHERE driver_id = $1 AND kind = 'selfie'`, [u.id]);
  const raw = await import('node:fs/promises').then((fs) => fs.readFile(`${srv.ctx.config.storageDir}/${stored.storage_key}`));
  assert.notEqual(raw.subarray(0, 3).toString('hex'), 'ffd8ff', 'los documentos se guardan cifrados, no como JPEG legible');

  const thief = await signup(api, srv);
  await api.put('/api/driver/application', { ...app, plate: 'XY123Z' }, { token: thief.token });
  const sameImage = await srv.ctx.db.one(`SELECT 1 FROM driver_documents WHERE driver_id = $1`, [u.id]);
  assert.ok(sameImage);
  const dupPlate = await api.put('/api/driver/application', app, { token: thief.token });
  assert.equal(dupPlate.body.error.code, 'PLATE_IN_USE');

  const submitted = await api.post('/api/driver/application/submit', {}, { token: u.token });
  assert.equal(submitted.body.status, 'submitted');
  assert.equal((await api.put('/api/driver/application', app, { token: u.token })).status, 409, 'bloqueado mientras se revisa');

  const ops = await adminSession(api, srv, 'operations');
  const detail = await api.get(`/api/admin/drivers/${u.id}`, { headers: ops.headers });
  assert.equal(detail.body.licenseNumber, '1312345678');
  assert.equal(detail.body.documents.length, 8);
  const pii = await srv.ctx.db.one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'driver.pii_view' AND target_id = $1`, [u.id]);
  assert.equal(pii.n, 1, 'ver datos personales queda auditado');
  const doc = await fetch(`${srv.url}/api/admin/drivers/${u.id}/documents/selfie`, { headers: ops.headers });
  assert.equal(doc.headers.get('content-type'), 'image/jpeg');
  const finance = await adminSession(api, srv, 'finance');
  assert.equal((await api.get(`/api/admin/drivers/${u.id}`, { headers: finance.headers })).status, 403);

  assert.equal((await api.post(`/api/admin/drivers/${u.id}/approve`, {}, { headers: ops.headers })).status, 200);
  const wallet = await api.get('/api/wallet', { token: u.token });
  assert.equal(wallet.body.balanceCents, 0, 'la billetera se crea al aprobar');
});
