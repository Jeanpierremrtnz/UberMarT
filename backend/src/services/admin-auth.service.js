import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { decryptString, encrypt, hmac, randomToken } from '../lib/crypto.js';
import { HttpError, badRequest, unauthorized } from '../lib/errors.js';
import { generateTotpSecret, totpUri, verifyTotp } from '../lib/totp.js';

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 };
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const SESSION_IDLE_MINUTES = 30;
const SESSION_MAX_HOURS = 8;

export const ADMIN_PERMISSIONS = Object.freeze({
  'topups.review': ['owner', 'finance'],
  'bank.import': ['owner', 'finance'],
  'wallet.read': ['owner', 'finance'],
  'drivers.review': ['owner', 'operations'],
  'users.manage': ['owner', 'operations'],
  'incidents.manage': ['owner', 'operations'],
  'settings.read': ['owner', 'finance', 'operations'],
  'settings.write': ['owner'],
});

export const hasPermission = (role, permission) => ADMIN_PERMISSIONS[permission]?.includes(role) ?? false;

export function validateAdminPassword(password) {
  const p = String(password ?? '');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (p.length < 12 || p.length > 128 || classes < 3) {
    throw badRequest('WEAK_PASSWORD', 'La contraseña debe tener 12+ caracteres y combinar mayúsculas, minúsculas, números o símbolos');
  }
}

export function createAdminAuthService({ db, keys, audit }) {
  let dummyHash;
  const totpAad = (adminId) => `admins.totp:${adminId}`;
  const sessionHash = (token) => hmac(keys.tokens, `admin:${token}`);

  return {
    async createAdmin({ email, fullName, password, role }) {
      validateAdminPassword(password);
      if (!['owner', 'finance', 'operations'].includes(role)) throw badRequest('ROLE_INVALID', 'Rol inválido');
      const id = randomUUID();
      const totpSecret = generateTotpSecret();
      await db.query(
        `INSERT INTO admins (id, email, full_name, password_hash, totp_secret_enc, role)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, email, fullName, await argon2.hash(password, ARGON2_OPTIONS), encrypt(keys.data, totpSecret, totpAad(id)), role],
      );
      await audit.log({ actorType: 'system', action: 'admin.create', targetType: 'admin', targetId: id, details: { email, role } });
      return { id, totpSecret, totpUri: totpUri({ secret: totpSecret, account: email }) };
    },

    async login({ email, password, totp, ip, userAgent }) {
      const admin = await db.one('SELECT * FROM admins WHERE email = $1', [String(email ?? '').trim()]);
      if (!admin || !admin.is_active) {
        // Igualar el tiempo de respuesta para no revelar qué correos existen.
        dummyHash ??= await argon2.hash(randomToken(16), ARGON2_OPTIONS);
        await argon2.verify(dummyHash, String(password ?? ''));
        throw unauthorized('Credenciales inválidas');
      }
      if (admin.locked_until && admin.locked_until > new Date()) {
        throw new HttpError(423, 'ACCOUNT_LOCKED', 'Cuenta bloqueada temporalmente por intentos fallidos');
      }
      const passwordOk = await argon2.verify(admin.password_hash, String(password ?? ''));
      const step = passwordOk
        ? verifyTotp(decryptString(keys.data, admin.totp_secret_enc, totpAad(admin.id)), totp, { lastUsedStep: admin.totp_last_step })
        : null;

      if (!step) {
        await db.query(
          `UPDATE admins SET failed_logins = failed_logins + 1,
                  locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1`,
          [admin.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
        );
        await audit.log({ actorType: 'admin', actorId: admin.id, action: 'admin.login_failed', ip, details: { passwordOk } });
        throw unauthorized('Credenciales inválidas');
      }

      const token = randomToken(32);
      const csrfToken = randomToken(24);
      const ok = await db.tx(async (c) => {
        // El paso TOTP solo puede usarse una vez (anti-replay), de forma atómica.
        const { rowCount } = await c.query(
          `UPDATE admins SET failed_logins = 0, locked_until = NULL, totp_last_step = $2, last_login_at = now()
            WHERE id = $1 AND totp_last_step < $2`,
          [admin.id, step],
        );
        if (!rowCount) return false;
        await c.query(
          `INSERT INTO admin_sessions (admin_id, token_hash, csrf_token, ip, user_agent, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
          [admin.id, sessionHash(token), csrfToken, ip, String(userAgent ?? '').slice(0, 300), SESSION_MAX_HOURS],
        );
        await audit.log({ actorType: 'admin', actorId: admin.id, action: 'admin.login', ip }, c);
        return true;
      });
      if (!ok) throw unauthorized('Credenciales inválidas');
      return {
        token,
        csrfToken,
        maxAgeSec: SESSION_MAX_HOURS * 3600,
        admin: { id: admin.id, email: admin.email, fullName: admin.full_name, role: admin.role },
      };
    },

    async authenticate(token) {
      if (!token || token.length > 100) return null;
      const s = await db.one(
        `SELECT s.id AS session_id, s.csrf_token, s.last_seen_at < now() - interval '1 minute' AS stale,
                a.id, a.email, a.full_name, a.role
           FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
            AND s.last_seen_at > now() - make_interval(mins => $2) AND a.is_active`,
        [sessionHash(token), SESSION_IDLE_MINUTES],
      );
      if (!s) return null;
      if (s.stale) await db.query('UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1', [s.session_id]);
      return { id: s.id, email: s.email, fullName: s.full_name, role: s.role, sessionId: s.session_id, csrfToken: s.csrf_token };
    },

    async logout(token) {
      await db.query('UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1', [sessionHash(token)]);
    },
  };
}
