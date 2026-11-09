const RATES_BY_ZONE = {
  A: { firstKgCents: 500, nextKgCents: 120 },
  B: { firstKgCents: 620, nextKgCents: 140 },
  C: { firstKgCents: 750, nextKgCents: 170 },
  D: { firstKgCents: 980, nextKgCents: 220 },
};

export function baseRateCents(zone, weightKg) {
  const rate = RATES_BY_ZONE[zone];
  const chargeableExtraKg = Math.max(0, Math.ceil(weightKg - 1));
  return rate.firstKgCents + chargeableExtraKg * rate.nextKgCents;
}
