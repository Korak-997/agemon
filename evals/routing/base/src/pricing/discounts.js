import { percentOf } from "../util/money.js";

const DISCOUNT_PERCENT_BY_TIER = { standard: 0, silver: 5, gold: 12 };

export function discountCents(eligibleCents, tier) {
  const percent = DISCOUNT_PERCENT_BY_TIER[tier];
  if (percent === undefined) throw new Error(`unknown tier ${tier}`);
  return percentOf(eligibleCents, percent);
}
