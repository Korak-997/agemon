import { baseRateCents } from "../catalog/rates.js";
import { surchargesFor } from "../catalog/surcharges.js";
import { zoneForPostcode } from "../catalog/zones.js";
import { sumCents } from "../util/money.js";
import { discountCents } from "./discounts.js";
import { taxOn } from "./tax.js";

export function quoteParcel(parcel, postcode, tier) {
  const baseCents = baseRateCents(zoneForPostcode(postcode), parcel.weightKg);
  const surcharges = surchargesFor(parcel, postcode);
  const surchargeCents = sumCents(surcharges.map((entry) => entry.cents));
  const discount = discountCents(baseCents + surchargeCents, tier);
  const netCents = baseCents + surchargeCents - discount;
  const taxCents = taxOn(netCents);
  return {
    baseCents,
    surcharges,
    surchargeCents,
    discountCents: discount,
    netCents,
    taxCents,
    totalCents: netCents + taxCents,
  };
}
