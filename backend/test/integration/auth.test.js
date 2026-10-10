import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client, makeCedula, nextPhone, signup } from '../helpers.js';

let srv;
let api;
before(async () => {
  srv = await bootServer();
  api = client(srv.url);
});
after(() => srv?.close());

const lastCode = () => /(\d{6})/.exec(srv.ctx.services.sms.outbox.at(-1).body)[1];

test('OTP: solo celulares de Ecuador, código de un solo uso y límite de intentos', async () => {
  assert.equal((await api.post('/api/auth/otp/request', { phone: '+15551234567' })).status, 400);
  const phone = nextPhone();
  const r = await api.post('/api/auth/otp/request', { phone });
  assert.equal(r.status, 200);
  const code = lastCode();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) {
    const bad = await api.post('/api/auth/otp/verify', { challengeId: r.body.challengeId, code: wrong, deviceId: 'device-12345678' });
    assert.equal(bad.status, 401);
  }
  const locked = await api.post('/api/auth/otp/verify', { challengeId: r.body.challengeId, code, deviceId: 'device-12345678' });
  assert.equal(locked.status, 429, 'tras 5 fallos el código queda bloqueado aunque sea correcto');

  const r2 = await api.post('/api/auth/otp/request', { phone });
  const ok = await api.post('/api/auth/otp/verify', { challengeId: r2.body.challengeId, code: lastCode(), deviceId: 'device-12345678' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.accessToken && ok.body.refreshToken);
  assert.equal(ok.body.user.profileComplete, false);
  const reuse = await api.post('/api/auth/otp/verify', { challengeId: r2.body.challengeId, code: lastCode(), deviceId: 'device-12345678' });
  assert.equal(reuse.status, 401, 'un código no se puede usar dos veces');

  await api.post('/api/auth/otp/request', { phone });
  const fourth = await api.post('/api/auth/otp/request', { phone });
  assert.equal(fourth.status, 429, 'máximo 3 SMS cada 15 minutos por número');
});

test('refresh: rotación de tokens y revocación total si se reutiliza uno viejo', async () => {
  const u = await signup(api, srv, { profile: false });
  const r1 = await api.post('/api/auth/refresh', { refreshToken: u.refreshToken, deviceId: u.deviceId });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refreshToken, u.refreshToken);

  const replay = await api.post('/api/auth/refresh', { refreshToken: u.refreshToken, deviceId: u.deviceId });
  assert.equal(replay.status, 401, 'token viejo reutilizado = posible robo');
  const afterTheft = await api.post('/api/auth/refresh', { refreshToken: r1.body.refreshToken, deviceId: u.deviceId });
  assert.equal(afterTheft.status, 401, 'toda la familia de sesiones queda revocada');
  const me = await api.get('/api/me', { token: r1.body.accessToken });
  assert.equal(me.status, 401, 'el access token de una sesión revocada deja de servir');
});

test('refresh desde otro dispositivo es rechazado', async () => {
  const u = await signup(api, srv, { profile: false });
  const r = await api.post('/api/auth/refresh', { refreshToken: u.refreshToken, deviceId: 'otro-dispositivo-999' });
  assert.equal(r.status, 401);
});

test('JWT alterado o ausente es rechazado', async () => {
  const u = await signup(api, srv, { profile: false });
  assert.equal((await api.get('/api/me')).status, 401);
  const [h, p, s] = u.token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  payload.sub = '00000000-0000-0000-0000-000000000000';
  const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
  assert.equal((await api.get('/api/me', { token: forged })).status, 401);
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`;
  assert.equal((await api.get('/api/me', { token: none })).status, 401);
});

test('registro de pasajero: cédula válida, única, cifrada y bloqueada tras registrarse', async () => {
  const u = await signup(api, srv, { profile: false });
  const quote = await api.post('/api/trips/quote', { origin: { lat: -0.95, lng: -80.73 }, destination: { lat: -0.96, lng: -80.71 } }, { token: u.token });
  assert.equal(quote.status, 403, 'no puede pedir viajes sin perfil completo');
  assert.equal(quote.body.error.code, 'PROFILE_INCOMPLETE');

  assert.equal((await api.put('/api/me/profile', { fullName: 'Ana Mero', cedula: '1710034066' }, { token: u.token })).status, 400);
  const cedula = makeCedula(424242);
  const ok = await api.put('/api/me/profile', { fullName: 'Ana Mero', cedula }, { token: u.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cedulaMasked, `${cedula.slice(0, 2)}******${cedula.slice(-2)}`);

  const row = await srv.ctx.db.one('SELECT cedula_enc FROM users WHERE id = $1', [u.id]);
  assert.equal(row.cedula_enc.includes(Buffer.from(cedula)), false, 'la cédula nunca se guarda en texto plano');

  const other = await signup(api, srv, { profile: false });
  const dup = await api.put('/api/me/profile', { fullName: 'Otra Persona', cedula }, { token: other.token });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'CEDULA_IN_USE');

  const change = await api.put('/api/me/profile', { fullName: 'Ana Mero', cedula: makeCedula(515151) }, { token: u.token });
  assert.equal(change.body.error.code, 'CEDULA_LOCKED');
});

test('contactos de emergencia: máximo 3', async () => {
  const u = await signup(api, srv);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await api.post('/api/me/emergency-contacts', { name: `Contacto ${i}`, phone: nextPhone() }, { token: u.token })).status, 201);
  }
  assert.equal((await api.post('/api/me/emergency-contacts', { name: 'Cuarto', phone: nextPhone() }, { token: u.token })).status, 409);
});

test('cabeceras de seguridad y errores sin filtrar detalles internos', async () => {
  const res = await api.get('/api/no-existe');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const bad = await api.post('/api/auth/otp/request', undefined, { headers: { 'Content-Type': 'application/json' }, form: '{malformado' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'JSON_INVALID');
});
