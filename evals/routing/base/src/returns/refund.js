import { issueCreditNote } from "../billing/credit.js";
import { advanceStatus } from "../orders/status.js";
import { daysBetween } from "../util/dates.js";
import { DepotError } from "../util/errors.js";
import { isReturnable } from "./eligibility.js";

export function processReturn(order, at = new Date()) {
  if (!isReturnable(order, at)) {
    throw new DepotError("not-returnable", `${order.id} cannot be returned`);
  }
  const creditNote = issueCreditNote(order, daysBetween(order.deliveredAt, at));
  advanceStatus(order, "returned", at);
  return creditNote;
}
