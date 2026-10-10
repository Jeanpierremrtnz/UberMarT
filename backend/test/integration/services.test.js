import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { adminSession, approvedDriver, bootServer, client, fakeImage, imageForm, makeCedula, nextPhone, signup } from '../helpers.js';
import { base32Decode, currentStep, hotp } from '../../src/lib/totp.js';

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

const STORE = { lat: -0.9520, lng: -80.7300 }; // Centro de Manta
const HOME = { lat: -0.9580, lng: -80.7050 }; // Tarqui
const PICKUP = { lat: -0.9505, lng: -80.7285 };
const lastSms = () => srv.ctx.services.sms.outbox.at(-1);

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

async function onlineDriverAt(point) {
  const d = await approvedDriver(api, srv, { balanceCents: 500, location: point });
  await api.post('/api/driver/online', { online: true }, { token: d.token });
  return d;
}
async function offline(d) {
  await api.post('/api/driver/online', { online: false }, { token: d.token });
}

let seq = 900_000;
/** Registro autogestionado completo de un local y su sesión en /comercio. */
async function registerMerchant({ name = 'Picantería La Manabita' } = {}) {
  const phone = nextPhone();
  const otp = await api.post('/api/merchant/register/otp', { phone });
  assert.equal(otp.status, 200);
  const code = /(\d{6})/.exec(lastSms().body)[1];
  const cedula = makeCedula((seq += 1));
  const email = `local-${seq}@ubermart.test`;
  const password = 'Clave-Local-2026';
  const reg = await api.post('/api/merchant/register', {
    challengeId: otp.body.challengeId,
    code,
    business: { name, category: 'restaurante', ruc: `${cedula}001`, addressLabel: 'Av. 24 y calle 13, Centro', ...STORE, scheduleText: 'Lun-Dom 11:00-22:00' },
    owner: { fullName: 'María Zambrano', cedula, email, password },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const totp = hotp(base32Decode(reg.body.totpSecret), currentStep());
  const login = await api.post('/api/merchant/auth/login', { email, password, totp });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { id: reg.body.merchantId, email, password, totpSecret: reg.body.totpSecret, headers: { Cookie: cookie, 'X-CSRF-Token': login.body.csrfToken } };
}

async function approvedOpenMerchant() {
  const m = await registerMerchant();
  for (const kind of ['ruc', 'permiso_funcionamiento', 'cedula_owner', 'storefront']) {
    const r = await api.putForm(`/api/merchant/documents/${kind}`, imageForm({}, await fakeImage(), 'file'), { headers: m.headers });
    assert.equal(r.status, 200, kind);
  }
  const encebollado = await api.post('/api/merchant/menu', { category: 'Platos', name: 'Encebollado', priceCents: 350 }, { headers: m.headers });
  const ceviche = await api.post('/api/merchant/menu', { category: 'Platos', name: 'Ceviche de camarón', priceCents: 600 }, { headers: m.headers });
  assert.equal((await api.post('/api/merchant/submit', {}, { headers: m.headers })).status, 200);
  const ops = await adminSession(api, srv, 'operations');
  assert.equal((await api.post(`/api/admin/merchants/${m.id}/approve`, { commissionBps: 1200 }, { headers: ops.headers })).status, 200);
  assert.equal((await api.put('/api/merchant/store', { isOpen: true }, { headers: m.headers })).status, 200);
  return { ...m, items: { encebollado: encebollado.body, ceviche: ceviche.body } };
}

// ---------------------------------------------------------------- Mensajería

test('mensajería: datos del paquete validados, fotos y PIN del destinatario como prueba de entrega', async () => {
  const sender = await signup(api, srv);
  const driver = await onlineDriverAt({ lat: -0.9500, lng: -80.7280 });
  const parcel = {
    recipientName: 'Pedro Cedeño', recipientPhone: nextPhone(), description: 'Documentos en sobre manila',
    size: 'sobre', weightKg: 0.5, declaredValueCents: 0, payer: 'recipient', prohibitedItemsAck: true,
  };
  const noAck = await api.post('/api/trips/quote', { service: 'parcel', origin: PICKUP, destination: HOME, parcel: { ...parcel, prohibitedItemsAck: false } }, { token: sender.token });
  assert.equal(noAck.status, 400, 'debe declarar que no lleva artículos prohibidos');
  const heavy = await api.post('/api/trips/quote', { service: 'parcel', origin: PICKUP, destination: HOME, parcel: { ...parcel, weightKg: 25 } }, { token: sender.token });
  assert.equal(heavy.body.error.code, 'TOO_HEAVY');

  const quote = await api.post('/api/trips/quote', { service: 'parcel', origin: PICKUP, destination: HOME, parcel }, { token: sender.token });
  assert.equal(quote.status, 200);
  assert.equal(quote.body.service, 'parcel');
  const ds = await socketFor(driver);
  const offerP = waitFor(ds, 'trip:offer');
  const trip = await api.post('/api/trips', { quoteId: quote.body.quoteId }, { token: sender.token });
  assert.equal(trip.status, 201);
  assert.match(trip.body.deliveryPin, /^\d{4}$/);
  assert.equal(trip.body.collectAt, 'dropoff', 'paga el destinatario al recibir');
  const offer = await offerP;
  assert.equal(offer.service, 'parcel');
  assert.equal(offer.parcel.size, 'sobre');

  const acc = await api.post(`/api/trips/${trip.body.id}/accept`, {}, { token: driver.token });
  assert.notEqual(acc.body.parcel.recipientPhone, parcel.recipientPhone, 'el conductor no ve el teléfono antes de recoger');
  assert.equal(acc.body.deliveryPin, undefined, 'el conductor nunca ve el PIN de entrega');
  await api.post(`/api/trips/${trip.body.id}/arrived`, {}, { token: driver.token });
  const pickupPin = (await api.get(`/api/trips/${trip.body.id}`, { token: sender.token })).body.pin;
  const noPhoto = await api.post(`/api/trips/${trip.body.id}/start`, { pin: pickupPin }, { token: driver.token });
  assert.equal(noPhoto.body.error.code, 'PHOTO_REQUIRED');
  const photo = await api.putForm(`/api/trips/${trip.body.id}/photos/pickup`, imageForm({}, await fakeImage(), 'file'), { token: driver.token });
  assert.equal(photo.status, 200);
  const started = await api.post(`/api/trips/${trip.body.id}/start`, { pin: pickupPin }, { token: driver.token });
  assert.equal(started.body.status, 'in_progress');
  assert.equal(started.body.parcel.recipientPhone.length, 13, 'con el paquete en mano ve el teléfono completo');

  const sms = srv.ctx.services.sms.outbox.find((m) => m.to === `+593${parcel.recipientPhone.slice(1)}`);
  assert.ok(sms, 'el destinatario recibe un SMS');
  assert.match(sms.body, new RegExp(`PIN ${trip.body.deliveryPin}`));
  assert.match(sms.body, /\/s\/[A-Za-z0-9_-]+/);

  const senderPhoto = await fetch(`${srv.url}/api/trips/${trip.body.id}/photos/pickup`, { headers: { Authorization: `Bearer ${sender.token}` } });
  assert.equal(senderPhoto.status, 200, 'el remitente ve la foto del paquete recogido');
  const stranger = await signup(api, srv);
  assert.equal((await fetch(`${srv.url}/api/trips/${trip.body.id}/photos/pickup`, { headers: { Authorization: `Bearer ${stranger.token}` } })).status, 404);

  const noDropPhoto = await api.post(`/api/trips/${trip.body.id}/complete`, { pin: trip.body.deliveryPin }, { token: driver.token });
  assert.equal(noDropPhoto.body.error.code, 'PHOTO_REQUIRED');
  await api.putForm(`/api/trips/${trip.body.id}/photos/dropoff`, imageForm({}, await fakeImage(), 'file'), { token: driver.token });
  const wrong = trip.body.deliveryPin === '0000' ? '1111' : '0000';
  assert.equal((await api.post(`/api/trips/${trip.body.id}/complete`, { pin: wrong }, { token: driver.token })).body.error.code, 'PIN_INVALID');
  const done = await api.post(`/api/trips/${trip.body.id}/complete`, { pin: trip.body.deliveryPin }, { token: driver.token });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'completed');
  assert.equal(done.body.commissionCents, Math.round(quote.body.totalCents * 0.1));
  await offline(driver);
});

// ---------------------------------------------------------------- Registro de locales

test('registro de locales: OTP, RUC válido y único, cuenta con autenticador y revisión del panel', async () => {
  const phone = nextPhone();
  const otp = await api.post('/api/merchant/register/otp', { phone });
  const code = /(\d{6})/.exec(lastSms().body)[1];
  const cedula = makeCedula(777_001);
  const base = {
    challengeId: otp.body.challengeId,
    code,
    business: { name: 'Café del Puerto', category: 'cafeteria', ruc: `${cedula}001`, addressLabel: 'Malecón de Manta', ...STORE },
    owner: { fullName: 'Luis Pico', cedula, email: 'cafe@ubermart.test', password: 'Clave-Local-2026' },
  };
  const badRuc = await api.post('/api/merchant/register', { ...base, business: { ...base.business, ruc: '1234567890001' } });
  assert.equal(badRuc.body.error.code, 'RUC_INVALID');
  const weak = await api.post('/api/merchant/register', { ...base, owner: { ...base.owner, password: 'corta' } });
  assert.equal(weak.status, 400);
  const far = await api.post('/api/merchant/register', { ...base, business: { ...base.business, lat: -0.18, lng: -78.48 } });
  assert.equal(far.body.error.code, 'OUT_OF_SERVICE_AREA');
  const wrongCode = await api.post('/api/merchant/register', { ...base, code: code === '000000' ? '111111' : '000000' });
  assert.equal(wrongCode.status, 401);
  const ok = await api.post('/api/merchant/register', base);
  assert.equal(ok.status, 201);
  assert.match(ok.body.totpUri, /^otpauth:\/\/totp\//);
  const again = await api.post('/api/merchant/register', base);
  assert.equal(again.status, 409, 'el código SMS y el RUC no se reutilizan');

  const loginCode = hotp(base32Decode(ok.body.totpSecret), currentStep());
  assert.equal((await api.post('/api/admin/auth/login', { email: base.owner.email, password: base.owner.password, totp: loginCode })).status, 401,
    'la cuenta de un local no entra al panel interno');
  const m = await api.post('/api/merchant/auth/login', { email: base.owner.email, password: base.owner.password, totp: loginCode });
  assert.equal(m.status, 200);
  const headers = { Cookie: m.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), 'X-CSRF-Token': m.body.csrfToken };
  assert.equal((await api.get('/api/admin/topups/queue', { headers })).status, 401);

  const cheap = await api.put('/api/merchant/store', { isOpen: true }, { headers });
  assert.equal(cheap.status, 403, 'no puede abrir sin aprobación');
  const early = await api.post('/api/merchant/submit', {}, { headers });
  assert.equal(early.body.error.code, 'DOCUMENTS_MISSING');

  const owner = await adminSession(api, srv, 'owner');
  const adminAsMerchant = await api.post('/api/merchant/auth/login', { email: owner.email, password: owner.password, totp: hotp(base32Decode(owner.totpSecret), currentStep() + 1) });
  assert.equal(adminAsMerchant.status, 401, 'una cuenta del panel no entra como local');
});

// ---------------------------------------------------------------- Delivery

test('delivery: productos del local, pedido con precios del servidor, despacho, pago al local y PIN del cliente', async () => {
  const merchant = await approvedOpenMerchant();
  const customer = await signup(api, srv);
  const driver = await onlineDriverAt({ lat: -0.9518, lng: -80.7298 });

  const list = await api.get(`/api/merchants?lat=${HOME.lat}&lng=${HOME.lng}`, { token: customer.token });
  const listed = list.body.find((x) => x.id === merchant.id);
  assert.ok(listed && listed.isOpen);
  const menu = await api.get(`/api/merchants/${merchant.id}`, { token: customer.token });
  assert.equal(menu.body.items.length, 2);

  // Foto del producto: visible públicamente solo para locales aprobados.
  const photo = await api.putForm(`/api/merchant/menu/${merchant.items.ceviche.id}/photo`, imageForm({}, await fakeImage(), 'file'), { headers: merchant.headers });
  assert.match(photo.body.photoUrl, /photo/);
  const pub = await fetch(`${srv.url}/api/merchants/${merchant.id}/items/${merchant.items.ceviche.id}/photo`);
  assert.equal(pub.status, 200);
  assert.match(pub.headers.get('cache-control'), /public/);

  const items = [{ itemId: merchant.items.encebollado.id, qty: 2 }, { itemId: merchant.items.ceviche.id, qty: 1, note: 'sin cebolla' }];
  const tooMuch = await api.post('/api/orders/quote', {
    merchantId: merchant.id, items: [{ itemId: merchant.items.ceviche.id, qty: 5 }], destination: HOME, destinationLabel: 'Casa en Tarqui',
  }, { token: customer.token });
  assert.equal(tooMuch.body.error.code, 'ORDER_LIMIT', 'primer pedido limitado a $20 para proteger al motorizado');

  const q = await api.post('/api/orders/quote', { merchantId: merchant.id, items, destination: HOME, destinationLabel: 'Casa en Tarqui' }, { token: customer.token });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.subtotalCents, 2 * 350 + 600, 'precios tomados de la base de datos');
  assert.equal(q.body.totalCents, q.body.subtotalCents + q.body.deliveryFeeCents);

  const events = await fetch(`${srv.url}/api/merchant/events`, { headers: merchant.headers });
  const reader = events.body.getReader();
  const order = await api.post('/api/orders', { quoteId: q.body.quoteId, note: 'Timbre dañado, llamar' }, { token: customer.token });
  assert.equal(order.status, 201);
  assert.equal(order.body.status, 'placed');
  let stream = '';
  while (!stream.includes('event: order:new')) stream += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.equal((await api.post('/api/orders', { quoteId: q.body.quoteId }, { token: customer.token })).status, 409);

  const other = await registerMerchant({ name: 'Otro Local' });
  assert.equal((await api.post(`/api/merchant/orders/${order.body.id}/accept`, { prepMinutes: 5 }, { headers: other.headers })).status, 404,
    'un local no puede tocar pedidos de otro');
  const merchantView = (await api.get('/api/merchant/orders', { headers: merchant.headers })).body.find((o) => o.id === order.body.id);
  assert.equal(merchantView.customer.firstName, 'Juan');
  assert.equal(merchantView.deliveryPin, undefined);

  const ds = await socketFor(driver);
  const offerP = waitFor(ds, 'trip:offer', (o) => o.service === 'food');
  const accepted = await api.post(`/api/merchant/orders/${order.body.id}/accept`, { prepMinutes: 5 }, { headers: merchant.headers });
  assert.equal(accepted.body.status, 'accepted');
  const offer = await offerP;
  assert.equal(offer.food.payMerchantCents, q.body.subtotalCents);
  assert.equal(offer.collectCents, q.body.totalCents);

  const trip = await api.post(`/api/trips/${offer.tripId}/accept`, {}, { token: driver.token });
  assert.equal(trip.body.service, 'food');
  assert.equal(trip.body.payMerchantCents, q.body.subtotalCents);
  await api.post(`/api/trips/${offer.tripId}/arrived`, {}, { token: driver.token });
  const notReady = await api.post(`/api/trips/${offer.tripId}/start`, {}, { token: driver.token });
  assert.equal(notReady.body.error.code, 'ORDER_NOT_READY');
  await api.post(`/api/merchant/orders/${order.body.id}/ready`, {}, { headers: merchant.headers });
  const picked = await api.post(`/api/trips/${offer.tripId}/start`, {}, { token: driver.token });
  assert.equal(picked.body.status, 'in_progress');

  const customerOrder = await api.get(`/api/orders/${order.body.id}`, { token: customer.token });
  assert.equal(customerOrder.body.status, 'picked_up');
  assert.match(customerOrder.body.deliveryPin, /^\d{4}$/);
  assert.equal(customerOrder.body.driver.plate, driver.plate);
  assert.equal((await api.post(`/api/trips/${offer.tripId}/cancel`, {}, { token: customer.token })).body.error.code, 'FOOD_CANCEL');

  const done = await api.post(`/api/trips/${offer.tripId}/complete`, { pin: customerOrder.body.deliveryPin }, { token: driver.token });
  assert.equal(done.status, 200);
  const final = await api.get(`/api/orders/${order.body.id}`, { token: customer.token });
  assert.equal(final.body.status, 'delivered');
  const ledger = await api.get('/api/merchant/ledger', { headers: merchant.headers });
  assert.equal(ledger.body.owedCents, Math.round(q.body.subtotalCents * 0.12), 'comisión del local (12%) registrada');
  await assert.rejects(srv.ctx.db.query('DELETE FROM merchant_ledger'), /solo-anexar/);

  const finance = await adminSession(api, srv, 'finance');
  const paid = await api.post(`/api/admin/merchants/${merchant.id}/payments`, { amountCents: ledger.body.owedCents, note: 'Transferencia' }, { headers: finance.headers });
  assert.equal(paid.body.owedCents, 0);
  await offline(driver);
});

test('delivery: el local que no responde rechaza el pedido automáticamente y el cliente puede cancelar antes', async () => {
  const merchant = await approvedOpenMerchant();
  const customer = await signup(api, srv);
  const items = [{ itemId: merchant.items.encebollado.id, qty: 1 }];
  const q1 = await api.post('/api/orders/quote', { merchantId: merchant.id, items, destination: HOME, destinationLabel: 'Casa' }, { token: customer.token });
  const o1 = await api.post('/api/orders', { quoteId: q1.body.quoteId }, { token: customer.token });
  const cancelled = await api.post(`/api/orders/${o1.body.id}/cancel`, {}, { token: customer.token });
  assert.equal(cancelled.body.status, 'cancelled');

  const q2 = await api.post('/api/orders/quote', { merchantId: merchant.id, items, destination: HOME, destinationLabel: 'Casa' }, { token: customer.token });
  const o2 = await api.post('/api/orders', { quoteId: q2.body.quoteId }, { token: customer.token });
  await srv.ctx.db.query(`UPDATE orders SET placed_at = now() - interval '30 minutes' WHERE id = $1`, [o2.body.id]);
  await srv.ctx.services.orders.sweep();
  const after = await api.get(`/api/orders/${o2.body.id}`, { token: customer.token });
  assert.equal(after.body.status, 'rejected');
  assert.equal(after.body.statusReason, 'sin_respuesta_del_local');

  await api.put('/api/merchant/store', { isOpen: false }, { headers: merchant.headers });
  const closed = await api.post('/api/orders/quote', { merchantId: merchant.id, items, destination: HOME, destinationLabel: 'Casa' }, { token: customer.token });
  assert.equal(closed.body.error.code, 'MERCHANT_CLOSED');
});
