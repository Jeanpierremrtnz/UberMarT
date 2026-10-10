import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { startServer } from '../src/server.js';
import { base32Decode, currentStep, hotp } from '../src/lib/totp.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://ubermart:devpass@127.0.0.1:5432/ubermart_test';

export async function testConfig(extra = {}) {
  const { privateKey } = generateKeyPairSync('ed25519');
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://127.0.0.1',
    DATABASE_URL: TEST_DB,
    APP_MASTER_KEY: randomBytes(32).toString('base64'),
    JWT_PRIVATE_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
    STORAGE_DIR: await mkdtemp(path.join(os.tmpdir(), 'umt-storage-')),
    COOKIE_SECURE: 'false',
    RATE_LIMIT_SCALE: '100',
    LOG_LEVEL: 'silent',
    ...extra,
  });
}

const TABLES = [
  'admins', 'admin_sessions', 'users', 'otp_challenges', 'refresh_tokens', 'emergency_contacts', 'drivers',
  'driver_documents', 'settings', 'wallets', 'wallet_entries', 'topups', 'bank_statement_lines', 'gateway_events',
  'fare_quotes', 'trips', 'trip_offers', 'trip_points', 'safety_incidents', 'audit_log',
];

export async function resetDb(db) {
  await db.query(`
    ALTER TABLE wallet_entries DISABLE TRIGGER USER;
    ALTER TABLE audit_log DISABLE TRIGGER USER;
    TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE;
    ALTER TABLE wallet_entries ENABLE TRIGGER USER;
    ALTER TABLE audit_log ENABLE TRIGGER USER;`);
}

/** Levanta la API completa contra la BD de pruebas. */
export async function bootServer({ env = {}, fetch: fetchImpl, guardOptions } = {}) {
  await migrate(TEST_DB, { log: () => {} });
  const config = await testConfig(env);
  const srv = await startServer(config, { port: 0, host: '127.0.0.1', fetch: fetchImpl, guardOptions, sweepIntervalMs: 60_000 });
  await resetDb(srv.ctx.db);
  return srv;
}

export function client(baseUrl) {
  async function call(method, url, { token, body, form, headers = {} } = {}) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  return {
    get: (url, o) => call('GET', url, o),
    post: (url, body, o = {}) => call('POST', url, { ...o, body }),
    put: (url, body, o = {}) => call('PUT', url, { ...o, body }),
    del: (url, o) => call('DELETE', url, o),
    postForm: (url, form, o = {}) => call('POST', url, { ...o, form }),
    putForm: (url, form, o = {}) => call('PUT', url, { ...o, form }),
  };
}

let phoneSeq = 0;
const cedulaBase = Number.parseInt(randomBytes(2).toString('hex'), 16) * 7;
export const nextPhone = () => `09${String(80000000 + (phoneSeq += 1)).padStart(8, '0')}`;

// Cédulas válidas (módulo 10) generadas para pruebas.
export function makeCedula(seed) {
  const body = `131${String(seed % 1_000_000).padStart(6, '0')}`;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let n = Number(body[i]) * (i % 2 === 0 ? 2 : 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return body + ((10 - (sum % 10)) % 10);
}

/** Crea un usuario vía OTP real y devuelve sus tokens. */
export async function signup(api, srv, { profile = true } = {}) {
  const phone = nextPhone();
  const req = await api.post('/api/auth/otp/request', { phone });
  const sms = srv.ctx.services.sms.outbox.at(-1).body;
  const code = /(\d{6})/.exec(sms)[1];
  const deviceId = `device-${randomBytes(6).toString('hex')}`;
  const ver = await api.post('/api/auth/otp/verify', { challengeId: req.body.challengeId, code, deviceId });
  const user = { phone, deviceId, token: ver.body.accessToken, refreshToken: ver.body.refreshToken, id: ver.body.user.id };
  if (profile) {
    const cedula = makeCedula(cedulaBase + (phoneSeq % 500_000));
    const r = await api.put('/api/me/profile', { fullName: 'Juan Pérez', cedula }, { token: user.token });
    if (r.status !== 200) throw new Error(`profile ${r.status} ${JSON.stringify(r.body)}`);
  }
  return user;
}

/** Crea un conductor aprobado con billetera (atajo directo en BD para pruebas). */
export async function approvedDriver(api, srv, { balanceCents = 0, location } = {}) {
  const u = await signup(api, srv);
  const plate = `MA${String(Math.floor(Math.random() * 900) + 100)}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;
  await srv.ctx.db.query(
    `INSERT INTO drivers (user_id, kyc_status, plate, moto_brand, moto_model, moto_color, license_expires_on)
     VALUES ($1, 'approved', $2, 'Honda', 'XR150', 'Rojo', now() + interval '1 year')`,
    [u.id, plate],
  );
  await srv.ctx.db.query('INSERT INTO wallets (driver_id, balance_cents) VALUES ($1, 0)', [u.id]);
  if (balanceCents) {
    await srv.ctx.db.tx((c) => srv.ctx.services.wallet.post(c, {
      driverId: u.id, amountCents: balanceCents, kind: 'adjustment', refType: 'test', refId: u.id,
    }));
  }
  if (location) {
    await srv.ctx.db.query(
      `UPDATE drivers SET location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, location_at = now() WHERE user_id = $1`,
      [u.id, location.lng, location.lat],
    );
  }
  return { ...u, plate };
}

export async function adminSession(api, srv, role = 'owner') {
  const email = `${role}-${randomBytes(4).toString('hex')}@ubermart.test`;
  const password = 'Clave-Segura-2026';
  const { totpSecret } = await srv.ctx.services.adminAuth.createAdmin({ email, fullName: `Admin ${role}`, password, role });
  const totp = hotp(base32Decode(totpSecret), currentStep());
  const res = await api.post('/api/admin/auth/login', { email, password, totp });
  if (res.status !== 200) throw new Error(`admin login ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { email, password, totpSecret, cookie, csrf: res.body.csrfToken, headers: { Cookie: cookie, 'X-CSRF-Token': res.body.csrfToken } };
}

/** Imagen única (ruido aleatorio) para simular la foto de un comprobante. */
export async function fakeImage({ width = 480, height = 720 } = {}) {
  const raw = randomBytes(width * height * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 70 }).toBuffer();
}

export function imageForm(fields, buffer, field = 'receipt') {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (buffer) form.append(field, new Blob([buffer], { type: 'image/jpeg' }), 'comprobante.jpg');
  return form;
}
