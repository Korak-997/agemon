import { percentOf } from "../util/money.js";
import { postEntry } from "./ledger.js";

export function windowShare(daysSinceDelivery) {
  if (daysSinceDelivery <= 7) return 100;
  if (daysSinceDelivery <= 21) return 60;
  return 25;
}

export function issueCreditNote(order, daysSinceDelivery) {
  const share = windowShare(daysSinceDelivery);
  const cents = percentOf(order.totalCents, share);
  postEntry(order.customerRef, -cents, `return of ${order.id}`);
  return { orderId: order.id, customerRef: order.customerRef, share, cents };
}
