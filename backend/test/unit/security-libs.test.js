import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { blindIndex, decrypt, deriveKeys, encrypt, safeEqual } from '../../src/lib/crypto.js';
import { base32Decode, base32Encode, hotp, verifyTotp } from '../../src/lib/totp.js';
import { isValidCedula, normalizeEcMobile, normalizePlate, normalizeReference } from '../../src/lib/ecuador.js';
import { parseAmountToCents, parseCsv } from '../../src/lib/csv.js';
import { makeCedula } from '../helpers.js';

test('AES-256-GCM cifra, descifra y detecta manipulación o cambio de contexto', () => {
  const keys = deriveKeys(randomBytes(32));
  const ct = encrypt(keys.data, '1312345678', 'users.cedula:abc');
  assert.equal(decrypt(keys.data, ct, 'users.cedula:abc').toString(), '1312345678');
  assert.throws(() => decrypt(keys.data, ct, 'users.cedula:otro'));
  const tampered = Buffer.from(ct);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decrypt(keys.data, tampered, 'users.cedula:abc'));
  assert.notDeepEqual(encrypt(keys.data, 'x'), encrypt(keys.data, 'x'), 'IV aleatorio');
});

test('las subclaves derivadas son independientes y el índice ciego es determinista', () => {
  const keys = deriveKeys(randomBytes(32));
  assert.notDeepEqual(keys.data, keys.blindIndex);
  assert.equal(blindIndex(keys.blindIndex, '123'), blindIndex(keys.blindIndex, '123'));
  assert.notEqual(blindIndex(keys.blindIndex, '123'), blindIndex(keys.blindIndex, '124'));
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('TOTP cumple los vectores del RFC 6238 (SHA1) y bloquea la reutilización', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(hotp(secret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(hotp(secret, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(hotp(secret, Math.floor(20000000000 / 30), 8), '65353130');
  const b32 = base32Encode(secret);
  assert.deepEqual(base32Decode(b32), secret);
  const now = 1_700_000_000_000;
  const code = hotp(secret, Math.floor(now / 30_000));
  const step = verifyTotp(b32, code, { nowMs: now });
  assert.ok(step);
  assert.equal(verifyTotp(b32, code, { nowMs: now, lastUsedStep: step }), null, 'mismo código no se acepta dos veces');
  assert.equal(verifyTotp(b32, '000000', { nowMs: now }), null);
  assert.equal(verifyTotp(b32, 'abc', { nowMs: now }), null);
});

test('cédula ecuatoriana: algoritmo módulo 10', () => {
  for (let i = 1; i < 50; i += 1) assert.equal(isValidCedula(makeCedula(i * 7919)), true);
  assert.equal(isValidCedula('1710034065'), true);
  assert.equal(isValidCedula('1710034066'), false, 'dígito verificador incorrecto');
  assert.equal(isValidCedula('9910034065'), false, 'provincia inexistente');
  assert.equal(isValidCedula('1790034065'), false, 'tercer dígito >= 6');
  assert.equal(isValidCedula('17100340'), false);
});

test('normalización de celular, placa y referencia bancaria', () => {
  for (const v of ['0991234567', '991234567', '+593991234567', '593 99 123 4567']) assert.equal(normalizeEcMobile(v), '+593991234567');
  assert.equal(normalizeEcMobile('022345678'), null, 'fijo no es celular');
  assert.equal(normalizeEcMobile('+15551234567'), null);
  assert.equal(normalizePlate('ma-123b'), 'MA123B');
  assert.equal(normalizePlate('123'), null);
  // Variantes del MISMO comprobante deben colisionar (antiduplicados).
  const variants = ['0012345678', '12345678', '12-345-678', ' 1234 5678 ', '0000012345678'];
  assert.equal(new Set(variants.map(normalizeReference)).size, 1);
  assert.equal(normalizeReference('12'), null);
  assert.equal(normalizeReference('a'.repeat(41)), null);
});

test('CSV de estados de cuenta y montos en distintos formatos', () => {
  const rows = parseCsv('Fecha;Referencia;Crédito\n2026-10-01;"0012345";"1.234,56"\n2026-10-02;999;10,00\n');
  assert.deepEqual(rows[1], ['2026-10-01', '0012345', '1.234,56']);
  assert.equal(parseAmountToCents('1.234,56'), 123456);
  assert.equal(parseAmountToCents('1,234.56'), 123456);
  assert.equal(parseAmountToCents('$ 25.00'), 2500);
  assert.equal(parseAmountToCents('10,5'), 1050);
  assert.equal(parseAmountToCents('25'), 2500);
  assert.equal(parseAmountToCents('-25.00'), null, 'débitos se ignoran');
  assert.equal(parseAmountToCents('abc'), null);
});
