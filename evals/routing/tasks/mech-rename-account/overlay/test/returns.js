import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { balanceFor, clearLedger } from "../src/billing/ledger.js";
import { createOrder } from "../src/orders/create.js";
import { advanceStatus } from "../src/orders/status.js";
import { processReturn } from "../src/returns/refund.js";
import { addDays } from "../src/util/dates.js";
import { smallParcel } from "./helpers.js";

beforeEach(clearLedger);

function deliveredOrder(deliveredAt) {
  const order = createOrder({ accountId: "cust-1", parcels: [smallParcel()], postcode: "10115" });
  advanceStatus(order, "dispatched");
  advanceStatus(order, "delivered", deliveredAt);
  return order;
}

test("a return within the window posts a credit", () => {
  const deliveredAt = new Date("2026-03-01T10:00:00Z");
  const order = deliveredOrder(deliveredAt);
  const creditNote = processReturn(order, addDays(deliveredAt, 3));
  assert.equal(creditNote.cents, order.totalCents);
  assert.equal(balanceFor("cust-1"), -order.totalCents);
  assert.equal(order.status, "returned");
});

test("a return after the window is refused", () => {
  const deliveredAt = new Date("2026-03-01T10:00:00Z");
  const order = deliveredOrder(deliveredAt);
  assert.throws(() => processReturn(order, addDays(deliveredAt, 45)), /cannot be returned/);
});
