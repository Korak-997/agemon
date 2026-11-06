import { RETURN_WINDOW_DAYS } from "../config.js";

export function refundShare(daysSinceDelivery) {
  if (daysSinceDelivery <= 14) return 100;
  if (daysSinceDelivery <= RETURN_WINDOW_DAYS) return 75;
  return 0;
}

export function describePolicy() {
  return `Full refund for 14 days, then ${refundShare(RETURN_WINDOW_DAYS)}% until day ${RETURN_WINDOW_DAYS}.`;
}
