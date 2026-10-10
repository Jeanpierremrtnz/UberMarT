import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFare, roundToStep, surgeFromDemand, timeRuleMultiplier } from '../../src/services/pricing-engine.js';
import { SETTINGS_DEFAULTS } from '../../src/services/settings.service.js';
import { isModerateOrHeavyRain } from '../../src/services/weather.service.js';
import { LocationGuard, parseLocationPacket } from '../../src/realtime/location-guard.js';
import { ecuadorLocalTime } from '../../src/lib/time.js';

const pricing = SETTINGS_DEFAULTS.pricing;
const rules = [{ name: 'Entrada a trabajos y colegios', isoDays: [1, 2, 3, 4, 5], startLocal: '07:15', endLocal: '08:15', multiplier: 1.2, isActive: true }];

test('fórmula base: Base + km×costo + min×costo, redondeo a $0.05', () => {
  // 5 km, 12 min: 40 + 125 + 60 = 225
  const f = computeFare({ distanceM: 5000, durationS: 720, pricing });
  assert.equal(f.totalCents, 225);
  assert.equal(f.breakdown.multiplier, 1);
  assert.equal(roundToStep(227, 5), 225);
  assert.equal(roundToStep(228, 5), 230);
});

test('tarifa mínima y recargo fijo por lluvia (+$0.50) visible en el desglose', () => {
  const short = computeFare({ distanceM: 800, durationS: 180, pricing });
  assert.equal(short.totalCents, 100);
  assert.equal(short.breakdown.minFareApplied, true);
  const rain = computeFare({ distanceM: 5000, durationS: 720, pricing, raining: true });
  assert.equal(rain.totalCents, 275);
  assert.equal(rain.breakdown.rainSurchargeCents, 50);
});

test('multiplicadores: se aplica el mayor (no se acumulan) y respeta el tope', () => {
  const both = computeFare({ distanceM: 5000, durationS: 720, pricing, zoneMultiplier: 1.5, timeMultiplier: 1.2 });
  assert.equal(both.breakdown.multiplier, 1.5);
  assert.equal(both.breakdown.multiplierSource, 'zona');
  assert.equal(both.totalCents, roundToStep(225 * 1.5, 5));
  const capped = computeFare({ distanceM: 5000, durationS: 720, pricing: { ...pricing, maxMultiplier: 1.3 }, zoneMultiplier: 3 });
  assert.equal(capped.breakdown.multiplier, 1.3);
});

test('zona caliente: 20 solicitudes y 3 motos en Barbasquillo activa 1.5x', () => {
  const cfg = SETTINGS_DEFAULTS.surge;
  assert.equal(surgeFromDemand({ demand: 20, supply: 3 }, cfg, 1.5), 1.5);
  assert.equal(surgeFromDemand({ demand: 6, supply: 3 }, cfg, 1.5), 1.2);
  assert.equal(surgeFromDemand({ demand: 4, supply: 4 }, cfg, 1.5), 1);
  assert.equal(surgeFromDemand({ demand: 3, supply: 0 }, cfg, 1.5), 1, 'demanda mínima evita picos por ruido');
  assert.equal(surgeFromDemand({ demand: 50, supply: 1 }, cfg, 1.3), 1.3, 'tope por zona');
});

test('regla horaria L-V 07:15-08:15 en hora de Ecuador (UTC-5)', () => {
  // Lunes 2026-10-12 12:30 UTC = 07:30 en Manta
  const monday = ecuadorLocalTime(new Date('2026-10-12T12:30:00Z'));
  assert.deepEqual(monday, { isoWeekday: 1, minuteOfDay: 450 });
  assert.equal(timeRuleMultiplier(rules, monday).multiplier, 1.2);
  assert.equal(timeRuleMultiplier(rules, ecuadorLocalTime(new Date('2026-10-12T13:15:00Z'))).multiplier, 1, '08:15 ya no aplica');
  assert.equal(timeRuleMultiplier(rules, ecuadorLocalTime(new Date('2026-10-17T12:30:00Z'))).multiplier, 1, 'sábado');
});

test('clima: solo lluvia moderada/fuerte o tormenta activa el recargo', () => {
  assert.equal(isModerateOrHeavyRain({ weather: [{ id: 500 }] }), false, 'lluvia ligera');
  assert.equal(isModerateOrHeavyRain({ weather: [{ id: 501 }] }), true);
  assert.equal(isModerateOrHeavyRain({ weather: [{ id: 211 }] }), true);
  assert.equal(isModerateOrHeavyRain({ weather: [{ id: 800 }], rain: { '1h': 3.1 } }), true);
  assert.equal(isModerateOrHeavyRain({ weather: [{ id: 803 }] }), false);
});

test('GPS: paquete compacto válido y rechazo de basura', () => {
  assert.deepEqual(parseLocationPacket([-95021, -807312, 182, 34, 0]), { lat: -95021 / 1e5, lng: -807312 / 1e5, heading: 182, speedKmh: 34, mocked: false });
  assert.equal(parseLocationPacket([-95021.5, -807312, 0, 0]), null);
  assert.equal(parseLocationPacket(['1', 2, 3, 4]), null);
  assert.equal(parseLocationPacket([1, 2, 400, 4]), null);
  assert.equal(parseLocationPacket({ lat: 1 }), null);
  assert.equal(JSON.stringify([-95021, -807312, 182, 34, 0]).length < 40, true, 'paquete ultraligero');
});

test('GPS: el servidor descarta envíos muy seguidos y saltos imposibles', () => {
  const g = new LocationGuard({ minIntervalMs: 2000, maxSpeedKmh: 140, maxRejections: 3 });
  const t0 = 1_000_000;
  const a = { lat: -0.95, lng: -80.73 };
  assert.equal(g.check('d1', a, t0).ok, true);
  assert.equal(g.check('d1', a, t0 + 500).reason, 'too_frequent');
  assert.equal(g.check('d1', { lat: -0.9501, lng: -80.7301 }, t0 + 5000).ok, true, '~15 m en 5 s');
  const far = { lat: -0.85, lng: -80.73 }; // ~11 km en 5 s
  assert.equal(g.check('d1', far, t0 + 10_000).reason, 'implausible_speed');
  assert.equal(g.check('d1', far, t0 + 15_000).reason, 'implausible_speed');
  const third = g.check('d1', far, t0 + 20_000);
  assert.equal(third.ok, true, 'tras varios saltos consecutivos se re-ancla');
  assert.equal(third.anomaly, 'repeated_jump');
});
