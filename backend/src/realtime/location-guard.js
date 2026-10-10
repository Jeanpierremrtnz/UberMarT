import { haversineMeters } from '../lib/geo.js';

/**
 * Filtro del lado del servidor para la ubicación de los conductores:
 *  - descarta envíos demasiado frecuentes (protege servidor y batería),
 *  - descarta saltos imposibles (GPS falso / "teletransporte"),
 *  - acepta un nuevo punto base si la referencia es vieja o si el "salto" se
 *    repite varias veces seguidas (p. ej. el GPS se recuperó tras un túnel).
 * La app ya filtra en el teléfono (5-8 s o 15 m); esto es la segunda barrera.
 */
export class LocationGuard {
  constructor({ minIntervalMs = 2000, maxSpeedKmh = 140, jumpToleranceM = 150, staleMs = 120_000, maxRejections = 3 } = {}) {
    Object.assign(this, { minIntervalMs, maxSpeedKmh, jumpToleranceM, staleMs, maxRejections });
    this.last = new Map();
  }

  check(driverId, point, nowMs = Date.now()) {
    const prev = this.last.get(driverId);
    if (prev) {
      const dt = nowMs - prev.t;
      if (dt < this.minIntervalMs) return { ok: false, reason: 'too_frequent' };
      if (dt < this.staleMs) {
        const meters = haversineMeters(prev, point);
        const kmh = (meters / (dt / 1000)) * 3.6;
        if (meters > this.jumpToleranceM && kmh > this.maxSpeedKmh) {
          prev.rejections = (prev.rejections ?? 0) + 1;
          if (prev.rejections < this.maxRejections) return { ok: false, reason: 'implausible_speed', kmh: Math.round(kmh) };
          this.last.set(driverId, { lat: point.lat, lng: point.lng, t: nowMs, rejections: 0 });
          return { ok: true, anomaly: 'repeated_jump' };
        }
      }
    }
    this.last.set(driverId, { lat: point.lat, lng: point.lng, t: nowMs, rejections: 0 });
    return { ok: true };
  }

  forget(driverId) {
    this.last.delete(driverId);
  }
}

/**
 * Paquete ultraligero enviado por la app del conductor:
 *   [latE5, lngE5, rumbo°, velocidadKmH, gpsSimulado(0|1)]
 * Ej: [-95021, -807312, 182, 34, 0]  (~30 bytes)
 */
export function parseLocationPacket(packet) {
  if (!Array.isArray(packet) || packet.length < 4 || packet.length > 5) return null;
  const [latE5, lngE5, heading, speed, mocked = 0] = packet;
  if (![latE5, lngE5, heading, speed, mocked].every(Number.isInteger)) return null;
  const lat = latE5 / 1e5;
  const lng = lngE5 / 1e5;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (heading < 0 || heading > 359 || speed < 0 || speed > 250) return null;
  return { lat, lng, heading, speedKmh: speed, mocked: mocked === 1 };
}
