import {
  GIRTH_LIMIT_CM,
  INSURANCE_RATE_PERCENT,
  INSURANCE_THRESHOLD_CENTS,
  OVERSIZE_FEE_CENTS,
  REMOTE_FEE_CENTS,
} from "../config.js";
import { percentOf } from "../util/money.js";
import { isRemotePostcode } from "./zones.js";

export function exceedsGirthLimit(parcel) {
  const [longest, middle, shortest] = [
    parcel.lengthCm,
    parcel.widthCm,
    parcel.heightCm,
  ].sort((a, b) => b - a);
  return longest + 2 * (middle + shortest) > GIRTH_LIMIT_CM;
}

function insuranceCents(declaredValueCents) {
  const insuredExcess = declaredValueCents - INSURANCE_THRESHOLD_CENTS;
  return insuredExcess > 0 ? percentOf(insuredExcess, INSURANCE_RATE_PERCENT) : 0;
}

export function surchargesFor(parcel, postcode) {
  const surcharges = [];
  if (exceedsGirthLimit(parcel)) {
    surcharges.push({ code: "oversize", cents: OVERSIZE_FEE_CENTS });
  }
  if (isRemotePostcode(postcode)) {
    surcharges.push({ code: "remote", cents: REMOTE_FEE_CENTS });
  }
  const insurance = insuranceCents(parcel.declaredValueCents);
  if (insurance > 0) surcharges.push({ code: "insurance", cents: insurance });
  return surcharges;
}
