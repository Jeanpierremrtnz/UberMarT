import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './crypto.js';

// TOTP (RFC 6238) para el segundo factor obligatorio del panel administrativo.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Base32 inválido');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function hotp(secretBuf, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secretBuf).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

/**
 * Verifica un código con tolerancia de ±1 paso. Devuelve el paso usado (para
 * impedir reutilizar el mismo código: protección anti-replay) o null.
 */
export function verifyTotp(secretBase32, code, { nowMs = Date.now(), window = 1, lastUsedStep = 0 } = {}) {
  if (!/^[0-9]{6}$/.test(String(code))) return null;
  const secret = base32Decode(secretBase32);
  const now = currentStep(nowMs);
  for (let w = -window; w <= window; w += 1) {
    const step = now + w;
    if (step <= lastUsedStep) continue;
    if (safeEqual(hotp(secret, step), String(code))) return step;
  }
  return null;
}

export function totpUri({ secret, account, issuer = 'UberMarT Admin' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
