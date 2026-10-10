// Motor de tarifas puro (sin E/S) para poder probarlo y auditarlo fácilmente.
//
//   Tarifa = max(Mínima, (Base + CostoKm × Km + CostoMin × Min) × Multiplicador) + RecargoLluvia
//
// - El multiplicador es el MAYOR entre el de zona caliente y el horario (no se
//   multiplican entre sí) y nunca supera el tope global: precios predecibles.
// - El recargo por lluvia es un valor fijo y visible en el desglose.
// - Todo se calcula en centavos y se redondea al paso configurado ($0.05).

import { parseClock } from '../lib/time.js';

export function roundToStep(cents, step) {
  return Math.round(cents / step) * step;
}

export function surgeFromDemand({ demand, supply }, { minDemand, tiers }, zoneMax = 3) {
  if (demand < minDemand) return 1;
  const ratio = demand / Math.max(supply, 1);
  let m = 1;
  for (const tier of tiers) if (ratio >= tier.ratio) m = tier.multiplier;
  return Math.min(m, zoneMax);
}

export function timeRuleMultiplier(rules, { isoWeekday, minuteOfDay }) {
  let best = 1;
  let matched = null;
  for (const r of rules) {
    if (!r.isActive || !r.isoDays.includes(isoWeekday)) continue;
    if (minuteOfDay >= parseClock(r.startLocal) && minuteOfDay < parseClock(r.endLocal) && r.multiplier > best) {
      best = r.multiplier;
      matched = r.name;
    }
  }
  return { multiplier: best, rule: matched };
}

export function computeFare({ distanceM, durationS, pricing, zoneMultiplier = 1, timeMultiplier = 1, raining = false }) {
  const km = distanceM / 1000;
  const minutes = durationS / 60;
  const base = pricing.baseCents;
  const distance = pricing.perKmCents * km;
  const time = pricing.perMinCents * minutes;
  const subtotal = base + distance + time;
  const multiplier = Math.min(pricing.maxMultiplier, Math.max(1, zoneMultiplier, timeMultiplier));
  const dynamic = Math.max(pricing.minFareCents, subtotal * multiplier);
  const rain = raining ? pricing.rainSurchargeCents : 0;
  const total = Math.max(pricing.roundingStepCents, roundToStep(dynamic + rain, pricing.roundingStepCents));
  return {
    totalCents: total,
    breakdown: {
      baseCents: base,
      distanceCents: Math.round(distance),
      timeCents: Math.round(time),
      subtotalCents: Math.round(subtotal),
      multiplier: Math.round(multiplier * 100) / 100,
      multiplierSource: multiplier <= 1 ? null : zoneMultiplier >= timeMultiplier ? 'zona' : 'horario',
      minFareApplied: subtotal * multiplier < pricing.minFareCents,
      rainSurchargeCents: rain,
      km: Math.round(km * 100) / 100,
      minutes: Math.round(minutes * 10) / 10,
    },
  };
}
