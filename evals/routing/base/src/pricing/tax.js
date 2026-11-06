import { TAX_RATE_PERCENT } from "../config.js";
import { percentOf } from "../util/money.js";

export function taxOn(netCents) {
  return percentOf(netCents, TAX_RATE_PERCENT);
}
