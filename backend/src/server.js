import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createApp, createContext } from './app.js';
import { attachSocketServer } from './realtime/socket.js';

const SWEEP_INTERVAL_MS = 5000;

export async function startServer(config, overrides = {}) {
  const ctx = createContext(config, overrides);
  const app = createApp(ctx);
  const server = http.createServer(app);
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  const sockets = attachSocketServer(server, { ...ctx, audit: ctx.services.audit, guardOptions: overrides.guardOptions });
  await ctx.services.trips.loadActiveTrips();

  let sweeping = false;
  const sweeper = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await ctx.services.trips.sweep();
      await ctx.services.orders.sweep();
    } catch (err) {
      ctx.logger.error({ err }, 'Fallo en el despachador');
    } finally {
      sweeping = false;
    }
  }, overrides.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
  sweeper.unref();

  await new Promise((resolve) => server.listen(overrides.port ?? config.port, overrides.host ?? config.host, resolve));
  const { port } = server.address();
  ctx.logger.info({ port }, 'UberMarT API escuchando');

  async function close() {
    clearInterval(sweeper);
    await sockets.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    await ctx.db.close();
  }

  return { ctx, server, io: sockets.io, port, url: `http://127.0.0.1:${port}`, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const running = await startServer(config);
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    running.ctx.logger.info({ signal }, 'Cerrando servidor');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await running.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => running.ctx.logger.error({ err }, 'Promesa rechazada sin manejar'));
}
