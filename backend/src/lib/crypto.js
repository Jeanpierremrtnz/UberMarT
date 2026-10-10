import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Deriva claves independientes a partir de la clave maestra. Si una subclave
 * se filtra, no compromete a las demás.
 */
export function deriveKeys(masterKey) {
  const derive = (info) => Buffer.from(hkdfSync('sha256', masterKey, 'ubermart.v1', info, 32));
  return Object.freeze({
    data: derive('data-encryption'),
    files: derive('file-encryption'),
    blindIndex: derive('blind-index'),
    otp: derive('otp-pepper'),
    tokens: derive('token-hashing'),
  });
}

/**
 * AES-256-GCM. Formato: [versión(1)][iv(12)][tag(16)][ciphertext].
 * `aad` amarra el cifrado a su contexto (p. ej. id del registro) para que un
 * texto cifrado no pueda copiarse a otra fila.
 */
export function encrypt(key, plaintext, aad) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function decrypt(key, payload, aad) {
  if (!Buffer.isBuffer(payload) || payload.length < 1 + IV_LEN + TAG_LEN || payload[0] !== VERSION) {
    throw new Error('Payload cifrado inválido');
  }
  const iv = payload.subarray(1, 1 + IV_LEN);
  const tag = payload.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = payload.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export const decryptString = (key, payload, aad) => decrypt(key, payload, aad).toString('utf8');

/** Índice ciego: permite buscar/unicidad sobre un dato cifrado sin descifrarlo. */
export function blindIndex(key, value) {
  return createHmac('sha256', key).update(String(value)).digest('base64url');
}

export function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest('base64url');
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function randomDigits(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String(randomInt(0, 10));
  return out;
}

/** Comparación en tiempo constante (evita ataques de temporización). */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}
