const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Ecuador continental (con margen). Rechaza coordenadas absurdas o falsas.
export const ECUADOR_BBOX = Object.freeze({ minLat: -5.1, maxLat: 1.7, minLng: -81.2, maxLng: -75.1 });

export function inBbox({ lat, lng }, bbox = ECUADOR_BBOX) {
  return lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
}

/** Punto WKT para PostGIS (lng lat). */
export const toWkt = ({ lat, lng }) => `SRID=4326;POINT(${Number(lng)} ${Number(lat)})`;

/** Coordenadas compactas: enteros con 5 decimales (~1.1 m de precisión). */
export const E5 = 1e5;
export const encodeE5 = (v) => Math.round(v * E5);
export const decodeE5 = (v) => v / E5;
