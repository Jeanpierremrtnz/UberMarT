// Validaciones de datos propios de Ecuador.

/**
 * Valida una cédula ecuatoriana (persona natural) con el algoritmo módulo 10
 * del Registro Civil: provincia 01-24 (o 30 para ecuatorianos en el exterior),
 * tercer dígito < 6 y dígito verificador correcto.
 */
export function isValidCedula(value) {
  const c = String(value ?? '').trim();
  if (!/^[0-9]{10}$/.test(c)) return false;
  const province = Number(c.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  if (Number(c[2]) >= 6) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let n = Number(c[i]) * (i % 2 === 0 ? 2 : 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(c[9]);
}

/**
 * Normaliza un celular ecuatoriano a E.164 (+5939XXXXXXXX). Acepta
 * 0991234567, 991234567, 593991234567 y +593991234567. Devuelve null si no es
 * un celular válido.
 */
export function normalizeEcMobile(value) {
  const digits = String(value ?? '').replace(/[\s\-().]/g, '');
  let m;
  if ((m = /^\+?593(9[0-9]{8})$/.exec(digits))) return `+593${m[1]}`;
  if ((m = /^0?(9[0-9]{8})$/.exec(digits))) return `+593${m[1]}`;
  return null;
}

/** Enmascara un teléfono para mostrarlo sin exponerlo completo. */
export function maskPhone(e164) {
  if (!e164) return null;
  return `${e164.slice(0, 5)}****${e164.slice(-3)}`;
}

/**
 * Placas de moto en Ecuador: formato vigente AA123A; se aceptan también
 * formatos anteriores de 2-3 letras y 3-4 dígitos. El panel revisa la matrícula.
 */
export function normalizePlate(value) {
  const p = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z]{2,3}[0-9]{3,4}[A-Z]?$/.test(p) ? p : null;
}

/**
 * Normaliza el número de referencia/secuencial de un comprobante para que el
 * mismo comprobante no pueda registrarse dos veces con variaciones de formato
 * (espacios, guiones, minúsculas o ceros a la izquierda).
 */
export function normalizeReference(value) {
  const r = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
  return r.length >= 4 && r.length <= 40 ? r : null;
}

export const BANKS = Object.freeze({
  pichincha: 'Banco Pichincha',
  deuna: 'Deuna',
  guayaquil: 'Banco Guayaquil',
  pacifico: 'Banco del Pacífico',
  produbanco: 'Produbanco',
  bolivariano: 'Banco Bolivariano',
  internacional: 'Banco Internacional',
  jep: 'Cooperativa JEP',
  otro: 'Otro',
});

/**
 * RUC ecuatoriano (13 dígitos). Persona natural: cédula válida + establecimiento
 * (001..). Sociedades privadas (tercer dígito 9) y entidades públicas (6): se
 * valida la estructura; el número exacto se confirma con el certificado del SRI
 * durante la revisión del panel.
 */
export function isValidRuc(value) {
  const r = String(value ?? '').trim();
  if (!/^[0-9]{13}$/.test(r)) return false;
  const province = Number(r.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  const third = Number(r[2]);
  if (third < 6) return isValidCedula(r.slice(0, 10)) && r.slice(10) !== '000';
  if (third === 9) return r.slice(10) !== '000';
  if (third === 6) return r.slice(9) !== '0000';
  return false;
}
