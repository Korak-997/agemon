import { postEntry } from "../billing/ledger.js";
import { advanceStatus } from "./status.js";

export function cancelOrder(order) {
  advanceStatus(order, "cancelled");
  postEntry(order.customerRef, -order.totalCents, `cancelled ${order.id}`);
  return order;
}
