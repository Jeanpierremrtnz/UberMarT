import { EventEmitter } from 'node:events';

/**
 * Punto único para emitir eventos en tiempo real:
 *  - apps (Socket.io): salas por usuario `u:<id>` y por viaje `trip:<id>`,
 *  - panel administrativo: Server-Sent Events (EventSource nativo del navegador).
 */
export function createRealtimeBus() {
  let io = null;
  const admin = new EventEmitter();
  admin.setMaxListeners(100);

  return {
    attach(server) {
      io = server;
    },
    toUser(userId, event, data) {
      io?.to(`u:${userId}`).emit(event, data);
    },
    toTrip(tripId, event, data) {
      // "volatile": si el cliente no está listo se descarta (una ubicación vieja no sirve).
      io?.to(`trip:${tripId}`).volatile.emit(event, data);
    },
    toAdmins(event, data) {
      admin.emit('event', { event, data });
    },
    onAdminEvent(listener) {
      admin.on('event', listener);
      return () => admin.off('event', listener);
    },
    disconnectUser(userId) {
      io?.in(`u:${userId}`).disconnectSockets(true);
    },
  };
}
