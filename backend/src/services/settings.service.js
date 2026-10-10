import { z } from 'zod';

const cents = z.number().int().min(0).max(100_000);
const multiplier = z.number().min(1).max(3);

// Valores iniciales para Manta (ajustables en el panel sin redesplegar).
export const SETTINGS_SCHEMAS = {
  pricing: z.object({
    baseCents: cents,
    perKmCents: cents,
    perMinCents: cents,
    minFareCents: cents,
    rainSurchargeCents: cents,
    roundingStepCents: z.number().int().min(1).max(100),
    maxMultiplier: multiplier,
    durationFactor: z.number().min(0.3).max(2),
    quoteTtlSec: z.number().int().min(60).max(1800),
    minTripMeters: z.number().int().min(0).max(5000),
    maxTripMeters: z.number().int().min(1000).max(200_000),
  }),
  surge: z.object({
    windowMin: z.number().int().min(1).max(60),
    minDemand: z.number().int().min(1).max(100),
    tiers: z
      .array(z.object({ ratio: z.number().min(1).max(50), multiplier }))
      .max(5)
      .refine((t) => t.every((x, i) => i === 0 || (x.ratio > t[i - 1].ratio && x.multiplier >= t[i - 1].multiplier)), {
        message: 'Los niveles deben estar ordenados por ratio y multiplicador ascendente',
      }),
  }),
  wallet: z.object({
    commissionBps: z.number().int().min(0).max(5000),
    minBalanceCents: z.number().int().min(0).max(10_000),
    topupMinCents: z.number().int().min(100).max(50_000),
    topupMaxCents: z.number().int().min(100).max(50_000),
    maxPendingTopups: z.number().int().min(1).max(10),
    maxResubmissions: z.number().int().min(0).max(5),
  }),
  dispatch: z.object({
    radiiMeters: z.array(z.number().int().min(300).max(20_000)).min(1).max(5),
    offerTimeoutSec: z.number().int().min(8).max(60),
    maxDriversPerRound: z.number().int().min(1).max(20),
    locationMaxAgeSec: z.number().int().min(15).max(600),
    arrivalRadiusMeters: z.number().int().min(50).max(2000),
  }),
  weather: z.object({
    mode: z.enum(['auto', 'force_rain', 'force_dry']),
  }),
  topupAccounts: z
    .array(
      z.object({
        bank: z.string().min(2).max(40),
        accountType: z.enum(['ahorros', 'corriente', 'deuna']),
        number: z.string().min(4).max(30),
        holder: z.string().min(3).max(80),
        idNumber: z.string().min(10).max(13),
      }),
    )
    .max(5),
};

export const SETTINGS_DEFAULTS = Object.freeze({
  pricing: {
    baseCents: 40,
    perKmCents: 25,
    perMinCents: 5,
    minFareCents: 100,
    rainSurchargeCents: 50,
    roundingStepCents: 5,
    maxMultiplier: 2,
    durationFactor: 0.9,
    quoteTtlSec: 300,
    minTripMeters: 300,
    maxTripMeters: 40_000,
  },
  surge: {
    windowMin: 10,
    minDemand: 4,
    tiers: [
      { ratio: 2, multiplier: 1.2 },
      { ratio: 4, multiplier: 1.5 },
    ],
  },
  wallet: {
    commissionBps: 1000,
    minBalanceCents: 100,
    topupMinCents: 100,
    topupMaxCents: 20_000,
    maxPendingTopups: 3,
    maxResubmissions: 2,
  },
  dispatch: {
    radiiMeters: [2500, 4000, 6000],
    offerTimeoutSec: 20,
    maxDriversPerRound: 5,
    locationMaxAgeSec: 120,
    arrivalRadiusMeters: 300,
  },
  weather: { mode: 'auto' },
  topupAccounts: [],
});

export function createSettingsService({ db, audit }) {
  const cache = new Map();
  const TTL_MS = 15_000;

  async function get(key) {
    if (!SETTINGS_SCHEMAS[key]) throw new Error(`setting desconocido: ${key}`);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const row = await db.one('SELECT value FROM settings WHERE key = $1', [key]);
    const value = row ? row.value : structuredClone(SETTINGS_DEFAULTS[key]);
    cache.set(key, { value, expires: Date.now() + TTL_MS });
    return value;
  }

  async function set(key, input, { adminId, ip }) {
    const schema = SETTINGS_SCHEMAS[key];
    if (!schema) throw new Error(`setting desconocido: ${key}`);
    const value = schema.parse(input);
    if (key === 'wallet' && value.topupMinCents > value.topupMaxCents) {
      throw new z.ZodError([{ code: 'custom', path: ['topupMinCents'], message: 'Debe ser <= topupMaxCents', input }]);
    }
    await db.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), adminId],
    );
    cache.delete(key);
    await audit.log({ actorType: 'admin', actorId: adminId, action: `settings.${key}.update`, targetType: 'settings', targetId: key, ip, details: value });
    return value;
  }

  return { get, set, clearCache: () => cache.clear() };
}
