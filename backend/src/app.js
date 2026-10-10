import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { createDb } from './db.js';
import { createLogger } from './logger.js';
import { deriveKeys } from './lib/crypto.js';
import { createEncryptedStorage } from './lib/storage.js';
import { createRealtimeBus } from './realtime/bus.js';
import { createAuditService } from './services/audit.service.js';
import { createSettingsService } from './services/settings.service.js';
import { createSmsService } from './services/sms.service.js';
import { createAuthService } from './services/auth.service.js';
import { createAdminAuthService } from './services/admin-auth.service.js';
import { createWalletService } from './services/wallet.service.js';
import { createPayphoneService } from './services/payphone.service.js';
import { createTopupService } from './services/topup.service.js';
import { createWeatherService } from './services/weather.service.js';
import { createRoutingService } from './services/routing.service.js';
import { createPricingService } from './services/pricing.service.js';
import { createTripService } from './services/trip.service.js';
import { createDriverService } from './services/driver.service.js';
import { createSafetyService } from './services/safety.service.js';
import { createGeoService } from './services/geo.service.js';
import { errorHandler, limiter, requestContext } from './http/middleware.js';
import { appRoutes } from './http/app-routes.js';
import { adminRoutes } from './http/admin-routes.js';
import { publicRoutes } from './http/public-routes.js';

const ADMIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'admin');

/** Construye todas las dependencias. `overrides.fetch` permite simular APIs externas en pruebas. */
export function createContext(config, overrides = {}) {
  const logger = overrides.logger ?? createLogger({ level: config.isTest ? 'silent' : config.logLevel });
  const fetchImpl = overrides.fetch ?? fetch;
  const db = createDb({ connectionString: config.databaseUrl, max: config.dbPoolMax, logger });
  const keys = deriveKeys(config.masterKey);
  const realtime = createRealtimeBus();
  const activeTrips = new Map();

  const audit = createAuditService({ db, logger });
  const settings = createSettingsService({ db, audit });
  const storage = createEncryptedStorage({ rootDir: config.storageDir, key: keys.files });
  const sms = createSmsService({ config, logger });
  const auth = createAuthService({ db, config, keys, sms, audit });
  const adminAuth = createAdminAuthService({ db, keys, audit });
  const wallet = createWalletService({ db, settings });
  const payphone = createPayphoneService({ config, logger, fetchImpl });
  const topups = createTopupService({ db, storage, wallet, settings, audit, realtime, payphone, config, logger });
  const weather = createWeatherService({ config, settings, logger, fetchImpl });
  const routing = createRoutingService({ config, logger, fetchImpl });
  const pricing = createPricingService({ db, settings, weather, routing });
  const trips = createTripService({ db, settings, wallet, realtime, audit, activeTrips, config, logger });
  const drivers = createDriverService({ db, keys, storage, settings, audit, realtime });
  const safety = createSafetyService({ db, sms, realtime, audit, trips, logger });
  const geo = createGeoService({ config, logger, fetchImpl });

  return {
    config,
    logger,
    db,
    keys,
    realtime,
    activeTrips,
    services: { audit, settings, sms, auth, adminAuth, wallet, payphone, topups, weather, routing, pricing, trips, drivers, safety, geo },
  };
}

export function createApp(ctx) {
  const { config, logger } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use(requestContext(logger));
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: config.isProd ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use((_req, res, next) => {
    res.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', limiter({ windowMs: 60_000, limit: 600, scale: config.rateLimitScale }));
  app.use('/api/admin/bank-statements', express.json({ limit: '2100kb' }));
  app.use(express.json({ limit: '32kb' }));

  app.use(publicRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));
  app.use('/api', appRoutes(ctx));
  app.use('/admin', express.static(ADMIN_DIR, { index: 'index.html', dotfiles: 'deny', fallthrough: true, maxAge: config.isProd ? '1h' : 0 }));

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No encontrado' } }));
  app.use(errorHandler(logger));
  return app;
}
