import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  PUBLIC_BASE_URL: z.url(),
  APP_DEEP_LINK: z.string().default('ubermart://'),

  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  // Clave maestra de 32 bytes (base64). De ella se derivan (HKDF) las claves de
  // cifrado de datos personales, índices ciegos, OTP y archivos.
  APP_MASTER_KEY: z.string().min(40),
  // Clave privada Ed25519 en PEM (PKCS8) codificada en base64 para firmar JWT.
  JWT_PRIVATE_KEY: z.string().min(40),

  STORAGE_DIR: z.string().default('./storage'),

  SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_FROM: optionalString,

  PAYPHONE_API_BASE: z.url().default('https://pay.payphonetodoesposible.com'),
  PAYPHONE_TOKEN: optionalString,
  PAYPHONE_STORE_ID: optionalString,
  PAYPHONE_NOTIFY_SECRET: optionalString,

  OPENWEATHER_API_KEY: optionalString,
  WEATHER_LAT: z.coerce.number().default(-0.9536),
  WEATHER_LNG: z.coerce.number().default(-80.7286),

  OSRM_URL: optionalString,
  GEOCODER_URL: optionalString,

  COOKIE_SECURE: bool.default(true),
  RATE_LIMIT_SCALE: z.coerce.number().min(1).max(1000).default(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${detail}`);
  }
  const e = parsed.data;

  const masterKey = Buffer.from(e.APP_MASTER_KEY, 'base64');
  if (masterKey.length !== 32) {
    throw new Error('APP_MASTER_KEY debe ser exactamente 32 bytes en base64 (usa npm run gen:secrets)');
  }

  let jwtPrivateKey;
  try {
    const pem = Buffer.from(e.JWT_PRIVATE_KEY, 'base64').toString('utf8');
    jwtPrivateKey = createPrivateKey(pem);
  } catch {
    throw new Error('JWT_PRIVATE_KEY no es un PEM válido codificado en base64');
  }
  if (jwtPrivateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('JWT_PRIVATE_KEY debe ser una clave Ed25519');
  }

  const isProd = e.NODE_ENV === 'production';
  if (isProd) {
    const problems = [];
    if (!e.PUBLIC_BASE_URL.startsWith('https://')) problems.push('PUBLIC_BASE_URL debe usar https');
    if (e.SMS_PROVIDER === 'console') problems.push('SMS_PROVIDER=console no está permitido en producción');
    if (!e.COOKIE_SECURE) problems.push('COOKIE_SECURE debe ser true en producción');
    if (e.RATE_LIMIT_SCALE !== 1) problems.push('RATE_LIMIT_SCALE debe ser 1 en producción');
    if (e.PAYPHONE_TOKEN && (!e.PAYPHONE_NOTIFY_SECRET || e.PAYPHONE_NOTIFY_SECRET.length < 32)) {
      problems.push('PAYPHONE_NOTIFY_SECRET (>=32 caracteres) es obligatorio si Payphone está activo');
    }
    if (problems.length) throw new Error(`Configuración insegura para producción: ${problems.join('; ')}`);
  }
  if (e.SMS_PROVIDER === 'twilio' && !(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM)) {
    throw new Error('SMS_PROVIDER=twilio requiere TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y TWILIO_FROM');
  }

  return Object.freeze({
    env: e.NODE_ENV,
    isProd,
    isTest: e.NODE_ENV === 'test',
    port: e.PORT,
    host: e.HOST,
    trustProxy: e.TRUST_PROXY,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    appDeepLink: e.APP_DEEP_LINK,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    masterKey,
    jwtPrivateKey,
    storageDir: e.STORAGE_DIR,
    sms: {
      provider: e.SMS_PROVIDER,
      twilioSid: e.TWILIO_ACCOUNT_SID,
      twilioToken: e.TWILIO_AUTH_TOKEN,
      twilioFrom: e.TWILIO_FROM,
    },
    payphone: {
      apiBase: e.PAYPHONE_API_BASE.replace(/\/+$/, ''),
      token: e.PAYPHONE_TOKEN,
      storeId: e.PAYPHONE_STORE_ID,
      notifySecret: e.PAYPHONE_NOTIFY_SECRET,
      enabled: Boolean(e.PAYPHONE_TOKEN && e.PAYPHONE_STORE_ID),
    },
    weather: { apiKey: e.OPENWEATHER_API_KEY, lat: e.WEATHER_LAT, lng: e.WEATHER_LNG },
    osrmUrl: e.OSRM_URL?.replace(/\/+$/, ''),
    geocoderUrl: e.GEOCODER_URL?.replace(/\/+$/, ''),
    cookieSecure: e.COOKIE_SECURE,
    rateLimitScale: e.RATE_LIMIT_SCALE,
    logLevel: e.LOG_LEVEL,
  });
}
