import { HARD_LENGTH_LIMIT_CM, HARD_WEIGHT_LIMIT_KG } from "../config.js";
import { invalidOrder } from "../util/errors.js";

export function isOversized(parcel) {
  return (
    parcel.weightKg > HARD_WEIGHT_LIMIT_KG ||
    Math.max(parcel.lengthCm, parcel.widthCm, parcel.heightCm) > HARD_LENGTH_LIMIT_CM
  );
}

export function validateParcels(parcels) {
  if (parcels.length === 0) throw invalidOrder("an order needs a parcel");
  for (const parcel of parcels) {
    if (parcel.weightKg <= 0) throw invalidOrder("weight must be positive");
    if (isOversized(parcel)) throw invalidOrder("parcel exceeds the depot limits");
  }
}
