import { createPublicKey, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { blindIndex, decryptString, encrypt, hmac, randomDigits, randomToken, safeEqual } from '../lib/crypto.js';
import { isValidCedula, normalizeEcMobile } from '../lib/ecuador.js';
import { HttpError, badRequest, conflict, forbidden, isUniqueViolation, tooMany, unauthorized } from '../lib/errors.js';

const ISSUER = 'ubermart-api';
const AUDIENCE = 'ubermart-app';
const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_DAYS = 30;
const OTP_TTL_SEC = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_PER_15_MIN = 3;
const OTP_PER_DAY = 8;
const MAX_EMERGENCY_CONTACTS = 3;

export function createAuthService({ db, config, keys, sms, audit }) {
  const publicKey = createPublicKey(config.jwtPrivateKey);

  const signAccess = (userId, sessionId) =>
    new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${ACCESS_TTL_SEC}s`)
      .sign(config.jwtPrivateKey);

  async function issueTokens(client, userId, deviceId, familyId = randomUUID()) {
    const refreshToken = randomToken(32);
    await client.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, device_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
      [userId, familyId, hmac(keys.tokens, refreshToken), deviceId, REFRESH_TTL_DAYS],
    );
    return { accessToken: await signAccess(userId, familyId), refreshToken, expiresIn: ACCESS_TTL_SEC };
  }

  const revokeFamily = (client, familyId) =>
    client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [familyId]);

  return {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, publicKey, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['EdDSA'] });
        if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
        return payload;
      } catch {
        return null;
      }
    },

    /** Carga el usuario del token y confirma que la sesión no fue revocada. */
    async loadSessionUser(payload) {
      return db.one(
        `SELECT u.id, u.status, u.full_name, (u.cedula_bidx IS NOT NULL) AS has_cedula, d.kyc_status
           FROM users u LEFT JOIN drivers d ON d.user_id = u.id
          WHERE u.id = $1
            AND EXISTS (SELECT 1 FROM refresh_tokens r
                         WHERE r.family_id = $2 AND r.user_id = u.id AND r.revoked_at IS NULL AND r.expires_at > now())`,
        [payload.sub, payload.sid],
      );
    },

    async requestOtp({ phone, ip, purpose = 'login' }) {
      const normalized = normalizeEcMobile(phone);
      if (!normalized) throw badRequest('PHONE_INVALID', 'Ingresa un número de celular ecuatoriano válido');
      const counts = await db.one(
        `SELECT count(*) FILTER (WHERE created_at > now() - interval '15 minutes')::int AS recent, count(*)::int AS daily
           FROM otp_challenges WHERE phone = $1 AND created_at > now() - interval '24 hours'`,
        [normalized],
      );
      if (counts.recent >= OTP_PER_15_MIN || counts.daily >= OTP_PER_DAY) {
        throw tooMany('Solicitaste demasiados códigos. Intenta más tarde.');
      }
      const id = randomUUID();
      const code = randomDigits(6);
      await db.query(
        `INSERT INTO otp_challenges (id, phone, code_hash, ip, expires_at, purpose)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6)`,
        [id, normalized, hmac(keys.otp, `${id}:${code}`), ip, OTP_TTL_SEC, purpose],
      );
      const what = purpose === 'merchant_signup' ? 'para registrar tu local' : '';
      await sms.send(normalized, `UberMarT: tu codigo ${what ? `${what} ` : ''}es ${code}. No lo compartas con nadie. Vence en 5 minutos.`);
      return { challengeId: id, expiresInSec: OTP_TTL_SEC };
    },

    /**
     * Verifica un código sin consumirlo (registro de locales). Los intentos
     * fallidos se guardan aunque el resto del registro falle después.
     */
    async checkOtp({ challengeId, code, purpose }) {
      const outcome = await db.tx(async (c) => {
        const { rows } = await c.query(
          `SELECT id, phone, code_hash, attempts, consumed_at, expires_at < now() AS expired
             FROM otp_challenges WHERE id = $1 AND purpose = $2 FOR UPDATE`,
          [challengeId, purpose],
        );
        const ch = rows[0];
        if (!ch || ch.consumed_at || ch.expired) return { error: 'invalid' };
        if (ch.attempts >= OTP_MAX_ATTEMPTS) return { error: 'locked' };
        if (!safeEqual(hmac(keys.otp, `${ch.id}:${code}`), ch.code_hash)) {
          await c.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
          return { error: 'invalid' };
        }
        return { phone: ch.phone };
      });
      if (outcome.error === 'invalid') throw new HttpError(401, 'OTP_INVALID', 'Código incorrecto o vencido');
      if (outcome.error === 'locked') throw tooMany('Demasiados intentos. Solicita un código nuevo.');
      return outcome.phone;
    },

    async verifyOtp({ challengeId, code, deviceId, ip }) {
      const outcome = await db.tx(async (c) => {
        const { rows } = await c.query(
          `SELECT id, phone, code_hash, attempts, consumed_at, expires_at < now() AS expired
             FROM otp_challenges WHERE id = $1 AND purpose = 'login' FOR UPDATE`,
          [challengeId],
        );
        const ch = rows[0];
        if (!ch || ch.consumed_at || ch.expired) return { error: 'invalid' };
        if (ch.attempts >= OTP_MAX_ATTEMPTS) return { error: 'locked' };
        if (!safeEqual(hmac(keys.otp, `${ch.id}:${code}`), ch.code_hash)) {
          await c.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
          return { error: 'invalid' };
        }
        await c.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [ch.id]);
        const { rows: urows } = await c.query(
          `INSERT INTO users (phone) VALUES ($1)
           ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
           RETURNING id, status, full_name, (cedula_bidx IS NOT NULL) AS has_cedula, (xmax = 0) AS created`,
          [ch.phone],
        );
        const user = urows[0];
        if (user.status !== 'active') return { error: 'suspended' };
        const tokens = await issueTokens(c, user.id, deviceId);
        await audit.log({ actorType: 'user', actorId: user.id, action: user.created ? 'auth.signup' : 'auth.login', ip }, c);
        return { user, tokens };
      });
      if (outcome.error === 'invalid') throw new HttpError(401, 'OTP_INVALID', 'Código incorrecto o vencido');
      if (outcome.error === 'locked') throw tooMany('Demasiados intentos. Solicita un código nuevo.');
      if (outcome.error === 'suspended') throw forbidden('Tu cuenta está suspendida. Contacta a soporte.');
      return {
        ...outcome.tokens,
        user: { id: outcome.user.id, profileComplete: Boolean(outcome.user.full_name && outcome.user.has_cedula) },
      };
    },

    async refresh({ refreshToken, deviceId, ip }) {
      const outcome = await db.tx(async (c) => {
        const { rows } = await c.query(
          `SELECT r.*, r.expires_at < now() AS expired, u.status
             FROM refresh_tokens r JOIN users u ON u.id = r.user_id
            WHERE r.token_hash = $1 FOR UPDATE OF r`,
          [hmac(keys.tokens, refreshToken)],
        );
        const row = rows[0];
        if (!row) return { error: 'invalid' };
        if (row.revoked_at || row.used_at || row.device_id !== deviceId) {
          // Reutilización o uso desde otro dispositivo: posible robo de token.
          await revokeFamily(c, row.family_id);
          await audit.log({ actorType: 'system', action: 'auth.refresh_reuse_detected', targetType: 'user', targetId: row.user_id, ip }, c);
          return { error: 'invalid' };
        }
        if (row.expired) return { error: 'invalid' };
        if (row.status !== 'active') {
          await revokeFamily(c, row.family_id);
          return { error: 'suspended' };
        }
        await c.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [row.id]);
        return { tokens: await issueTokens(c, row.user_id, deviceId, row.family_id) };
      });
      if (outcome.error === 'suspended') throw forbidden('Tu cuenta está suspendida. Contacta a soporte.');
      if (outcome.error) throw unauthorized('Sesión inválida, vuelve a iniciar sesión');
      return outcome.tokens;
    },

    async logout({ refreshToken }) {
      const row = await db.one('SELECT family_id FROM refresh_tokens WHERE token_hash = $1', [hmac(keys.tokens, refreshToken)]);
      if (row) await revokeFamily(db, row.family_id);
    },

    async revokeAllSessions(userId) {
      await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    },

    async getProfile(userId) {
      const u = await db.one(
        `SELECT u.id, u.phone, u.full_name, u.email, u.cedula_enc, u.rating_sum, u.rating_count, d.kyc_status
           FROM users u LEFT JOIN drivers d ON d.user_id = u.id WHERE u.id = $1`,
        [userId],
      );
      const cedula = u.cedula_enc ? decryptString(keys.data, u.cedula_enc, `users.cedula:${u.id}`) : null;
      return {
        id: u.id,
        phone: u.phone,
        fullName: u.full_name,
        email: u.email,
        cedulaMasked: cedula ? `${cedula.slice(0, 2)}******${cedula.slice(-2)}` : null,
        profileComplete: Boolean(u.full_name && cedula),
        rating: u.rating_count ? Math.round((u.rating_sum / u.rating_count) * 100) / 100 : null,
        driverStatus: u.kyc_status ?? null,
      };
    },

    async updateProfile(userId, { fullName, cedula, email }, { ip }) {
      if (!isValidCedula(cedula)) throw badRequest('CEDULA_INVALID', 'El número de cédula no es válido');
      const current = await db.one(
        `SELECT u.cedula_bidx, d.kyc_status FROM users u LEFT JOIN drivers d ON d.user_id = u.id WHERE u.id = $1`,
        [userId],
      );
      const bidx = blindIndex(keys.blindIndex, cedula);
      if (current.cedula_bidx && current.cedula_bidx !== bidx) {
        throw conflict('CEDULA_LOCKED', 'La cédula ya registrada no puede cambiarse. Contacta a soporte.');
      }
      if (['submitted', 'approved'].includes(current.kyc_status)) {
        throw conflict('PROFILE_LOCKED', 'Tus datos están verificados; para cambiarlos contacta a soporte.');
      }
      try {
        await db.query(
          `UPDATE users SET full_name = $2, email = $3,
                  cedula_enc = COALESCE(cedula_enc, $4), cedula_bidx = COALESCE(cedula_bidx, $5)
            WHERE id = $1`,
          [userId, fullName, email ?? null, encrypt(keys.data, cedula, `users.cedula:${userId}`), bidx],
        );
      } catch (err) {
        if (isUniqueViolation(err, 'users_cedula_bidx_key')) {
          throw conflict('CEDULA_IN_USE', 'Esta cédula ya está registrada en otra cuenta');
        }
        throw err;
      }
      await audit.log({ actorType: 'user', actorId: userId, action: 'profile.update', ip });
      return this.getProfile(userId);
    },

    async listEmergencyContacts(userId) {
      const { rows } = await db.query(
        'SELECT id, name, phone FROM emergency_contacts WHERE user_id = $1 ORDER BY created_at',
        [userId],
      );
      return rows;
    },

    async addEmergencyContact(userId, { name, phone }) {
      const normalized = normalizeEcMobile(phone);
      if (!normalized) throw badRequest('PHONE_INVALID', 'Número de contacto inválido');
      const { rows } = await db.query(
        `INSERT INTO emergency_contacts (user_id, name, phone)
         SELECT $1, $2, $3 WHERE (SELECT count(*) FROM emergency_contacts WHERE user_id = $1) < $4
         ON CONFLICT (user_id, phone) DO NOTHING
         RETURNING id, name, phone`,
        [userId, name, normalized, MAX_EMERGENCY_CONTACTS],
      );
      if (!rows[0]) throw conflict('CONTACTS_LIMIT', `Máximo ${MAX_EMERGENCY_CONTACTS} contactos (o el número ya existe)`);
      return rows[0];
    },

    async removeEmergencyContact(userId, contactId) {
      await db.query('DELETE FROM emergency_contacts WHERE id = $1 AND user_id = $2', [contactId, userId]);
    },
  };
}
