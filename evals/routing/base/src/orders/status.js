import { invalidTransition } from "../util/errors.js";

const NEXT_STATUSES = {
  created: ["dispatched", "cancelled"],
  dispatched: ["delivered", "lost"],
  delivered: ["returned"],
  returned: [],
  cancelled: [],
  lost: [],
};

export function advanceStatus(order, nextStatus, at = new Date()) {
  if (!NEXT_STATUSES[order.status].includes(nextStatus)) {
    throw invalidTransition(order.status, nextStatus);
  }
  order.status = nextStatus;
  if (nextStatus === "delivered") order.deliveredAt = at;
  return order;
}
