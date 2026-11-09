import { RETURN_WINDOW_DAYS } from "../config.js";
import { daysBetween } from "../util/dates.js";

export function isReturnable(order, at) {
  return (
    order.status === "delivered" &&
    daysBetween(order.deliveredAt, at) <= RETURN_WINDOW_DAYS
  );
}
