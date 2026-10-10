import { Server } from 'socket.io';
import { inBbox } from '../lib/geo.js';
import { LocationGuard, parseLocationPacket } from './location-guard.js';

const OFFLINE_GRACE_MS = 90_000;
const EVENTS_PER_WINDOW = 40;
const WINDOW_MS = 10_000;
const ANOMALY_LOG_EVERY_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Canal WebSocket (Socket.io) para el rastreo GPS en tiempo real.
 * - Solo transporte WebSocket (sin long-polling): menos datos y batería.
 * - Autenticación con el JWT de acceso en el handshake; la conexión se cierra
 *   cuando el token vence y la app reconecta con uno nuevo.
 * - Límite de eventos por socket y tamaño máximo de mensaje de 2 KB.
 */
export function attachSocketServer(httpServer, { services, realtime, db, audit, logger, guardOptions }) {
  const io = new Server(httpServer, {
    path: '/ws',
    serveClient: false,
    transports: ['websocket'],
    maxHttpBufferSize: 2048,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
    cors: { origin: false },
  });
  realtime.attach(io);

  const guard = new LocationGuard(guardOptions);
  const driverSockets = new Map();
  const offlineTimers = new Map();
  const lastAnomalyAt = new Map();

  async function recordAnomaly(driverId, kind, details) {
    const now = Date.now();
    if (now - (lastAnomalyAt.get(driverId) ?? 0) < ANOMALY_LOG_EVERY_MS) return;
    lastAnomalyAt.set(driverId, now);
    await db.query('UPDATE drivers SET gps_anomalies = gps_anomalies + 1 WHERE user_id = $1', [driverId]);
    await audit.log({ actorType: 'system', action: `driver.gps_${kind}`, targetType: 'driver', targetId: driverId, details });
  }

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || token.length > 2048) return next(new Error('unauthorized'));
      const payload = await services.auth.verifyAccessToken(token);
      const user = payload && (await services.auth.loadSessionUser(payload));
      if (!user || user.status !== 'active') return next(new Error('unauthorized'));
      socket.data.userId = user.id;
      socket.data.isDriver = user.kyc_status === 'approved';
      socket.data.exp = payload.exp;
      return next();
    } catch (err) {
      logger.error({ err }, 'Error autenticando socket');
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, isDriver } = socket.data;
    socket.join(`u:${userId}`);

    const expTimer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.exp * 1000 - Date.now()));
    let windowStart = Date.now();
    let count = 0;
    socket.use((_packet, next) => {
      const now = Date.now();
      if (now - windowStart > WINDOW_MS) {
        windowStart = now;
        count = 0;
      }
      count += 1;
      if (count > EVENTS_PER_WINDOW) {
        socket.disconnect(true);
        return next(new Error('rate_limited'));
      }
      return next();
    });

    socket.on('trip:watch', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const tripId = payload?.tripId;
        if (typeof tripId !== 'string' || !UUID.test(tripId)) return reply({ ok: false });
        if (!(await services.trips.canWatch({ tripId, userId }))) return reply({ ok: false });
        for (const room of socket.rooms) if (room.startsWith('trip:')) socket.leave(room);
        socket.join(`trip:${tripId}`);
        return reply({ ok: true });
      } catch (err) {
        logger.error({ err }, 'trip:watch falló');
        return reply({ ok: false });
      }
    });

    if (isDriver) {
      driverSockets.set(userId, (driverSockets.get(userId) ?? 0) + 1);
      clearTimeout(offlineTimers.get(userId));
      offlineTimers.delete(userId);

      socket.on('loc', async (packet) => {
        try {
          const p = parseLocationPacket(packet);
          if (!p || !inBbox(p)) return;
          if (p.mocked) {
            await recordAnomaly(userId, 'mock_location', null);
            return;
          }
          const verdict = guard.check(userId, p);
          if (!verdict.ok) {
            if (verdict.reason === 'implausible_speed') await recordAnomaly(userId, 'implausible_speed', { kmh: verdict.kmh });
            return;
          }
          if (verdict.anomaly) await recordAnomaly(userId, verdict.anomaly, null);
          await services.trips.ingestLocation(userId, p);
        } catch (err) {
          logger.error({ err }, 'Error procesando ubicación');
        }
      });
    }

    socket.on('disconnect', () => {
      clearTimeout(expTimer);
      if (!isDriver) return;
      const remaining = (driverSockets.get(userId) ?? 1) - 1;
      if (remaining > 0) {
        driverSockets.set(userId, remaining);
        return;
      }
      driverSockets.delete(userId);
      // Si no vuelve a conectarse en 90 s se le marca fuera de línea (salvo viaje activo).
      offlineTimers.set(
        userId,
        setTimeout(() => {
          offlineTimers.delete(userId);
          guard.forget(userId);
          db.query(
            `UPDATE drivers SET is_online = false WHERE user_id = $1 AND NOT EXISTS (
               SELECT 1 FROM trips WHERE driver_id = $1 AND status IN ('accepted', 'arrived', 'in_progress'))`,
            [userId],
          ).catch((err) => logger.error({ err }, 'No se pudo marcar offline'));
        }, OFFLINE_GRACE_MS).unref(),
      );
    });
  });

  return {
    io,
    close: () =>
      new Promise((resolve) => {
        for (const t of offlineTimers.values()) clearTimeout(t);
        io.close(() => resolve());
      }),
  };
}
