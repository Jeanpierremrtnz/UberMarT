import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import { safeEqual } from '../lib/crypto.js';
import { HttpError, forbidden, unauthorized } from '../lib/errors.js';
import { hasPermission } from '../services/admin-auth.service.js';

export const ADMIN_COOKIE_SECURE = '__Host-umt_admin';
export const ADMIN_COOKIE_DEV = 'umt_admin';
export const MERCHANT_COOKIE_SECURE = '__Host-umt_comercio';
export const MERCHANT_COOKIE_DEV = 'umt_comercio';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const name = part.slice(0, idx).trim();
    if (!(name in out)) out[name] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function requestContext(logger) {
  return (req, res, next) => {
    req.id = randomUUID();
    res.set('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info({
        reqId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        ip: req.ip,
      }, 'http');
    });
    next();
  };
}

export function limiter({ windowMs, limit, scale = 1, key }) {
  return rateLimit({
    windowMs,
    limit: limit * scale,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(key ? { keyGenerator: key } : {}),
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes, espera un momento' } });
    },
  });
}

/** Autenticación de las apps: JWT EdDSA + verificación de sesión/estado en BD en cada request. */
export function requireUser(auth) {
  return async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) throw unauthorized();
    const payload = await auth.verifyAccessToken(header.slice(7));
    if (!payload) throw unauthorized('Token inválido o vencido');
    const user = await auth.loadSessionUser(payload);
    if (!user) throw unauthorized('Sesión cerrada');
    if (user.status !== 'active') throw forbidden('Tu cuenta está suspendida');
    req.user = { id: user.id, fullName: user.full_name, hasCedula: user.has_cedula, driverStatus: user.kyc_status };
    next();
  };
}

export function requireProfile(req, _res, next) {
  if (!req.user.fullName || !req.user.hasCedula) {
    throw new HttpError(403, 'PROFILE_INCOMPLETE', 'Completa tu nombre y cédula para continuar');
  }
  next();
}

export function requireApprovedDriver(req, _res, next) {
  if (req.user.driverStatus !== 'approved') throw new HttpError(403, 'DRIVER_NOT_APPROVED', 'Tu cuenta de conductor no está aprobada');
  next();
}

/** Sesión del panel por cookie HttpOnly + token CSRF obligatorio en toda escritura. */
export function requireAdmin(adminAuth, cookieName, permission) {
  return async (req, _res, next) => {
    const token = parseCookies(req.get('cookie'))[cookieName];
    const admin = await adminAuth.authenticate(token);
    if (!admin) throw unauthorized('Sesión del panel vencida');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !safeEqual(req.get('x-csrf-token'), admin.csrfToken)) {
      throw forbidden('Token CSRF inválido');
    }
    if (permission && !hasPermission(admin.role, permission)) throw forbidden('Tu rol no tiene acceso a esta acción');
    req.admin = admin;
    req.adminToken = token;
    next();
  };
}

/** Sesión del panel de locales: solo cuentas de rol 'merchant', limitadas a su propio local. */
export function requireMerchant(adminAuth, cookieName) {
  return async (req, _res, next) => {
    const token = parseCookies(req.get('cookie'))[cookieName];
    const user = await adminAuth.authenticate(token, 'merchant');
    if (!user) throw unauthorized('Sesión vencida, ingresa de nuevo');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !safeEqual(req.get('x-csrf-token'), user.csrfToken)) {
      throw forbidden('Token CSRF inválido');
    }
    req.merchantUser = user;
    req.merchantId = user.merchantId;
    req.merchantToken = token;
    next();
  };
}

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8, fieldSize: 512, parts: 10 },
  // El tipo real se verifica por contenido al re-codificar la imagen (lib/images.js).
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype) || file.mimetype === 'application/octet-stream'),
});

export const singleImage = (field) => uploader.single(field);

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'Datos inválidos',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: { code: 'UPLOAD_INVALID', message: status === 413 ? 'Archivo demasiado grande (máx. 8 MB)' : 'Archivo inválido' } });
    }
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Solicitud demasiado grande' } });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'JSON_INVALID', message: 'JSON inválido' } });
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    logger.error({ err, reqId: req.id }, 'Error no controlado');
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Error interno', requestId: req.id } });
  };
}
