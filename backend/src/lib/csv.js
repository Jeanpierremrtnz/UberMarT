/** Parser CSV mínimo (RFC 4180): comillas, comillas escapadas y saltos de línea en campos. */
export function parseCsv(text, maxRows = 5000) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [';', ',', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best, ',');

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field.trim());
      if (row.some((f) => f !== '')) rows.push(row);
      if (rows.length > maxRows) throw new Error(`El archivo supera ${maxRows} filas`);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field.trim());
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/**
 * Convierte montos de estados de cuenta a centavos: "1.234,56", "1,234.56",
 * "$ 25.00", "25". Devuelve null para débitos (negativos) o valores inválidos.
 */
export function parseAmountToCents(value) {
  let s = String(value ?? '').replace(/USD|\$|\s/gi, '');
  if (!s || s.startsWith('-') || /^\(.*\)$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    s = s.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma !== -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot !== -1 && !/\.\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents > 0 ? cents : null;
}
